"""Reconnect must not serialize supervision or discard a recoverable backlog."""
import asyncio
import sys
from types import SimpleNamespace

from recorder.recording_pipeline import RecordingPipeline
from test_supervisor_orphan import FakePipeline, _build


def test_republish_drains_in_background_without_blocking_other_channels(tmp_path):
    sup, storage, channel, index = _build(tmp_path, online=True)

    async def run():
        released = asyncio.Event()

        class SlowPipeline(FakePipeline):
            codec = "h264"

            def stop_input(self):
                self.stopped = True

            async def stop(self, term_timeout=5.0, kill_timeout=3.0):
                self.timeout = term_timeout
                await released.wait()
                self.exited = True
                return True

        old = SlowPipeline()
        channel.update(codec="h264", publisherId="new")
        state = sup.state_of("ch1")
        state.proc, state.publisher_id, state.state = old, "old", "recording"
        try:
            await asyncio.wait_for(sup._tick(), .2)
            assert old.stopped
            assert state.proc is None
            assert "ch1" in sup.retiring
            assert old.timeout >= 30
        finally:
            released.set()
            await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_retiring_memory_is_included_in_admission(tmp_path):
    sup, storage, _, index = _build(tmp_path)
    from recorder.supervisor import GLOBAL_BUFFER_BYTES
    old = SimpleNamespace(gate=SimpleNamespace(hard_cap=GLOBAL_BUFFER_BYTES,
                                              queued_bytes=GLOBAL_BUFFER_BYTES))
    sup.retiring = {"old": SimpleNamespace(pipeline=old)}
    try:
        assert not sup._buffer_available(1)
    finally:
        index.close()
        storage.io.shutdown()


def test_successor_does_not_pop_queue_until_old_writer_exits(tmp_path):
    async def run():
        ready = False
        pipeline = RecordingPipeline(
            channel_id="test", rtmp_url="unused", root=str(tmp_path),
            segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048,
            writer_ready=lambda: ready)
        popped = []
        pipeline.gate.pop = lambda: popped.append(True)
        pipeline._input_done = True
        task = asyncio.create_task(pipeline._write_loop())
        await asyncio.sleep(.03)
        assert not popped
        ready = True
        await asyncio.wait_for(task, .5)
        assert popped

    asyncio.run(run())


def test_stop_input_is_idempotent(tmp_path):
    pipeline = RecordingPipeline(channel_id="test", rtmp_url="unused", root=str(tmp_path),
                                 segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048)
    signals = []
    pipeline._reader = SimpleNamespace(returncode=None, terminate=lambda: signals.append(1))
    pipeline.stop_input()
    pipeline.stop_input()
    pipeline.expedite_stop()
    assert signals == [1]


def test_repeated_republish_keeps_only_one_retiring_generation(tmp_path):
    sup, storage, _, index = _build(tmp_path)

    async def run():
        released = asyncio.Event()

        class Slow(FakePipeline):
            def stop_input(self):
                self.stopped = True

            def expedite_stop(self):
                released.set()

            async def stop(self, **kwargs):
                await released.wait()
                self.exited = True
                return True

        state = sup.state_of("ch1")
        old, successor = Slow(), Slow()
        state.proc = old
        await sup._stop(state, "源重新推流", wait=False, drain_seconds=45)
        state.proc = successor
        await sup._stop(state, "再次重推", wait=False, drain_seconds=45)
        assert len(sup.retiring) == 1
        assert sup.retiring["ch1"].pipeline is old
        assert state.proc is successor and successor.stopped
        # Service shutdown accelerates the old drain rather than waiting 45 seconds.
        await asyncio.wait_for(sup.shutdown(), .5)
        assert not sup.retiring and state.proc is None

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_cancelled_reader_flush_is_accounted_before_queue_discard(tmp_path, monkeypatch):
    async def run():
        order = []
        pipeline = RecordingPipeline(channel_id="test", rtmp_url="unused", root=str(tmp_path),
                                     segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048)

        async def reader():
            try:
                await asyncio.Event().wait()
            finally:
                order.append("flush")

        async def finished(*args, **kwargs):
            return True

        pipeline.gate.discard_queue = lambda mapper: order.append("discard")
        monkeypatch.setattr("recorder.recording_pipeline.stop_processes", finished)
        pipeline._tasks = [asyncio.create_task(asyncio.Event().wait()),
                           asyncio.create_task(reader()),
                           asyncio.create_task(asyncio.Event().wait())]
        pipeline._done = asyncio.create_task(asyncio.Event().wait())
        await asyncio.sleep(0)
        assert await pipeline.stop(term_timeout=.01)
        assert order == ["flush", "discard"]
        assert all(t.done() for t in pipeline._tasks)

    asyncio.run(run())


def test_delete_during_handover_keeps_successor_owned_until_stopped(tmp_path):
    sup, storage, _, index = _build(tmp_path)

    async def run():
        released = asyncio.Event()

        class Slow(FakePipeline):
            def stop_input(self):
                self.stopped = True

            def expedite_stop(self):
                released.set()

            async def stop(self, **kwargs):
                await released.wait()
                self.exited = True
                return True

        state = sup.state_of('ch1')
        old, successor = Slow(), Slow()
        state.proc = old
        await sup._stop(state, '重推', wait=False)
        state.proc = successor
        sup.channels.channels.clear()
        try:
            await sup._tick()
            assert successor.stopped
            assert sup.states['ch1'].proc is successor
        finally:
            released.set()
            await sup.shutdown()
        assert successor.exited

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_real_video_survives_writer_delay_longer_than_old_stop_budget(tmp_path):
    import glob
    from recorder.ffmpeg_recorder import build_writer_command
    from recorder.storage_io import IsolatedIO
    from recorder.supervisor import RECONNECT_DRAIN_SEC
    from test_recording_pipeline import _make_ts, _count, _decode_errors

    source = _make_ts(str(tmp_path / "source.ts"), 3, 25, bframes=0)
    events = []
    storage = IsolatedIO()

    def delayed_writer(*args):
        return [sys.executable, "-c",
                "import os,sys,time; time.sleep(6); os.execvp(sys.argv[1],sys.argv[1:])",
                *build_writer_command(*args)]

    async def run():
        pipeline = RecordingPipeline(
            channel_id="drain", rtmp_url="unused", root=str(tmp_path / "videos"),
            segment_seconds=60, io=storage, soft_cap=8 << 20, hard_cap=16 << 20,
            reader_cmd=["cat", source], writer_cmd=delayed_writer, settle_sec=0,
            on_event=events.append)
        await pipeline.start()
        try:
            async def input_finished():
                while not pipeline._input_done:
                    await asyncio.sleep(.01)
            await asyncio.wait_for(input_finished(), 5)
            assert await pipeline.stop(term_timeout=RECONNECT_DRAIN_SEC)
        finally:
            if not pipeline.exited:
                pipeline.expedite_stop()
                await pipeline.stop(term_timeout=.1)

    try:
        asyncio.run(run())
        files = glob.glob(str(tmp_path / "videos" / "*" / "*.mp4"))
        assert files and not events
        assert sum(_count(f, "v:0") for f in files) == _count(source, "v:0")
        assert all(_decode_errors(f) == (0, "") for f in files)
    finally:
        storage.shutdown()


def test_unresponsive_reader_does_not_consume_writer_drain_budget(tmp_path):
    from recorder.storage_io import IsolatedIO
    from test_recording_pipeline import _make_ts, _count
    import glob

    source = _make_ts(str(tmp_path / 'source.ts'), 2, 25, bframes=0)
    storage = IsolatedIO()

    async def run():
        command = [sys.executable, '-c',
                   'import signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                   'sys.stdout.buffer.write(open(sys.argv[1],"rb").read()); '
                   'sys.stdout.buffer.flush(); time.sleep(60)', source]
        p = RecordingPipeline(channel_id='reader-stuck', rtmp_url='unused',
                              root=str(tmp_path / 'videos'), segment_seconds=60,
                              io=storage, soft_cap=8 << 20, hard_cap=16 << 20,
                              reader_cmd=command, settle_sec=0)
        await p.start()
        try:
            for _ in range(200):
                if p.files:
                    break
                await asyncio.sleep(.01)
            assert p.files
            assert await asyncio.wait_for(p.stop(term_timeout=45), 6)
        finally:
            if not p.exited:
                p._reader.kill()
                p.expedite_stop()
                await p.stop(term_timeout=.1)

    try:
        asyncio.run(run())
        files = glob.glob(str(tmp_path / 'videos' / '*' / '*.mp4'))
        assert sum(_count(f, 'v:0') for f in files) == _count(source, 'v:0')
    finally:
        storage.shutdown()


def test_successor_releases_predecessor_once_writer_ready(tmp_path):
    """交接完成后后继不能再引用前代：否则每代引用上一代，重推 N 次就留 N 代对象。"""
    import gc
    import weakref

    class Old:
        exited = True

    async def run():
        old = Old()
        ref = weakref.ref(old)
        pipeline = RecordingPipeline(
            channel_id="test", rtmp_url="unused", root=str(tmp_path),
            segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048,
            writer_ready=lambda old=old: old.exited)
        del old
        pipeline.gate.pop = lambda: None
        pipeline._input_done = True
        await asyncio.wait_for(pipeline._write_loop(), .5)
        assert pipeline._writer_ready is None
        assert pipeline.stats()["waitingPreviousWriter"] is False
        gc.collect()
        assert ref() is None

    asyncio.run(run())


def test_input_stopped_reflects_stop_input(tmp_path):
    pipeline = RecordingPipeline(channel_id="test", rtmp_url="unused", root=str(tmp_path),
                                 segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048)
    assert pipeline.input_stopped is False
    pipeline.stop_input()
    assert pipeline.input_stopped is True


def test_intentionally_stopped_successor_is_not_counted_as_failure(tmp_path):
    """交接期间再次重推/停用只停了后继的输入，它随后正常结束不是故障：不计失败、不退避。"""
    sup, storage, _, index = _build(tmp_path, online=True)

    async def run():
        import time
        successor = FakePipeline()
        successor.input_stopped = True
        successor.returncode = 0
        successor.exited = True
        state = sup.state_of("ch1")
        state.proc, state.state = successor, "recording"
        before = time.time()
        await sup._tick()
        assert state.failures == 0
        assert state.next_attempt_ts <= before
        assert "后重试" not in state.detail
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_unexpected_pipeline_end_still_counts_as_failure(tmp_path):
    sup, storage, _, index = _build(tmp_path, online=True)

    async def run():
        ended = FakePipeline()
        ended.returncode = 1
        ended.exited = True
        state = sup.state_of("ch1")
        state.proc, state.state = ended, "recording"
        await sup._tick()
        assert state.failures == 1
        assert "后重试" in state.detail
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()


def test_quick_failures_back_off_progressively_until_pipeline_runs_stably(tmp_path):
    """源已不出数据但仍被当作在线时，管线拉起后很快失败：失败计数不能在拉起时
    清零，否则退避永远停在第一档、每十几秒空转重启一次。稳定运行一段时间后才清零。"""
    import time
    from recorder.supervisor import BACKOFF_STEPS, STABLE_RUN_SEC

    sup, storage, channel, index = _build(tmp_path, online=True)
    channel.update(codec="h264")

    async def run():
        state = sup.state_of("ch1")
        spawned = []

        async def fake_spawn(ch, st, root, segment_seconds, caps):
            p = FakePipeline()
            spawned.append(p)
            st.proc, st.state, st.started_at = p, "recording", time.time()

        sup._spawn = fake_spawn
        for expected in (1, 2, 3):
            state.next_attempt_ts = 0.0
            await sup._tick()                     # 拉起
            assert state.proc is spawned[-1]
            state.proc.returncode, state.proc.exited = 1, True
            before = time.time()
            await sup._tick()                     # 很快失败
            assert state.failures == expected
            assert state.next_attempt_ts >= before + BACKOFF_STEPS[expected - 1] - 0.5

        # 稳定运行超过阈值后清零
        state.next_attempt_ts = 0.0
        await sup._tick()
        state.started_at = time.time() - STABLE_RUN_SEC - 1
        await sup._tick()
        assert state.failures == 0
        await sup.shutdown()

    try:
        asyncio.run(run())
    finally:
        index.close()
        storage.io.shutdown()
