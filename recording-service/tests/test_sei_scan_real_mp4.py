"""识别信息扫描走真实 MP4：不起 ffprobe 子进程、读取量与视频大小无关、结果与旧实现一致。

上一轮的测试把 subprocess.run(ffprobe) 整个 mock 掉，只统计了 Python 自己的读取，
看不见 ffprobe 子进程把整个视频读了一遍（160MB 的一段读了 159MB）——这就是这里要补上的盲区。
"""
from __future__ import annotations

import json
import struct

import pytest

from recorder import mp4_samples, sei_worker
from recorder.sei_worker import UUID, scan


def box(typ, payload):
    return struct.pack('>I4s', 8 + len(payload), typ) + payload


def full(typ, version, flags, payload):
    return box(typ, struct.pack('>I', (version << 24) | flags) + payload)


def hevc_nal(nal_type, body):
    return bytes([nal_type << 1, 1]) + body


def sei(det):
    payload = UUID + json.dumps({'v': 1, 'det': det}).encode()
    return hevc_nal(39, b'\x05' + bytes([len(payload)]) + payload + b'\x80')


def au(*nals):
    return b''.join(len(n).to_bytes(4, 'big') + n for n in nals)


def build_hevc_fragmented(path, frames, timescale=90000, dur=3000):
    """frames: [bytes]（每帧一个 AU）。每帧一个分片，和 frag_keyframe 的写法同构。"""
    cfg = bytearray(23); cfg[0] = 1; cfg[21] = 0xFC | 3
    visual = bytes(78) + box(b'hvcC', bytes(cfg))
    stsd = full(b'stsd', 0, 0, struct.pack('>I', 1) + box(b'hvc1', visual))
    hdlr = full(b'hdlr', 0, 0, struct.pack('>I4s', 0, b'vide') + bytes(12) + b'v\x00')
    mdhd = full(b'mdhd', 0, 0, struct.pack('>IIII', 0, 0, timescale, 0) + bytes(4))
    mdia = box(b'mdia', mdhd + hdlr + box(b'minf', box(b'stbl', stsd)))
    tkhd = full(b'tkhd', 0, 7, struct.pack('>III', 0, 0, 1) + bytes(68))
    mvhd = full(b'mvhd', 0, 0, struct.pack('>IIII', 0, 0, 1000, 0) + bytes(80))
    trex = full(b'trex', 0, 0, struct.pack('>IIIII', 1, 1, dur, 0, 0))
    out = box(b'ftyp', b'iso5\x00\x00\x02\x00iso5mp41') + box(b'moov', mvhd + box(b'trak', tkhd + mdia) + box(b'mvex', trex))
    t = 0
    for fr in frames:
        tfhd = full(b'tfhd', 0, 0x020000, struct.pack('>I', 1))
        tfdt = full(b'tfdt', 1, 0, struct.pack('>Q', t))
        trun_body = struct.pack('>I', 1) + struct.pack('>i', 0) + struct.pack('>II', dur, len(fr))
        trun = full(b'trun', 0, 0x000001 | 0x000100 | 0x000200, trun_body)
        traf = box(b'traf', tfhd + tfdt + trun)
        mfhd = full(b'mfhd', 0, 0, struct.pack('>I', 1))
        moof_len = 8 + len(mfhd) + len(traf)
        trun_off = traf.index(b'trun') + 4 + 4 + 4
        traf = traf[:trun_off] + struct.pack('>i', moof_len + 8) + traf[trun_off + 4:]
        out += box(b'moof', mfhd + traf) + box(b'mdat', fr)
        t += dur
    path.write_bytes(out)
    return out


def test_scan_does_not_start_ffprobe_and_finds_sei_ranges(tmp_path, monkeypatch):
    assert not hasattr(sei_worker, 'subprocess'), '不应再启动 ffprobe（它会把整个视频读一遍）'
    big = hevc_nal(19, b'\xAA' * 200_000)
    plain = hevc_nal(1, b'\xBB' * 150_000)
    frames = [au(hevc_nal(32, b'\x01' * 20), sei([{'c': 0}]), big)] + [au(plain)] * 2 + [au(sei([{'c': 0}]), plain)] + [au(plain)]
    p = tmp_path / 'a.mp4'
    build_hevc_fragmented(p, frames)
    # 帧 0 与帧 3 带识别信息；每帧时长 3000/90000 秒 ≈ 33.333ms
    assert scan(str(p), 1000) == [[0, 34], [100, 134]]


def test_scan_reads_far_less_than_the_file_and_independent_of_video_size(tmp_path, monkeypatch):
    assert not hasattr(sei_worker, 'subprocess')
    counted = []
    real_open = open

    class Counting:
        def __init__(self, f): self.f = f; self.n = 0; counted.append(self)
        def __enter__(self): return self
        def __exit__(self, *a): self.f.close()
        def seek(self, *a): return self.f.seek(*a)
        def tell(self): return self.f.tell()
        def read(self, n=-1):
            d = self.f.read(n); self.n += len(d); return d
    wrapper = lambda *a, **k: Counting(real_open(*a, **k))
    monkeypatch.setattr(mp4_samples, 'open', wrapper, raising=False)
    monkeypatch.setattr(sei_worker, 'open', wrapper, raising=False)

    results = {}
    for label, payload in (('small', 20_000), ('large', 2_000_000)):
        counted.clear()
        frames = [au(sei([{'c': 0}]), hevc_nal(19, b'\xAA' * payload))] + [au(hevc_nal(1, b'\xBB' * payload))] * 5
        p = tmp_path / f'{label}.mp4'
        data = build_hevc_fragmented(p, frames)
        scan(str(p), 1000)
        results[label] = (sum(c.n for c in counted), len(data))
    small_read, small_size = results['small']
    large_read, large_size = results['large']
    assert large_size > 50 * small_size / 2                       # 数据量差了两个数量级
    assert large_read < 20_000, f'读了 {large_read} 字节（文件 {large_size} 字节）'
    assert large_read < small_read * 3                            # 读取量基本不随视频变大而增长


def test_unsupported_or_corrupt_file_is_an_error_not_an_empty_index(tmp_path):
    """读不了≠没有识别信息：索引器据此重试，而不是永久标成"没有"。"""
    p = tmp_path / 'junk.mp4'
    p.write_bytes(b'not an mp4 at all' * 10)
    with pytest.raises(Exception):
        scan(str(p), 1000)


def test_files_are_opened_unbuffered_so_python_does_not_read_ahead_across_the_video(tmp_path, monkeypatch):
    """Python 带缓冲的文件对象每次 seek+read 都会预读一整块；帧与帧之间隔着几百 KB 的画面数据，
    累计起来几乎把整个文件读完（8K 实录 723MB 的一段：默认缓冲读 658MB，无缓冲只读 60MB）。
    所以扫描用到的文件必须以 buffering=0 打开。"""
    modes = []
    real_open = open

    def spy(path, mode='r', buffering=-1, *a, **k):
        modes.append((mode, buffering))
        return real_open(path, mode, buffering, *a, **k)
    monkeypatch.setattr(mp4_samples, 'open', spy, raising=False)
    monkeypatch.setattr(sei_worker, 'open', spy, raising=False)
    frames = [au(sei([{'c': 0}]), hevc_nal(19, b'\xAA' * 50_000))] + [au(hevc_nal(1, b'\xBB' * 50_000))] * 3
    p = tmp_path / 'a.mp4'
    build_hevc_fragmented(p, frames)
    scan(str(p), 1000)
    assert modes, '扫描没有打开文件？'
    assert all(m[1] == 0 for m in modes), f'有文件是带缓冲打开的: {modes}'
