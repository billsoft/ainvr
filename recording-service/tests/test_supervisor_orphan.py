"""Supervisor orphan 收尸 + spawn 围栏 + 写入卡死/写得慢三态：

- 管线里任一进程（读端或写端）D 状态不死，绝不拉起新管线（防两个写者写同一
  文件）；全部被内核回收后自动恢复；
- 写入卡死（字节级无进展）→ 存储熔断停录；与 I 帧间隔、分段时长无关；
- 写得慢 → 继续录，状态 degraded，丢弃事件入库并出现在通道状态里。
"""
import asyncio
import os
import time

from recorder.config import ConfigStore
from recorder.index import SegmentIndex
from recorder.storage import StorageManager
from recorder.supervisor import Supervisor


class FakeChannels:
    def __init__(self, channels):
        self.channels = channels


class FakePipeline:
    def __init__(self, pid=4242):
        self.pid = pid
        self.exited = False
        self.returncode = None
        self.error = None
        self.is_stalled = False
        self.dropping_since = None
        self.stopped = False

    def stalled(self):
        return self.is_stalled

    def stats(self):
        return {"stalled": self.is_stalled, "dropping": self.dropping_since is not None,
                "dropStartTs": self.dropping_since, "bufferBytes": 0, "bufferSec": 3.5}

    async def stop(self, term_timeout=5.0, kill_timeout=3.0):
        self.stopped = True
        self.returncode = self.returncode if self.returncode is not None else 0
        return self.exited


def _build(tmp_path, online=False):
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
    ch = {"id": "ch1", "name": "大门口", "streamName": "live/ch1",
          "rtmpUrl": "rtmp://127.0.0.1:9/live/ch1", "online": online}
    sup = Supervisor(store, FakeChannels([ch]), sm, index)
    return sup, sm, ch, index


def test_orphan_fences_spawn_then_reaper_allows_restart(tmp_path):
    sup, sm, ch, _ = _build(tmp_path)

    async def run():
        stuck = FakePipeline(pid=4242)
        sup.orphans["ch1"] = stuck
        st = sup.state_of("ch1")

        # 1) orphan 存活：围栏拦截，state=storage_error 且带 pid，绝不拉起新管线
        await sup._tick()
        assert "ch1" in sup.orphans
        assert st.state == "storage_error"
        assert "4242" in st.detail
        assert st.proc is None

        # 2) 内核终于回收全部进程：reaper 清除 orphan；下一轮围栏解除
        stuck.exited = True
        await sup._tick()
        assert "ch1" not in sup.orphans
        await sup._tick()
        assert st.state == "waiting_source"
        assert "4242" not in (st.detail or "")
        sm.io.shutdown()

    asyncio.run(run())


def test_ended_pipeline_with_stuck_writer_becomes_orphan_and_reports_reason(tmp_path):
    sup, sm, ch, _ = _build(tmp_path)

    async def run():
        st = sup.state_of("ch1")
        ended = FakePipeline(pid=77)
        ended.returncode, ended.error = 1, "写入进程退出码 1（存储写入报错）"
        st.proc, st.state = ended, "recording"
        await sup._tick()
        assert st.proc is None and sup.orphans["ch1"] is ended  # 写端仍卡着：围栏
        assert "存储写入报错" in st.detail
        sm.io.shutdown()

    asyncio.run(run())


def test_write_stall_trips_storage_regardless_of_gop_length(tmp_path):
    sup, sm, ch, _ = _build(tmp_path)

    async def run():
        st = sup.state_of("ch1")
        p = FakePipeline()
        p.exited = True
        st.proc, st.state = p, "recording"
        await sup._tick()
        assert st.proc is p and not sm.io.tripped  # 未卡死：不因"久无新分段"误判
        p.is_stalled = True
        await sup._tick()
        assert sm.io.tripped and p.stopped
        assert st.proc is None
        sm.io.shutdown()

    asyncio.run(run())


def test_shutdown_stops_channels_in_parallel(tmp_path):
    """每路停止最坏约 6s，串行时通道一多就超 systemd 15s 停服时限。"""
    sup, sm, ch, _ = _build(tmp_path)

    class SlowStop(FakePipeline):
        async def stop(self, term_timeout=5.0, kill_timeout=3.0):
            await asyncio.sleep(0.3)
            return True

    async def run():
        for cid in ("a", "b", "c", "d"):
            sup.state_of(cid).proc = SlowStop()
        t0 = asyncio.get_running_loop().time()
        await sup.shutdown()
        return asyncio.get_running_loop().time() - t0

    elapsed = asyncio.run(run())
    assert elapsed < 0.6
    assert all(st.proc is None for st in sup.states.values())
    sm.io.shutdown()


def test_slow_write_is_degraded_not_stopped_and_drops_are_recorded(tmp_path):
    sup, sm, ch, index = _build(tmp_path)
    st = sup.state_of("ch1")
    p = FakePipeline()
    st.proc, st.state = p, "recording"
    now_ms = int(time.time() * 1000)
    sup._record_drop({"channelId": "ch1", "startTs": now_ms - 60_000, "endTs": now_ms - 50_000,
                      "droppedMs": 10_000, "gops": 3, "bytes": 1, "reason": "backlog"})
    p.dropping_since = now_ms - 5_000
    status = sup.recording_status("ch1")
    assert status["recordingState"] == "recording"
    assert status["writeState"] == "degraded"
    assert 14_000 <= status["droppedMsLastHour"] <= 16_000  # 已入库 10s + 进行中约 5s
    assert "当前写入积压" in status["recordingDetail"]
    assert "未保存录像" in status["recordingDetail"]
    p.dropping_since = None
    assert "当前无写入积压" in sup.recording_status("ch1")["recordingDetail"]
    assert sup.write_summary()["writeDegradedChannels"] == 1
    rows = asyncio.run(index.run(index.drop_events, "ch1", now_ms - 120_000, now_ms))
    assert rows[0]["droppedMs"] == 10_000
    index.close()
    sm.io.shutdown()


def test_second_stuck_pipeline_does_not_overwrite_existing_orphan(tmp_path):
    """同一通道已有卡死 orphan 时又有一代管线卡死：两个都要保留，围栏才能一直拦住。"""
    sup, sm, ch, index = _build(tmp_path, online=True)

    async def run():
        first, second = FakePipeline(pid=1001), FakePipeline(pid=1002)
        sup.orphans["ch1"] = first
        second.returncode = 1
        st = sup.state_of("ch1")
        st.proc, st.state = second, "recording"
        await sup._tick()
        kept = list(sup.orphans.values())
        assert first in kept and second in kept
        first.exited = True
        await sup._tick()
        assert list(sup.orphans.values()) == [second]
        assert st.proc is None and st.state == "storage_error"
        second.exited = True
        await sup._tick()
        assert not sup.orphans

    try:
        asyncio.run(run())
    finally:
        index.close()
        sm.io.shutdown()
