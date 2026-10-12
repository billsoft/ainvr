"""Read AINVR SEI from MP4 packet positions, without decoding or a new media stack.

Executed only in an isolated process group. Packet PTS (not embedded live-stream
PTS) supplies the playback-relative position. Unknown/error is not 'no SEI'.
"""
from __future__ import annotations
import json
import math
import sys

try:
    from . import mp4_samples
except ImportError:      # 作为脚本直接运行(python -m recorder.sei_worker 走包导入，这里只是兜底)
    import mp4_samples

UUID = b'AINVR-SEI-v1\x00\x00\x00\x01'


def read_ainvr_sei(nal: bytes, hevc: bool = False) -> dict | None:
    if not nal or ((nal[0] >> 1) & 63 if hevc else nal[0] & 31) not in ((39, 40) if hevc else (6,)):
        return None
    raw = nal[2 if hevc else 1:].replace(b'\x00\x00\x03', b'\x00\x00')
    pos = 0
    while pos + 2 <= len(raw):
        kind = size = 0
        while pos < len(raw) and raw[pos] == 255:
            kind += 255; pos += 1
        if pos >= len(raw): break
        kind += raw[pos]; pos += 1
        while pos < len(raw) and raw[pos] == 255:
            size += 255; pos += 1
        if pos >= len(raw): break
        size += raw[pos]; pos += 1
        payload = raw[pos:pos + size]; pos += size
        if len(payload) != size: break
        if kind == 5 and payload.startswith(UUID):
            try:
                data = json.loads(payload[len(UUID):])
                if data.get('v') == 1 and isinstance(data.get('det'), list):
                    return data
            except (ValueError, AttributeError, UnicodeError):
                pass
    return None


def has_ainvr_sei(nal: bytes, hevc: bool = False) -> bool:
    data = read_ainvr_sei(nal, hevc)
    return data is not None and bool(data['det'])


def packet_has_sei(packet: bytes, length_size: int, hevc: bool) -> bool:
    pos = 0
    while pos + length_size <= len(packet):
        length = int.from_bytes(packet[pos:pos + length_size], 'big'); pos += length_size
        if not length or pos + length > len(packet): return False
        if has_ainvr_sei(packet[pos:pos + length], hevc): return True
        pos += length
    return False


def packet_prefix_metadata(handle, pos: int, size: int, length_size: int, hevc: bool) -> dict | None:
    """只读画面数据之前的 NAL：识别信息（前缀 SEI）总在画面数据之前，遇到第一块
    画面数据就停，不把整帧读回（8K 下一帧可达数百 KB，整段回读会挤满网络）。"""
    end = pos + size
    while pos + length_size < end:
        handle.seek(pos)
        head = handle.read(length_size + 1)
        if len(head) != length_size + 1: raise ValueError('Truncated recording')
        length = int.from_bytes(head[:length_size], 'big')
        start = pos + length_size
        if not length or start + length > end: raise ValueError('Invalid NAL bounds')
        nal_type = (head[length_size] >> 1) & 63 if hevc else head[length_size] & 31
        if (nal_type < 32) if hevc else (1 <= nal_type <= 5): return None
        if nal_type in ((39, 40) if hevc else (6,)):
            if length > 256 * 1024: raise ValueError('SEI payload too large')
            nal = handle.read(length - 1)
            if len(nal) != length - 1: raise ValueError('Truncated recording')
            data = read_ainvr_sei(head[length_size:] + nal, hevc)
            if data is not None: return data
        pos = start + length
    return None


def packet_prefix_has_sei(handle, pos: int, size: int, length_size: int, hevc: bool) -> bool:
    data = packet_prefix_metadata(handle, pos, size, length_size, hevc)
    return data is not None and bool(data['det'])


def scan_frames(path: str, start_ms: int, end_ms: int) -> list[dict]:
    """Sparse reads for a playback window, including 300 ms of past context.

    Empty det is a real inference result and must clear boxes. Frames without
    metadata are omitted. Use MP4 presentation time, never the embedded live PTS.
    """
    if start_ms < 0 or not start_ms < end_ms <= start_ms + 10000:
        raise ValueError('Invalid playback window')
    info, samples = mp4_samples.read_video_samples(path)
    frames = []
    total = 0
    with open(path, 'rb', buffering=0) as handle:
        for sample in samples:
            ms = sample.pts * 1000
            if not max(0, start_ms - 300) <= ms < end_ms:
                continue
            if sample.size > 32 * 1024 * 1024 or sample.pos < 0:
                raise ValueError('Invalid packet bounds')
            data = packet_prefix_metadata(handle, sample.pos, sample.size,
                                          info.length_size, info.codec == 'hevc')
            if data is not None:
                total += len(json.dumps(data, ensure_ascii=True)) + 100
                if total > 2 * 1024 * 1024 or len(frames) >= 2400:
                    raise ValueError('Playback metadata window too large')
                frames.append({'timeMs': ms, 'payload': data})
    return sorted(frames, key=lambda f: f['timeMs'])


def scan(path: str, duration_ms: int) -> list[list[int]]:
    """逐帧只看"画面数据之前"的 NAL，找识别信息；返回合并后的 [start_ms, end_ms] 区间。

    每帧在文件里的位置/大小/时间来自 MP4 的 moof 盒子（recorder.mp4_samples），**不用 ffprobe**：
    ffprobe 为了列包会把整个视频读一遍（160MB 的一段读了 159MB），在 NAS 上白占相机的带宽。
    读不了（损坏/截断/不是分片 MP4）→ 抛异常，由索引器稍后重试；绝不当成"没有识别信息"。
    """
    info, samples = mp4_samples.read_video_samples(path)
    hevc = info.codec == 'hevc'
    ranges = []
    # 同上：无缓冲，不让 Python 在每帧之间预读
    with open(path, 'rb', buffering=0) as handle:
        for sample in samples:
            if sample.size > 32 * 1024 * 1024 or sample.pos < 0: raise ValueError('Invalid packet bounds')
            if packet_prefix_has_sei(handle, sample.pos, sample.size, info.length_size, hevc):
                # MP4 edit-list-adjusted PTS is the media element timeline;
                # subtracting video start_time would shift delayed video frames.
                start = max(0, round(sample.pts * 1000))
                end = min(duration_ms, math.ceil(start + sample.duration * 1000))
                if end > start: ranges.append([start, end])
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]: merged[-1][1] = max(end, merged[-1][1])
        else: merged.append([start, end])
    return merged


if __name__ == '__main__':
    if sys.argv[1] == '--frames':
        print(json.dumps(scan_frames(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))))
    else:
        print(json.dumps(scan(sys.argv[1], int(sys.argv[2]))))
