"""Supervisor 授权门：非 valid 相位停录且状态 license_error；恢复后续录。"""
from __future__ import annotations

import asyncio
import os

from recorder.config import ConfigStore
from recorder.index import SegmentIndex
from recorder.storage import StorageManager
from recorder.supervisor import Supervisor


class FakeChannels:
    def __init__(self, channels):
        self.channels = channels


class FakePipeline:
    def __init__(self):
        self.pid = 5001
        self.exited = True
        self.returncode = None
        self.error = None
        self.stopped = False

    def stats(self):
        return {}

    async def stop(self, term_timeout=5.0, kill_timeout=3.0):
        self.stopped = True
        self.returncode = 0
        return True


def _build(tmp_path, gate):
    store = ConfigStore(str(tmp_path / "config.json"))
    cfg = store.mutate()
    cfg.recording.storage.localPath = str(tmp_path / "videos")
    cfg.enabled_channel_ids = ["ch1"]
    os.makedirs(cfg.recording.storage.localPath, exist_ok=True)
    store.save()
    store.commit()
    index = SegmentIndex(str(tmp_path / "segments.db"))
    sm = StorageManager()
    sm.status.root = cfg.recording.storage.localPath
    ch = {"id": "ch1", "name": "大门", "streamName": "live/ch1",
          "rtmpUrl": "rtmp://127.0.0.1:9/live/ch1", "online": True, "codec": "h264"}
    sup = Supervisor(store, FakeChannels([ch]), sm, index, license_gate=gate)
    return sup, sm, ch


def test_non_valid_phase_stops_recording_and_marks_license_error(tmp_path):
    gate = lambda: (False, "invalid")  # noqa: E731
    sup, sm, ch = _build(tmp_path, gate)

    async def run():
        st = sup.state_of("ch1")
        p = FakePipeline()
        st.proc, st.state = p, "recording"
        await sup._tick()
        assert p.stopped is True          # 在录管线被有界收尾
        assert st.proc is None
        assert st.state == "license_error"
        assert "设备未授权" in st.detail
        sm.io.shutdown()

    asyncio.run(run())


def test_starting_phase_blocks_boot_recording(tmp_path):
    """启动门：从未取到有效签名前不允许启动任何录像。"""
    sup, sm, _ = _build(tmp_path, lambda: (False, "starting"))

    async def run():
        await sup._tick()
        st = sup.state_of("ch1")
        assert st.state == "license_error"
        assert st.proc is None
        sm.io.shutdown()

    asyncio.run(run())


def test_recovered_valid_resumes_normal_reconcile(tmp_path, monkeypatch):
    phase = {"value": "starting"}
    sup, sm, _ = _build(tmp_path, lambda: (phase["value"] == "valid", phase["value"]))

    spawned: list[str] = []

    async def fake_spawn(ch, st, root, segment_seconds, caps):
        spawned.append(ch["id"])
        st.proc = FakePipeline()
        st.state = "recording"

    # 失权期间 tick：不 spawn
    async def run():
        await sup._tick()
        assert spawned == []

        # 授权恢复：下一 tick 按既有 reconcile 正常拉起
        phase["value"] = "valid"
        monkeypatch.setattr(sup, "_spawn", fake_spawn)
        await sup._tick()
        assert spawned == ["ch1"]
        assert sup.state_of("ch1").state == "recording"
        sm.io.shutdown()

    asyncio.run(run())


def test_lease_expiring_during_async_start_is_stopped(tmp_path, monkeypatch):
    allowed = [True]
    sup, sm, ch = _build(tmp_path, lambda: (allowed[0], "valid" if allowed[0] else "dormant"))
    pipeline = FakePipeline()

    async def start():
        await asyncio.sleep(0)
        allowed[0] = False

    pipeline.start = start
    monkeypatch.setattr("recorder.supervisor.RecordingPipeline", lambda **kw: pipeline)

    async def run():
        st = sup.state_of("ch1")
        await sup._spawn(ch, st, sm.status.root, 60, (1024, 2048))
        assert pipeline.stopped
        assert st.proc is None
        assert st.state == "license_error"
        sm.io.shutdown()

    asyncio.run(run())


def test_gate_none_default_allows(tmp_path):
    """不传 gate 时（未接线）行为与旧版完全一致。"""
    store = ConfigStore(str(tmp_path / "config.json"))
    cfg = store.mutate()
    cfg.recording.storage.localPath = str(tmp_path / "videos")
    os.makedirs(cfg.recording.storage.localPath, exist_ok=True)
    store.save()
    store.commit()
    index = SegmentIndex(str(tmp_path / "segments.db"))
    sm = StorageManager()
    sm.status.root = cfg.recording.storage.localPath
    sup = Supervisor(store, FakeChannels([]), sm, index)
    assert sup._license_gate is None
