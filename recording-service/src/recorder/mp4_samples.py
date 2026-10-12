"""只读 MP4 元数据盒子取视频轨每个样本的位置/大小/时间，不读媒体数据。

为什么不用 ffprobe：`ffprobe -show_entries packet=pos,size` 为了列出包会把整个视频读一遍
（2026-10-01 实测：160MB 的 AI 录像读了 159MB、7.6s），在 NAS 上就是白白占掉相机的带宽。
录像是分片 MP4（frag_keyframe+empty_moov+default_base_moof）：moov 里是编码参数，每个分片
是 moof（该分片每帧的时长/大小/偏移）+ mdat（媒体数据）。moof 只占文件的 0.003%（8K 实录
229MB 的片段里一共 6880 字节），所以只读盒子头和 moov/moof，遇到 mdat 直接 seek 跳过。

支持：moov 里的视频轨（avc1/avc3/hvc1/hev1 + avcC/hvcC）、mvex/trex 默认值、moof/traf 的
tfhd/tfdt/trun（含 data_offset、每样本 duration/size/flags/composition offset，version 0/1）、
default-base-is-moof / base-data-offset。不支持非分片 MP4（stbl 样本表）——抛 Mp4Error，
调用方应当明确失败/退回，不能静默当成"没有识别信息"。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass


class Mp4Error(ValueError):
    pass


@dataclass
class VideoInfo:
    codec: str          # 'h264' / 'hevc'
    length_size: int    # NAL 长度前缀字节数（1/2/4）


@dataclass
class Sample:
    pts: float          # 秒（已含 composition offset）
    duration: float
    pos: int            # 文件内的字节偏移
    size: int


_MAX_META_BOX = 64 * 1024 * 1024   # moov/moof 再大就不是正常文件


def _read_exact(f, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise Mp4Error('truncated')
    return data


def _iter_boxes(buf: bytes, start: int = 0, end: int | None = None):
    """遍历内存里的一段盒子：yield (类型, 内容起点, 内容终点, 盒子起点)。"""
    end = len(buf) if end is None else end
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack_from('>I4s', buf, pos)
        hdr = 8
        if size == 1:
            if pos + 16 > end:
                raise Mp4Error('truncated box header')
            size = struct.unpack_from('>Q', buf, pos + 8)[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr or pos + size > end:
            raise Mp4Error('invalid box size')
        yield typ, pos + hdr, pos + size, pos
        pos += size


def _find(buf: bytes, start: int, end: int, typ: bytes):
    for t, a, b, p in _iter_boxes(buf, start, end):
        if t == typ:
            return a, b, p
    return None


def _parse_moov(moov: bytes):
    """返回 (video_track_id, timescale, VideoInfo, trex 默认值 {track_id: (dur, size)})。"""
    top = _find(moov, 0, len(moov), b'moov')
    if top is None:
        raise Mp4Error('no moov')
    ms, me, _ = top
    video = None
    trex: dict[int, tuple[int, int]] = {}
    for t, a, b, _ in _iter_boxes(moov, ms, me):
        if t == b'mvex':
            for t2, a2, b2, _ in _iter_boxes(moov, a, b):
                if t2 == b'trex' and b2 - a2 >= 24:
                    track_id, _desc, dur, size, _flags = struct.unpack_from('>5I', moov, a2 + 4)
                    trex[track_id] = (dur, size)
        elif t == b'trak' and video is None:
            tkhd = _find(moov, a, b, b'tkhd')
            mdia = _find(moov, a, b, b'mdia')
            if tkhd is None or mdia is None:
                continue
            hdlr = _find(moov, mdia[0], mdia[1], b'hdlr')
            if hdlr is None or moov[hdlr[0] + 8:hdlr[0] + 12] != b'vide':
                continue
            version = moov[tkhd[0]]
            track_id = struct.unpack_from('>I', moov, tkhd[0] + (20 if version == 1 else 12))[0]
            mdhd = _find(moov, mdia[0], mdia[1], b'mdhd')
            if mdhd is None:
                raise Mp4Error('no mdhd')
            mver = moov[mdhd[0]]
            timescale = struct.unpack_from('>I', moov, mdhd[0] + (20 if mver == 1 else 12))[0]
            if timescale <= 0:
                raise Mp4Error('bad timescale')
            minf = _find(moov, mdia[0], mdia[1], b'minf')
            stbl = _find(moov, minf[0], minf[1], b'stbl') if minf else None
            stsd = _find(moov, stbl[0], stbl[1], b'stsd') if stbl else None
            if stsd is None:
                raise Mp4Error('no stsd')
            entry = _find(moov, stsd[0] + 8, stsd[1], b'avc1') or _find(moov, stsd[0] + 8, stsd[1], b'avc3') \
                or _find(moov, stsd[0] + 8, stsd[1], b'hvc1') or _find(moov, stsd[0] + 8, stsd[1], b'hev1')
            if entry is None:
                raise Mp4Error('unsupported video sample entry')
            # VisualSampleEntry：6 保留 + 2 索引 + 70 字节固定字段，之后才是子盒子
            sub_start = entry[0] + 78
            avcc = _find(moov, sub_start, entry[1], b'avcC')
            hvcc = _find(moov, sub_start, entry[1], b'hvcC')
            if avcc is not None:
                video = (track_id, timescale, VideoInfo('h264', (moov[avcc[0] + 4] & 3) + 1))
            elif hvcc is not None:
                video = (track_id, timescale, VideoInfo('hevc', (moov[hvcc[0] + 21] & 3) + 1))
            else:
                raise Mp4Error('no avcC/hvcC')
    if video is None:
        raise Mp4Error('no video track')
    return video[0], video[1], video[2], trex


def _parse_moof(buf: bytes, moof_pos: int, track_id: int, timescale: int, trex, next_decode: dict):
    """解析一个 moof（buf 是 moof 整盒内容，moof_pos 是它在文件里的起点）→ 该分片视频轨样本列表。"""
    out: list[Sample] = []
    top = _find(buf, 0, len(buf), b'moof')
    if top is None:
        raise Mp4Error('bad moof')
    for t, a, b, _ in _iter_boxes(buf, top[0], top[1]):
        if t != b'traf':
            continue
        tfhd = _find(buf, a, b, b'tfhd')
        if tfhd is None:
            raise Mp4Error('traf without tfhd')
        flags = struct.unpack_from('>I', buf, tfhd[0])[0] & 0xFFFFFF
        tid = struct.unpack_from('>I', buf, tfhd[0] + 4)[0]
        if tid != track_id:
            continue
        p = tfhd[0] + 8
        base = None
        if flags & 0x1:
            base = struct.unpack_from('>Q', buf, p)[0]; p += 8
        if flags & 0x2:
            p += 4
        d_dur, d_size = trex.get(track_id, (0, 0))
        if flags & 0x8:
            d_dur = struct.unpack_from('>I', buf, p)[0]; p += 4
        if flags & 0x10:
            d_size = struct.unpack_from('>I', buf, p)[0]; p += 4
        if base is None:
            base = moof_pos          # default-base-is-moof（0x20000）以及绝大多数写法：相对 moof 起点
        tfdt = _find(buf, a, b, b'tfdt')
        if tfdt is not None:
            ver = buf[tfdt[0]]
            decode = struct.unpack_from('>Q', buf, tfdt[0] + 4)[0] if ver == 1 else struct.unpack_from('>I', buf, tfdt[0] + 4)[0]
        else:
            decode = next_decode.get(track_id, 0)
        for t2, a2, b2, _ in _iter_boxes(buf, a, b):
            if t2 != b'trun':
                continue
            ver = buf[a2]
            tflags = struct.unpack_from('>I', buf, a2)[0] & 0xFFFFFF
            count = struct.unpack_from('>I', buf, a2 + 4)[0]
            q = a2 + 8
            data_offset = 0
            if tflags & 0x1:
                data_offset = struct.unpack_from('>i', buf, q)[0]; q += 4
            if tflags & 0x4:
                q += 4
            pos = base + data_offset
            for _i in range(count):
                dur = d_dur; size = d_size; cto = 0
                if tflags & 0x100:
                    dur = struct.unpack_from('>I', buf, q)[0]; q += 4
                if tflags & 0x200:
                    size = struct.unpack_from('>I', buf, q)[0]; q += 4
                if tflags & 0x400:
                    q += 4
                if tflags & 0x800:
                    cto = struct.unpack_from('>i' if ver == 1 else '>I', buf, q)[0]; q += 4
                out.append(Sample((decode + cto) / timescale, dur / timescale, pos, size))
                pos += size
                decode += dur
        next_decode[track_id] = decode
    return out


def read_video_samples(path: str):
    """返回 (VideoInfo, [Sample])。只读 ftyp/moov/moof 盒子，跳过 mdat。损坏/截断/不支持 → Mp4Error。"""
    try:
        # buffering=0：带缓冲的文件对象每次 seek+read 都会预读一整块；盒子之间隔着几百 KB 的媒体数据，
        # 累计起来几乎把整个文件读完（8K 实录 723MB 的一段：默认缓冲读 658MB，无缓冲只读 60MB）。
        f = open(path, 'rb', buffering=0)
    except OSError as e:
        raise Mp4Error(f'open failed: {e}') from e
    with f:
        f.seek(0, 2)
        file_size = f.tell()
        f.seek(0)
        moov_buf = None
        video = None
        samples: list[Sample] = []
        seen_moof = False
        next_decode: dict[int, int] = {}
        pos = 0
        while pos + 8 <= file_size:
            f.seek(pos)
            hdr = _read_exact(f, 8)
            size, typ = struct.unpack('>I4s', hdr)
            head = 8
            if size == 1:
                size = struct.unpack('>Q', _read_exact(f, 8))[0]
                head = 16
            elif size == 0:
                size = file_size - pos
            if size < head:
                raise Mp4Error('invalid box size')
            if typ in (b'moov', b'moof'):
                if size > _MAX_META_BOX or pos + size > file_size:
                    raise Mp4Error('truncated or oversized metadata box')
                f.seek(pos)
                body = _read_exact(f, size)
                if typ == b'moov':
                    moov_buf = body
                    video = _parse_moov(moov_buf)
                else:
                    seen_moof = True
                    if video is None:
                        raise Mp4Error('moof before moov')
                    track_id, timescale, _info, trex = video
                    samples.extend(_parse_moof(body, pos, track_id, timescale, trex, next_decode))
            # 其余（ftyp/mdat/mfra/free…）一律跳过，不读内容
            pos += size
        if video is None:
            raise Mp4Error('no moov')
        if not seen_moof:
            raise Mp4Error('no fragments: non-fragmented or initialization-only MP4')
        # 最后一个分片被截断（录像进行中/掉电）：丢掉指到文件外的样本，绝不报告文件里没有的数据
        samples = [s for s in samples if s.pos >= 0 and s.size >= 0 and s.pos + s.size <= file_size]
        if not samples or not any(s.size > 0 for s in samples):
            raise Mp4Error('no complete video samples')
        return video[2], samples
