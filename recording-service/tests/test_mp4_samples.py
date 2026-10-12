"""只读 MP4 的元数据盒子取每帧位置，不把整个文件读回来。

背景(2026-10-01)：AI 录像的识别信息索引原来用 `ffprobe -show_entries packet=pos,size` 取每帧位置，
而 ffprobe 为了列出包会把整个视频读一遍——160MB 的一段读了 159MB（耗时 7.6s）。分片 MP4
(frag_keyframe+empty_moov+default_base_moof) 里每帧的位置/大小/时间都在 moof 盒子里，而 moof
只占文件的 0.003%（8K 实录 229MB 的片段里 moof 一共 6880 字节）；遇到 mdat 直接 seek 跳过即可。
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess

import pytest

from recorder import mp4_samples
from recorder.mp4_samples import Mp4Error, read_video_samples


# ---- 合成最小分片 MP4 ----

def box(typ: bytes, payload: bytes) -> bytes:
    return struct.pack('>I4s', 8 + len(payload), typ) + payload


def full(typ: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return box(typ, struct.pack('>I', (version << 24) | flags) + payload)


def moov(timescale=90000, codec=b'hvc1', length_size=4, track_id=1, with_audio=False, trex_dur=0, trex_size=0):
    cfg = bytearray(23)
    cfg[0] = 1
    if codec == b'avc1':
        cfg = bytearray(7); cfg[0] = 1; cfg[4] = 0xFC | (length_size - 1)
        config_box = box(b'avcC', bytes(cfg))
    else:
        cfg[21] = 0xFC | (length_size - 1)
        config_box = box(b'hvcC', bytes(cfg))
    visual = bytes(78) + config_box           # VisualSampleEntry 固定 78 字节 + 配置盒子
    stsd = full(b'stsd', 0, 0, struct.pack('>I', 1) + box(codec, visual))
    stbl = box(b'stbl', stsd)
    hdlr = full(b'hdlr', 0, 0, struct.pack('>I4s', 0, b'vide') + bytes(12) + b'v\x00')
    mdhd = full(b'mdhd', 0, 0, struct.pack('>IIII', 0, 0, timescale, 0) + bytes(4))
    mdia = box(b'mdia', mdhd + hdlr + box(b'minf', stbl))
    tkhd = full(b'tkhd', 0, 7, struct.pack('>III', 0, 0, track_id) + bytes(68))
    traks = box(b'trak', tkhd + mdia)
    trex = full(b'trex', 0, 0, struct.pack('>IIIII', track_id, 1, trex_dur, trex_size, 0))
    if with_audio:
        a_stsd = full(b'stsd', 0, 0, struct.pack('>I', 1) + box(b'mp4a', bytes(28)))
        a_hdlr = full(b'hdlr', 0, 0, struct.pack('>I4s', 0, b'soun') + bytes(12) + b's\x00')
        a_mdhd = full(b'mdhd', 0, 0, struct.pack('>IIII', 0, 0, 48000, 0) + bytes(4))
        a_mdia = box(b'mdia', a_mdhd + a_hdlr + box(b'minf', box(b'stbl', a_stsd)))
        a_tkhd = full(b'tkhd', 0, 7, struct.pack('>III', 0, 0, 2) + bytes(68))
        traks += box(b'trak', a_tkhd + a_mdia)
        trex += full(b'trex', 0, 0, struct.pack('>IIIII', 2, 1, 1024, 0, 0))
    mvhd = full(b'mvhd', 0, 0, struct.pack('>IIII', 0, 0, 1000, 0) + bytes(80))
    return box(b'moov', mvhd + traks + box(b'mvex', trex))


def traf(track_id, decode_time, samples, *, default_base_moof=True, explicit_dur=True, with_cto=False, version1_cto=False):
    """samples: [(duration, size, cto)]"""
    tf_flags = 0x020000 if default_base_moof else 0
    tfhd = full(b'tfhd', 0, tf_flags, struct.pack('>I', track_id))
    tfdt = full(b'tfdt', 1, 0, struct.pack('>Q', decode_time))
    flags = 0x000001 | 0x000200 | (0x000100 if explicit_dur else 0) | (0x000800 if with_cto else 0)
    body = struct.pack('>I', len(samples)) + struct.pack('>i', 0)       # sample_count + data_offset(占位，稍后回填)
    for dur, size, cto in samples:
        body += (struct.pack('>I', dur) if explicit_dur else b'') + struct.pack('>I', size)
        if with_cto:
            body += struct.pack('>i' if version1_cto else '>I', cto)
    trun = full(b'trun', 1 if version1_cto else 0, flags, body)
    return box(b'traf', tfhd + tfdt + trun)


def fragment(trafs, payload_sizes):
    """trafs: [(traf_bytes)]，payload_sizes: 各 traf 对应 mdat 里的字节数（按顺序紧挨着放）。"""
    mfhd = full(b'mfhd', 0, 0, struct.pack('>I', 1))
    moof_len = 8 + len(mfhd) + sum(len(t) for t in trafs)
    # 回填每个 trun 的 data_offset（相对 moof 起点）：mdat 头 8 字节之后依次排列
    out = []
    offset = moof_len + 8
    for t, n in zip(trafs, payload_sizes):
        idx = t.index(b'trun') + 4 + 4 + 4            # trun 类型 + version/flags + sample_count 之后就是 data_offset
        t = t[:idx] + struct.pack('>i', offset) + t[idx + 4:]
        out.append(t)
        offset += n
    moof = box(b'moof', mfhd + b''.join(out))
    assert len(moof) == moof_len
    mdat = box(b'mdat', b'\xAA' * sum(payload_sizes))
    return moof + mdat


def build(path, *, fragments, **moov_kw):
    data = box(b'ftyp', b'iso5\x00\x00\x02\x00iso5iso6mp41') + moov(**moov_kw) + b''.join(fragments)
    path.write_bytes(data)
    return data


def test_positions_sizes_and_times_come_from_the_fragment_boxes(tmp_path):
    frag1 = fragment([traf(1, 0, [(3000, 500, 0), (3000, 120, 0), (3000, 130, 0)])], [750])
    frag2 = fragment([traf(1, 9000, [(3000, 400, 0), (3000, 90, 0)])], [490])
    p = tmp_path / 'a.mp4'
    data = build(p, fragments=[frag1, frag2])
    info, samples = read_video_samples(str(p))
    assert info.codec == 'hevc' and info.length_size == 4
    assert [s.size for s in samples] == [500, 120, 130, 400, 90]
    assert [round(s.pts, 6) for s in samples] == [0.0, round(3000 / 90000, 6), round(6000 / 90000, 6), round(9000 / 90000, 6), round(12000 / 90000, 6)]
    assert all(abs(s.duration - 3000 / 90000) < 1e-9 for s in samples)
    # 位置逐个对得上：第一个样本从第一个 mdat 数据区开始，后面紧挨着
    first_mdat = data.index(b'mdat') + 4
    assert samples[0].pos == first_mdat
    assert samples[1].pos == first_mdat + 500 and samples[2].pos == first_mdat + 620
    second_mdat = data.index(b'mdat', first_mdat) + 4
    assert samples[3].pos == second_mdat
    for s in samples:
        assert data[s.pos:s.pos + s.size] == b'\xAA' * s.size       # 指到的确实是那块数据


def test_avc_codec_and_nal_length_size_are_read_from_the_sample_entry(tmp_path):
    p = tmp_path / 'a.mp4'
    build(p, fragments=[fragment([traf(1, 0, [(3000, 50, 0)])], [50])], codec=b'avc1', length_size=2)
    info, _ = read_video_samples(str(p))
    assert info.codec == 'h264' and info.length_size == 2


def test_composition_offsets_shift_pts_not_decode_order(tmp_path):
    p = tmp_path / 'a.mp4'
    build(p, fragments=[fragment([traf(1, 0, [(3000, 10, 6000), (3000, 10, 0), (3000, 10, 3000)], with_cto=True, version1_cto=True)], [30])])
    _, samples = read_video_samples(str(p))
    assert [round(s.pts * 90000) for s in samples] == [6000, 3000, 9000]    # dts 0/3000/6000 + cto


def test_audio_track_in_the_same_fragment_is_ignored(tmp_path):
    p = tmp_path / 'a.mp4'
    v = traf(1, 0, [(3000, 100, 0), (3000, 80, 0)])
    a = traf(2, 0, [(1024, 33, 0), (1024, 34, 0), (1024, 35, 0)])
    build(p, fragments=[fragment([v, a], [180, 102])], with_audio=True)
    _, samples = read_video_samples(str(p))
    assert [s.size for s in samples] == [100, 80]


def test_defaults_from_trex_when_the_trun_omits_per_sample_fields(tmp_path):
    p = tmp_path / 'a.mp4'
    # trun 不写每个样本的 duration，用 moov/mvex/trex 的默认值
    build(p, fragments=[fragment([traf(1, 0, [(0, 70, 0), (0, 70, 0)], explicit_dur=False)], [140])], trex_dur=3600)
    _, samples = read_video_samples(str(p))
    assert [round(s.duration * 90000) for s in samples] == [3600, 3600]


def test_it_never_reads_the_media_payload(tmp_path, monkeypatch):
    """核心要求：读取量只和元数据盒子成正比，和视频数据量无关。"""
    big = 5_000_000
    frag = lambda t: fragment([traf(1, t, [(3000, big, 0), (3000, big, 0)])], [2 * big])
    p = tmp_path / 'a.mp4'
    build(p, fragments=[frag(0), frag(6000), frag(12000)])
    total = p.stat().st_size
    read_bytes = [0]
    real_open = open

    class Counting:
        def __init__(self, f): self.f = f
        def __enter__(self): return self
        def __exit__(self, *a): self.f.close()
        def seek(self, *a): return self.f.seek(*a)
        def tell(self): return self.f.tell()
        def read(self, n=-1):
            d = self.f.read(n); read_bytes[0] += len(d); return d
    monkeypatch.setattr(mp4_samples, 'open', lambda *a, **k: Counting(real_open(*a, **k)), raising=False)
    _, samples = read_video_samples(str(p))
    assert len(samples) == 6
    assert read_bytes[0] < 8192, f'读了 {read_bytes[0]} 字节，文件 {total} 字节'


@pytest.mark.parametrize('mutate', [
    lambda d: d[:40],                                   # 截断在 moov 里
    lambda d: d[:d.index(b'moov') + 40],                # 截在 moov 盒子内部（盒子声明的长度超出文件）
    lambda d: b'\x00' * 64,
    lambda d: d.replace(b'moov', b'zzzz', 1),           # 没有 moov
])
def test_corrupt_or_truncated_files_raise_instead_of_returning_garbage(tmp_path, mutate):
    p = tmp_path / 'a.mp4'
    data = build(p, fragments=[fragment([traf(1, 0, [(3000, 50, 0)])], [50])])
    p.write_bytes(mutate(data))
    with pytest.raises(Mp4Error):
        read_video_samples(str(p))


def test_a_truncated_last_fragment_does_not_report_samples_that_are_not_in_the_file(tmp_path):
    p = tmp_path / 'a.mp4'
    data = build(p, fragments=[fragment([traf(1, 0, [(3000, 500, 0), (3000, 500, 0)])], [1000])])
    p.write_bytes(data[:-300])                          # 录像进行中/掉电：最后一个 mdat 不完整
    _, samples = read_video_samples(str(p))
    assert len(samples) == 0 or all(s.pos + s.size <= p.stat().st_size for s in samples)


# ---- 与 ffprobe 对拍（有 ffmpeg 才跑）：同一个真实分片 MP4，逐包比对位置/大小/时间 ----

def test_initialization_only_file_is_not_an_empty_success(tmp_path):
    p = tmp_path / 'init.mp4'
    build(p, fragments=[])
    with pytest.raises(Mp4Error, match='no fragments'):
        read_video_samples(str(p))


def test_non_fragmented_media_is_not_an_empty_success(tmp_path):
    p = tmp_path / 'ordinary.mp4'
    build(p, fragments=[box(b'mdat', b'\xAA' * 1000)])
    with pytest.raises(Mp4Error, match='no fragments'):
        read_video_samples(str(p))


def test_fragment_with_no_complete_video_sample_is_not_an_empty_success(tmp_path):
    p = tmp_path / 'truncated.mp4'
    data = build(p, fragments=[fragment([traf(1, 0, [(3000, 500, 0)])], [500])])
    p.write_bytes(data[:-500])
    with pytest.raises(Mp4Error, match='no complete video samples'):
        read_video_samples(str(p))

@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='需要 ffmpeg/ffprobe')
@pytest.mark.parametrize('vcodec', ['libx264', 'libx265'])
def test_matches_ffprobe_on_a_real_fragmented_mp4(tmp_path, vcodec):
    path = str(tmp_path / 'real.mp4')
    enc = ['-c:v', vcodec, '-preset', 'ultrafast', '-g', '15', '-bf', '0']
    if vcodec == 'libx265':
        enc += ['-x265-params', 'log-level=error', '-tag:v', 'hvc1']
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', *enc, '-c:a', 'aac',
                    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path], check=True)
    probe = json.loads(subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time,pos,size',
         '-of', 'json', path], capture_output=True, check=True).stdout)['packets']
    info, samples = read_video_samples(path)
    assert len(samples) == len(probe) > 100
    for i, (mine, ref) in enumerate(zip(samples, probe)):
        assert mine.pos == int(ref['pos']) and mine.size == int(ref['size'])
        assert abs(mine.pts - float(ref['pts_time'])) < 0.002
        # 第一个样本的时长是编码器起始偏移造成的特例：trun 里写的是实际时长，而 ffprobe 对 H.264
        # 不给、对 H.265 给的是按帧率推算的名义值。位置/大小/pts 都严格一致，其余样本的时长也严格对拍。
        if i > 0 and 'duration_time' in ref:
            assert abs(mine.duration - float(ref['duration_time'])) < 0.002
    assert info.codec == ('hevc' if vcodec == 'libx265' else 'h264')
