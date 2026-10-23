"""GOP 闸门纯逻辑：TS 解析出 I 帧边界/PTS，按完整 GOP 丢弃、换文件、计量丢弃。

合成 TS 流精确控制 I 帧位置与 PTS；真实编码器的端到端验证见 test_pipeline_media.py。
"""
from recorder.ts_gate import GopGate, TimeMapper, TsParser

PMT_PID, VIDEO_PID, AUDIO_PID = 0x1000, 0x100, 0x101
FPS = 25


def _pkt(pid, payload=b"", pusi=False, rai=False):
    body = b""
    afc = 1
    if rai:
        afc = 3
        body = bytes([1, 0x40])  # adaptation_field_length=1, RAI
    header = bytes([0x47, (0x40 if pusi else 0) | (pid >> 8), pid & 0xFF, (afc << 4)])
    data = header + body + payload
    return data + b"\xff" * (188 - len(data))


def _pat():
    sec = bytes([0x00, 0xB0, 13, 0, 1, 0xC1, 0, 0, 0, 1, 0xE0 | (PMT_PID >> 8), PMT_PID & 0xFF]) + b"\0\0\0\0"
    return _pkt(0, b"\x00" + sec, pusi=True)


def _pmt(video_type=0x1B, audio_type=0x0F):
    es = bytes([video_type, 0xE0 | (VIDEO_PID >> 8), VIDEO_PID & 0xFF, 0xF0, 0,
                audio_type, 0xE0 | (AUDIO_PID >> 8), AUDIO_PID & 0xFF, 0xF0, 0])
    length = 9 + len(es) + 4
    sec = bytes([0x02, 0xB0, length, 0, 1, 0xC1, 0, 0, 0xE0 | (VIDEO_PID >> 8), VIDEO_PID & 0xFF, 0xF0, 0]) + es + b"\0\0\0\0"
    return _pkt(PMT_PID, b"\x00" + sec, pusi=True)


def _pts_bytes(pts):
    return bytes([0x21 | ((pts >> 29) & 0x0E), (pts >> 22) & 0xFF, 0x01 | ((pts >> 14) & 0xFE),
                  (pts >> 7) & 0xFF, 0x01 | ((pts << 1) & 0xFE)])


def _frame(pts, key, extra_packets=2):
    pes = b"\x00\x00\x01\xE0\x00\x00\x80\x80\x05" + _pts_bytes(pts % (1 << 33))
    # Structurally valid Annex-B headers are required, not just the TS RAI bit.
    pes += (b"\x00\x00\x01\x67\x42\x80\x00\x00\x01\x68\xce\x80" if key else b"")
    pes += b"\x00\x00\x01" + (b"\x65" if key else b"\x41") + b"\x80"
    out = _pkt(VIDEO_PID, pes, pusi=True, rai=key)
    out += b"".join(_pkt(VIDEO_PID, b"v") for _ in range(extra_packets))
    out += _pkt(AUDIO_PID, b"\x00\x00\x01\xC0", pusi=True)
    return out


def _stream(seconds, gop_frames, start_pts=90000, psi=True, extra_packets=2):
    out = (_pat() + _pmt()) if psi else b""
    for i in range(int(seconds * FPS)):
        out += _frame(start_pts + i * 90000 // FPS, i % gop_frames == 0, extra_packets)
    return out


def _chunks(data, size=188 * 7 + 50):
    return [data[i:i + size] for i in range(0, len(data), size)]


def test_parser_finds_keyframes_pts_and_psi_across_unaligned_chunks():
    parser = TsParser()
    starts = []
    blocks = b""
    for chunk in _chunks(_stream(4, gop_frames=25)):
        block, found = parser.feed(chunk)
        starts += [(len(blocks) + s.offset, s.key, s.pts) for s in found]
        blocks += block
    assert len(blocks) % 188 == 0
    keys = [s for s in starts if s[1]]
    assert len(keys) == 4 and len(starts) == 100
    assert keys[1][2] == 90000 + 90000  # second I-frame at +1s
    assert parser.psi_header.startswith(b"\x47\x40\x00")
    assert parser.audio_adts is True and parser.video_codec == "h264"


def test_parser_hevc_stream_type_and_resync_after_garbage():
    parser = TsParser()
    data = _pat() + _pmt(video_type=0x24) + b"\x12\x34\x56" + _frame(90000, True) + _frame(93600, False)
    block, found = parser.feed(data)
    tail, more = parser.flush()
    assert parser.video_codec == "h265" and parser.lost_bytes == 3
    assert block + tail == data[:2 * 188] + data[2 * 188 + 3:]
    # H.265 不看 RAI：合成帧里没有真实 NAL，找不到 VCL 的帧一律不作关键帧
    # （真实 NAL 布局下的 IDR/CRA 判定见 test_ts_gate_hevc.py）
    assert [s.key for s in found + more] == [False, False]
    assert parser.unknown_aus == 2
    assert parser.lost_bytes == 3


def test_time_mapper_unwraps_pts_and_ignores_startup_burst():
    tm = TimeMapper()
    # 连接瞬间 SRS gop_cache 突发送来 8s 前的内容（到达时间相同），随后实时到达
    for i in range(8):
        tm.observe(tm.unwrap(i * 90000), arrival=1000.0 + i * 0.01)
    for i in range(8, 20):
        tm.observe(tm.unwrap(i * 90000), arrival=1000.0 + (i - 8) + 0.07)
    assert abs(tm.wall(tm.unwrap(0)) - 992.07) < 0.05  # 首帧内容时间 = 连接前 8s
    # 33 位 PTS 回绕
    tm2 = TimeMapper()
    near = (1 << 33) - 90000
    a = tm2.unwrap(near)
    tm2.observe(a, arrival=0.0)
    b = tm2.unwrap(45000)
    assert 1.4 < b - a < 1.6


def _run_gate(gate, data, pop_every=None):
    """pop_every=None：写端无限快；=k：每推入 k 块才写出 1 块（模拟慢写入）。"""
    parser, tm = TsParser(), TimeMapper()
    written = []
    for n, chunk in enumerate(_chunks(data)):
        block, starts = parser.feed(chunk)
        for s in starts:
            tm.observe(tm.unwrap(s.pts), arrival=n * 0.01)
        gate.push(block, starts, tm)
        if pop_every is None:
            while (c := gate.pop()) is not None:
                written.append(c)
        elif n % pop_every == 0 and (c := gate.pop(max_bytes=0)) is not None:
            written.append(c)  # 慢写端：每次只写一帧
    gate.finish(tm)
    while (c := gate.pop()) is not None:  # 源结束后写端把积压写完
        written.append(c)
    return written, parser


FRAME_BYTES = 4 * 188  # _frame(): 视频 PES 起始包 + 2 个续包 + 1 个音频包


def test_queue_only_ever_holds_whole_frames_even_on_truncation():
    """截断/停止时写端拿到的最后一帧必须完整：队列只按帧边界入队。"""
    gate = GopGate(segment_seconds=60, soft_cap=188 * 200, hard_cap=188 * 400)
    parser, tm = TsParser(), TimeMapper()
    for n, chunk in enumerate(_chunks(_stream(25, gop_frames=250))):  # 块边界落在帧中间
        block, starts = parser.feed(chunk)
        for s in starts:
            tm.observe(tm.unwrap(s.pts), arrival=n * 0.01)
        gate.push(block, starts, tm)
        assert gate.queued_bytes % FRAME_BYTES == 0
    popped = b""
    while (c := gate.pop()) is not None:
        popped += c.data
    assert popped and len(popped) % FRAME_BYTES == 0 and popped[5] & 0x40


def test_gate_rotates_on_keyframe_after_segment_seconds_without_losing_bytes():
    gate = GopGate(segment_seconds=2, soft_cap=10**9, hard_cap=10**9)
    data = _stream(7, gop_frames=15)  # GOP=0.6s → 段在 ≥2s 后的下一个 I 帧切
    written, _ = _run_gate(gate, data)
    files = [c for c in written if c.new_file]
    assert len(files) == 3  # 0, 2.4, 4.8s
    assert [round(f.file_pts - files[0].file_pts, 1) for f in files] == [0.0, 2.4, 4.8]
    payload = b"".join(c.data for c in written)
    assert payload == data[188 * 2:]  # 除 PSI 外逐字节原样，首块从 I 帧开始
    assert gate.events == [] and gate.dropped_bytes == 0


def test_gate_soft_cap_drops_whole_gops_with_hysteresis_and_reports_event():
    events = []
    per_gop = 25 * 4 * 188
    gate = GopGate(segment_seconds=60, soft_cap=per_gop * 3, hard_cap=per_gop * 10,
                   low_ratio=0.5, on_event=events.append)
    written, _ = _run_gate(gate, _stream(20, gop_frames=25), pop_every=2)
    assert events, "慢写入必须产生丢弃事件"
    for i, e in enumerate(events):
        assert e["reason"] == "backlog" and e["gops"] >= 1
        assert e["endTs"] > e["startTs"]
        if i < len(events) - 1:
            assert e["droppedMs"] == e["gops"] * 1000  # 在 I 帧恢复：整 GOP 丢弃，时长精确
        else:
            assert e["droppedMs"] <= e["gops"] * 1000  # 可能由 finish() 在末帧收口
    # 每次恢复写入都从 I 帧开新文件，文件内部没有时间空洞（结尾仍在丢弃的那段由
    # finish() 收口记账，不产生新文件）
    resumed = sum(1 for c in written if c.new_file) - 1
    assert resumed in (len(events), len(events) - 1) and resumed >= 1
    for c in written:
        if c.new_file:
            assert c.data[3] >> 4 == 3 and c.data[5] & 0x40  # RAI 包打头


def test_gate_hard_cap_truncates_giant_gop_tail_and_resumes_on_next_keyframe():
    events = []
    # 单个 GOP 10s（远大于硬上限），写入完全停住
    gate = GopGate(segment_seconds=60, soft_cap=188 * 200, hard_cap=188 * 400, on_event=events.append)
    parser, tm = TsParser(), TimeMapper()
    data = _stream(25, gop_frames=250)  # I 帧在 0 / 10 / 20s
    chunks = _chunks(data)
    half = len(chunks) * 12 // 25
    queued = []
    for n, chunk in enumerate(chunks):
        if n == half:  # 写入端在 12s 时恢复，一口气写完积压
            while (c := gate.pop()) is not None:
                queued.append(c)
        block, starts = parser.feed(chunk)
        for s in starts:
            tm.observe(tm.unwrap(s.pts), arrival=n * 0.01)
        gate.push(block, starts, tm)
        assert gate.queued_bytes <= 188 * 400 + FRAME_BYTES  # 只在帧起点判断，最多超一帧
    gate.finish(tm)
    while (c := gate.pop()) is not None:
        queued.append(c)
    # 第二个事件是 20s 恢复后写端又停、再次撑爆硬上限，由 finish() 收口
    assert events[0]["reason"] == "truncated" and all(e["reason"] == "truncated" for e in events)
    # 截断从首个 GOP 中途开始，到 20s 的 I 帧恢复：丢弃时长 < 20s 且 > 10s
    assert 10_000 < events[0]["droppedMs"] < 20_000
    # 截断只丢 GOP 尾部：保留的首段从 I 帧开头；恢复点开新文件、也从 I 帧开头
    files = [c for c in queued if c.new_file]
    assert len(files) == 2 and all(f.data[5] & 0x40 for f in files)
    assert round(files[1].file_pts - files[0].file_pts) == 20


def test_stop_discard_during_drop_episode_does_not_overlap_it():
    """停止时丢弃积压（stopped）与进行中的丢弃段（backlog）区间不能重叠重复计时。"""
    events = []
    per_gop = 25 * 4 * 188
    gate = GopGate(segment_seconds=60, soft_cap=per_gop * 3, hard_cap=per_gop * 10,
                   on_event=events.append)
    parser, tm = TsParser(), TimeMapper()
    for n, chunk in enumerate(_chunks(_stream(12, gop_frames=25))):
        block, starts = parser.feed(chunk)
        for s in starts:
            tm.observe(tm.unwrap(s.pts), arrival=n * 0.01)
        gate.push(block, starts, tm)  # 写端完全不写：积压到软上限后进入丢弃态
    assert gate.dropping and gate.queue
    gate.discard_queue(tm)
    kinds = sorted(events, key=lambda e: e["startTs"])
    assert [e["reason"] for e in kinds] == ["stopped", "backlog"]
    assert kinds[0]["endTs"] <= kinds[1]["startTs"]
    assert sum(e["droppedMs"] for e in events) <= 12_000


def test_gate_keeps_only_recent_events_in_memory():
    recorded = []
    gate = GopGate(segment_seconds=60, soft_cap=1, hard_cap=1, on_event=recorded.append)
    tm = TimeMapper()
    tm.observe(0.0, arrival=0.0)
    for i in range(250):
        gate._open_episode(float(i), "backlog", tm)
        gate._close_episode(i + 0.5, tm)
    assert len(recorded) == 250          # 全部交给持久化回调
    assert len(gate.events) == 100       # 内存里只留近期，不随运行时长增长
    assert gate.events[-1]["droppedMs"] == 500


def test_gate_discards_data_before_first_keyframe_silently():
    events = []
    gate = GopGate(segment_seconds=60, soft_cap=10**9, hard_cap=10**9, on_event=events.append)
    data = _pat() + _pmt() + b"".join(_frame(90000 + i * 3600, i == 10) for i in range(20))
    written, _ = _run_gate(gate, data)
    assert written[0].new_file and written[0].data[5] & 0x40
    assert events == []
