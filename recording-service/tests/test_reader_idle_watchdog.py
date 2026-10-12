"""读端卡死看门狗：源在出画面，读端却长时间解析不出任何画面单元时必须重启该路。

2026-10-09 现场：大门口相机反复断线重连，AI 输出沿用同一推流会话；录像读端在一次
重连后 FLV 解析错位（持续 Packet mismatch），进程存活却零输出，写端停在旧文件，
漏录 26 分钟。推流会话没变不会触发"源重新推流"，"写入卡死"只看有数据待写的情况，
两条都兜不住。
"""
import asyncio
import time
from types import SimpleNamespace

from recorder.recording_pipeline import RecordingPipeline
from recorder.supervisor import BACKOFF_STEPS, READER_IDLE_SEC, RECONNECT_DRAIN_SEC
from test_supervisor_orphan import FakePipeline, _build
from test_channels_publisher import _manager, _srs
from recorder import channels as channels_mod


class IdlePipeline(FakePipeline):
    codec = "h264"

    def __init__(self, idle):
        super().__init__()
        self.idle = idle

    def input_idle_seconds(self):
        return self.idle

    def stop_input(self):
        self.stopped = True

    async def stop(self, term_timeout=5.0, kill_timeout=3.0):
        self.drain_budget = term_timeout
        return await super().stop(term_timeout, kill_timeout)


def _recording(sup, channel, idle, online=True):
    channel.update(codec="h264", publisherId="p1", online=online)
    state = sup.state_of("ch1")
    pipeline = IdlePipeline(idle)
    state.proc, state.publisher_id, state.state = pipeline, "p1", "recording"
    state.started_at = time.time() - 600
    sup.channels.reader_watchdog_source = lambda ch: (
        {"publisherId": "p1", "frames": 100, "sampleAgeSec": 0,
         "progressAgeSec": 0} if online else None)
    return state, pipeline


def _run(tmp_path, idle, online, check):
    sup, storage, channel, index = _build(tmp_path, online=online)

    async def run():
        state, pipeline = _recording(sup, channel, idle, online)
        before = time.time()
        await sup._tick()
        check(sup, state, pipeline, before)
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_reader_without_output_while_source_streams_is_restarted(tmp_path):
    def check(sup, state, pipeline, before):
        assert pipeline.stopped, "读端零输出而源在出画面：必须停掉该路重启"
        assert state.proc is None
        assert pipeline.drain_budget >= RECONNECT_DRAIN_SEC  # 积压照常交给写端写完
        assert state.failures == 1                # 计失败、逐级退避，防止反复拉起
        assert state.next_attempt_ts >= before + BACKOFF_STEPS[0] - 0.5
        assert "读流" in state.detail

    _run(tmp_path, READER_IDLE_SEC + 1, True, check)


def test_reader_idle_is_expected_when_source_has_no_fresh_video(tmp_path):
    def check(sup, state, pipeline, before):
        assert not pipeline.stopped               # 源本身没画面：读端没输出是正常的
        assert state.proc is pipeline

    _run(tmp_path, READER_IDLE_SEC + 60, False, check)


def test_short_reader_pause_is_not_restarted(tmp_path):
    def check(sup, state, pipeline, before):
        assert not pipeline.stopped
        assert state.proc is pipeline

    _run(tmp_path, READER_IDLE_SEC - 1, True, check)


def test_cached_online_without_video_evidence_does_not_restart(tmp_path):
    sup, storage, channel, index = _build(tmp_path, online=True)

    async def run():
        state, pipeline = _recording(sup, channel, READER_IDLE_SEC + 1)
        sup.channels.reader_watchdog_source = lambda ch: None
        await sup._tick()
        assert not pipeline.stopped and state.proc is pipeline
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_input_idle_counts_only_parsed_access_units():
    """乱码字节（错位解析出不了画面单元）不算进展；真正解析出画面单元才算。"""
    now = [0.0]
    pipeline = RecordingPipeline(channel_id="test", rtmp_url="unused", root="/nonexistent",
                                 segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048,
                                 monotonic=lambda: now[0])
    assert pipeline.input_idle_seconds() == 0.0   # 未启动不报空闲

    def feed(chunk):
        return chunk, ([SimpleNamespace(pts=None)] if chunk.startswith(b"AU") else [])

    pipeline.parser.feed = feed
    pipeline.parser.flush = lambda: (b"", [])
    pipeline.gate.push = lambda *a: None
    pipeline.gate.finish = lambda *a: None

    async def run():
        stdout = asyncio.StreamReader()
        pipeline._reader = SimpleNamespace(stdout=stdout)
        pipeline._last_input_mono = now[0]        # 读端刚拉起
        task = asyncio.create_task(pipeline._read_loop())

        async def push(data, at):
            now[0] = at
            stdout.feed_data(data)
            await asyncio.sleep(0.01)

        await push(b"AU1", 5.0)
        now[0] = 30.0
        assert pipeline.input_idle_seconds() == 25.0
        await push(b"garbage", 31.0)
        assert pipeline.input_idle_seconds() == 26.0
        await push(b"AU2", 32.0)
        assert pipeline.input_idle_seconds() == 0.0
        stdout.feed_eof()
        await asyncio.wait_for(task, 1)

    asyncio.run(run())


def _progress_manager(tmp_path, monkeypatch):
    data = _srs({"active": True, "cid": "p1"})
    data["streams"][0]["frames"] = 100
    now = [100.0]
    monkeypatch.setattr(channels_mod.time, "monotonic", lambda: now[0])
    manager = _manager(tmp_path, monkeypatch, data, bff_online=True)
    asyncio.run(manager.refresh_once())
    return manager, data["streams"][0], now


def test_first_sample_does_not_prove_video_is_advancing(tmp_path, monkeypatch):
    manager, _, _ = _progress_manager(tmp_path, monkeypatch)
    assert manager.get("c1")["online"]
    assert manager.reader_watchdog_source(manager.get("c1")) is None


def test_watchdog_evidence_requires_fresh_growth_and_expires(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    now[0] += 5
    stream["frames"] += 10
    asyncio.run(manager.refresh_once())
    evidence = manager.reader_watchdog_source(manager.get("c1"))
    assert evidence["publisherId"] == "p1" and evidence["frames"] == 110
    assert evidence["sampleAgeSec"] == evidence["progressAgeSec"] == 0
    now[0] += 16
    assert manager.reader_watchdog_source(manager.get("c1")) is None


def test_frozen_video_and_bff_online_do_not_restart_idle_reader(tmp_path, monkeypatch):
    manager, _, now = _progress_manager(tmp_path, monkeypatch)
    now[0] += 30
    asyncio.run(manager.refresh_once())
    channel = manager.get("c1")
    assert channel["online"]  # 页面缓存可以保持在线，但不能用作恢复证据
    sup, storage, target, index = _build(tmp_path / "supervisor", online=True)

    async def run():
        state, pipeline = _recording(sup, target, 40)
        target.update(app="live", streamName="cam")
        sup.channels.reader_watchdog_source = manager.reader_watchdog_source
        await sup._tick()
        assert state.proc is pipeline and not pipeline.stopped
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        manager.index.close()
        index.close()
        storage.io.shutdown()


def test_api_failure_revokes_evidence_despite_bff_online(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    stream["frames"] += 1
    now[0] += 5
    asyncio.run(manager.refresh_once())
    assert manager.reader_watchdog_source(manager.get("c1"))

    def unavailable(*args, **kwargs):
        raise OSError("接口不可达")

    monkeypatch.setattr(channels_mod, "_http_get_json", unavailable)
    asyncio.run(manager.refresh_once())
    assert manager.get("c1")["online"]
    assert manager.reader_watchdog_source(manager.get("c1")) is None


def test_publisher_switch_or_frame_counter_reset_requires_new_baseline(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    for publisher in ("p2", "p2"):
        stream["publish"]["cid"] = publisher
        stream["frames"] = 1
        now[0] += 5
        asyncio.run(manager.refresh_once())
        assert manager.reader_watchdog_source(manager.get("c1")) is None
        stream["frames"] = 10
        now[0] += 5
        asyncio.run(manager.refresh_once())
        assert manager.reader_watchdog_source(manager.get("c1"))


def test_missing_counter_is_not_progress_evidence(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    del stream["frames"]
    now[0] += 5
    asyncio.run(manager.refresh_once())
    assert manager.reader_watchdog_source(manager.get("c1")) is None


def test_bff_failure_does_not_hide_verified_source_growth(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    stream["frames"] += 1
    now[0] += 5

    def unavailable():
        raise OSError("目录暂不可达")

    monkeypatch.setattr(manager, "_fetch_bff_channels", unavailable)
    asyncio.run(manager.refresh_once())
    assert manager.reader_watchdog_source(manager.get("c1"))


def test_progress_after_long_sampling_gap_needs_another_sample(tmp_path, monkeypatch):
    manager, stream, now = _progress_manager(tmp_path, monkeypatch)
    now[0] += 60
    stream["frames"] += 100
    asyncio.run(manager.refresh_once())
    assert manager.reader_watchdog_source(manager.get("c1")) is None
    now[0] += 5
    stream["frames"] += 10
    asyncio.run(manager.refresh_once())
    assert manager.reader_watchdog_source(manager.get("c1"))
