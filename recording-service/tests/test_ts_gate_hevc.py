"""GOP 闸门的 H.265 解析：切段/恢复点只认 IDR，跨 TS 包识别首个 VCL，参数集变化强制换文件。

设计：docs/h265-codec12-support-design-2026-09-29.md §7.2。合成 TS 精确控制 NAL 布局
（首个 VCL 落在第几个 TS 包、起始码是否跨包）；真实编码器端到端见 test_recording_pipeline.py。
"""
from recorder.ts_gate import GopGate, TimeMapper, TsParser

PMT_PID, VIDEO_PID, AUDIO_PID = 0x1000, 0x100, 0x101
FPS = 25
AUD, VPS, SPS, PPS, SEI = 35, 32, 33, 34, 39
IDR_W_RADL, IDR_N_LP, CRA, TRAIL_R = 19, 20, 21, 1


def _pkt(pid, payload=b"", pusi=False, rai=False):
    """一个 TS 包；载荷不足 184 字节时用 adaptation field 填充（不在载荷里塞 0xFF）。"""
    room = 184 - len(payload)
    if rai or room > 0:
        af_len = max(room - 1, 1 if rai else 0)
        af = bytes([af_len]) + (bytes([0x40 if rai else 0x00]) + b"\xff" * (af_len - 1) if af_len else b"")
        header = bytes([0x47, (0x40 if pusi else 0) | (pid >> 8), pid & 0xFF, 0x30])
        data = header + af + payload
    else:
        data = bytes([0x47, (0x40 if pusi else 0) | (pid >> 8), pid & 0xFF, 0x10]) + payload
    assert len(data) == 188, len(data)
    return data


def _pat():
    sec = bytes([0x00, 0xB0, 13, 0, 1, 0xC1, 0, 0, 0, 1, 0xE0 | (PMT_PID >> 8), PMT_PID & 0xFF]) + b"\0\0\0\0"
    return _pkt(0, b"\x00" + sec, pusi=True)


def _pmt(video_type=0x24):
    es = bytes([video_type, 0xE0 | (VIDEO_PID >> 8), VIDEO_PID & 0xFF, 0xF0, 0,
                0x0F, 0xE0 | (AUDIO_PID >> 8), AUDIO_PID & 0xFF, 0xF0, 0])
    length = 9 + len(es) + 4
    sec = bytes([0x02, 0xB0, length, 0, 1, 0xC1, 0, 0, 0xE0 | (VIDEO_PID >> 8), VIDEO_PID & 0xFF,
                 0xF0, 0]) + es + b"\0\0\0\0"
    return _pkt(PMT_PID, b"\x00" + sec, pusi=True)


def _pts_bytes(pts):
    return bytes([0x21 | ((pts >> 29) & 0x0E), (pts >> 22) & 0xFF, 0x01 | ((pts >> 14) & 0xFE),
                  (pts >> 7) & 0xFF, 0x01 | ((pts << 1) & 0xFE)])


def _nal(ntype, size, fill=0x55):
    return b"\x00\x00\x00\x01" + bytes([ntype << 1, 1]) + bytes([fill]) * size


def _au(vcl, sei=40, sps_fill=0x55, params=True):
    out = _nal(AUD, 1)
    if params:
        out += _nal(VPS, 20) + _nal(SPS, 30, sps_fill) + _nal(PPS, 6)
    return out + _nal(SEI, sei) + _nal(vcl, 300)


def _frame(pts, au, rai):
    """一帧 = 一个视频 PES（跨多个 TS 包）+ 一个音频包。"""
    pes = b"\x00\x00\x01\xE0\x00\x00\x80\x80\x05" + _pts_bytes(pts % (1 << 33)) + au
    first = 184 - 2 if rai else 184  # rai 包带 2 字节 adaptation field
    chunks = [pes[:first]] + [pes[i:i + 184] for i in range(first, len(pes), 184)]
    out = _pkt(VIDEO_PID, chunks[0], pusi=True, rai=rai)
    out += b"".join(_pkt(VIDEO_PID, c) for c in chunks[1:])
    return out + _pkt(AUDIO_PID, b"\x00\x00\x01\xC0", pusi=True)


def _feed_all(parser, data, size=None):
    blocks, starts = b"", []
    pieces = [data] if size is None else [data[i:i + size] for i in range(0, len(data), size)]
    for piece in pieces:
        block, found = parser.feed(piece)
        starts += [(len(blocks) + s.offset, s) for s in found]
        blocks += block
    block, found = parser.flush()
    starts += [(len(blocks) + s.offset, s) for s in found]
    return blocks + block, [s for _, s in starts]


def test_idr_found_even_when_first_vcl_sits_several_packets_later():
    data = _pat() + _pmt() + _frame(90000, _au(IDR_W_RADL, sei=500), rai=True) \
        + _frame(93600, _au(TRAIL_R, params=False), rai=False)
    parser = TsParser()
    blocks, starts = _feed_all(parser, data)
    assert parser.video_codec == "h265"
    assert [s.key for s in starts] == [True, False]
    assert blocks == data  # 一个字节都不丢


def test_cra_with_random_access_flag_is_not_a_cut_point_and_is_counted():
    data = _pat() + _pmt() + _frame(90000, _au(IDR_N_LP), rai=True) \
        + _frame(93600, _au(CRA), rai=True) + _frame(97200, _au(TRAIL_R, params=False), rai=False)
    parser = TsParser()
    _, starts = _feed_all(parser, data)
    assert [s.key for s in starts] == [True, False, False]
    assert parser.open_gop_aus == 1


def test_start_code_split_across_ts_packets_still_classified():
    # SEI 长度扫过一整个包长，保证 VCL 起始码落在包边界的每一种切法上
    for sei in range(300, 300 + 188):
        data = _pat() + _pmt() + _frame(90000, _au(IDR_W_RADL, sei=sei), rai=False) \
            + _frame(93600, _au(TRAIL_R, params=False), rai=False)
        parser = TsParser()
        _, starts = _feed_all(parser, data)
        assert [s.key for s in starts] == [True, False], sei


def test_tiny_chunks_hold_back_until_classified_and_lose_nothing():
    frames = b"".join(_frame(90000 + i * 3600, _au(IDR_W_RADL if i % 10 == 0 else TRAIL_R,
                                                   sei=400, params=i % 10 == 0), rai=i % 10 == 0)
                      for i in range(30))
    data = _pat() + _pmt() + frames
    parser = TsParser()
    blocks, starts = _feed_all(parser, data, size=50)
    assert blocks == data
    assert [s.key for s in starts] == [i % 10 == 0 for i in range(30)]
    assert [s.pts for s in starts] == [90000 + i * 3600 for i in range(30)]


def test_pes_without_vcl_beyond_cap_is_unknown_not_key_and_lossless():
    big = _nal(AUD, 1) + _nal(SEI, 70 * 1024)  # 超过 64KiB 仍未见 VCL
    data = _pat() + _pmt() + _frame(90000, big, rai=True) + _frame(93600, _au(IDR_W_RADL), rai=True)
    parser = TsParser()
    blocks, starts = _feed_all(parser, data, size=4096)
    assert blocks == data
    assert [s.key for s in starts] == [False, True]
    assert parser.unknown_aus == 1


def test_parameter_set_change_is_flagged_on_the_next_idr():
    data = _pat() + _pmt() + _frame(90000, _au(IDR_W_RADL), rai=True) \
        + _frame(93600, _au(IDR_W_RADL), rai=True) \
        + _frame(97200, _au(IDR_W_RADL, sps_fill=0x66), rai=True)
    parser = TsParser()
    _, starts = _feed_all(parser, data)
    assert [s.params_changed for s in starts] == [False, False, True]


def test_duplicate_or_reordered_parameters_do_not_force_short_segments():
    params = _nal(VPS, 20) + _nal(SPS, 30) + _nal(PPS, 6)
    reordered = _nal(PPS, 6) + _nal(VPS, 20) + _nal(SPS, 30)
    aus = [params * 3, params * 2, reordered, _nal(VPS, 20) +
           _nal(SPS, 30, 0x66) + _nal(PPS, 6)]
    data = _pat() + _pmt() + b''.join(
        _frame(90000 + i * 90000, au + _nal(IDR_N_LP, 300), rai=True)
        for i, au in enumerate(aus))
    parser = TsParser()
    blocks, starts = _feed_all(parser, data, size=97)
    assert blocks == data
    assert [s.key for s in starts] == [True] * 4
    assert [s.params_changed for s in starts] == [False, False, False, True]


def test_h264_rai_without_decoder_headers_is_not_a_safe_cut():
    # H.264 RAI without SPS/PPS must not start a new file.
    data = _pat() + _pmt(video_type=0x1B) + _frame(90000, b"\x00\x00\x00\x01\x65" + b"\x55" * 300, rai=True) \
        + _frame(93600, b"\x00\x00\x00\x01\x41" + b"\x55" * 300, rai=False)
    parser = TsParser()
    blocks, starts = _feed_all(parser, data)
    assert parser.video_codec == "h264" and blocks == data
    assert [s.key for s in starts] == [False, False]


def _gate_run(frames_spec, segment_seconds=60):
    """frames_spec: [(pts_sec, vcl_type, sps_fill)] → (gate, 新文件起点 PTS 列表)。"""
    data = _pat() + _pmt()
    for pts_sec, vcl, fill in frames_spec:
        irap = vcl in (IDR_W_RADL, IDR_N_LP, CRA)
        data += _frame(int(pts_sec * 90000), _au(vcl, sps_fill=fill, params=irap), rai=irap)
    parser, mapper = TsParser(), TimeMapper()
    gate = GopGate(segment_seconds, soft_cap=64 << 20, hard_cap=96 << 20)
    block, starts = parser.feed(data)
    tail, more = parser.flush()
    for s in starts + more:
        mapper.observe(mapper.unwrap(s.pts), 1000.0 + s.pts / 90000)
    gate.push(block, starts, mapper)
    gate.push(tail, more, mapper)
    gate.finish(mapper)
    new_files = []
    while (c := gate.pop()) is not None:
        if c.new_file:
            new_files.append(c.file_pts)
    return gate, new_files


def test_gate_forces_new_file_when_parameter_sets_change_at_idr():
    spec = [(1 + i * 0.04, IDR_W_RADL if i % 25 == 0 else TRAIL_R, 0x66 if i >= 50 else 0x55)
            for i in range(100)]
    _, new_files = _gate_run(spec, segment_seconds=60)
    assert new_files == [1.0, 3.0]  # 首文件 + 参数集变化后的第一个 IDR（未到分段时长）


def test_gate_open_gop_only_rotates_on_idr():
    spec = [(1 + i * 0.04, IDR_W_RADL if i == 0 else (CRA if i % 25 == 0 else TRAIL_R), 0x55)
            for i in range(150)]
    _, new_files = _gate_run(spec, segment_seconds=2)
    assert new_files == [1.0]  # CRA 不作切点：只有开头的 IDR


def test_gate_reports_seconds_since_last_idr():
    spec = [(1 + i * 0.04, IDR_W_RADL if i == 0 else TRAIL_R, 0x55) for i in range(300)]
    gate, _ = _gate_run(spec)
    assert 11.9 <= gate.seconds_since_key() <= 12.0


def test_avc_headers_idr_and_parameter_change_across_chunks():
    def avc(fill, typ=5, headers=True):
        return ((b"\0\0\1\x67" + bytes([fill, 128]) + b"\0\0\1\x68\xce\x80") if headers else b"") + b"\0\0\1" + bytes([typ, 128])
    data = _pat()+_pmt(0x1B)+_frame(90000,avc(66),True)+_frame(93600,avc(66,1,False),False)+_frame(97200,avc(77),True)
    p=TsParser(); blocks, starts=_feed_all(p,data,73)
    assert blocks==data
    assert [x.key for x in starts]==[True,False,True]
    assert [x.params_changed for x in starts]==[False,False,True]


def test_avc_false_rai_and_missing_pps_rejected():
    data=_pat()+_pmt(0x1B)+_frame(90000,b"\0\0\1\x67\x42\x80\0\0\1\x65\x80",True)+_frame(93600,b"\0\0\1\x41\x80",True)
    _,starts=_feed_all(TsParser(),data,71)
    assert not any(x.key for x in starts)
