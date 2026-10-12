import asyncio
import threading
import time

from recorder.index import SegmentIndex
from recorder.supervisor import Supervisor, GLOBAL_BUFFER_BYTES
from types import SimpleNamespace


def test_slow_database_does_not_block_loop_and_cancel_keeps_order(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    entered, release = threading.Event(), threading.Event()
    order = []

    def blocked():
        entered.set()
        release.wait(2)
        order.append('first')

    async def check():
        first = asyncio.create_task(index.run(blocked))
        while not entered.is_set():
            await asyncio.sleep(.001)
        first.cancel()
        second = asyncio.create_task(index.run(lambda: order.append('second')))
        await asyncio.sleep(.02)
        assert not second.done()
        release.set()
        await asyncio.gather(first, return_exceptions=True)
        await second
        assert order == ['first', 'second']

    try:
        asyncio.run(check())
    finally:
        release.set()
        index.close()


def test_drop_is_visible_while_database_is_blocked(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    with index._lock:
        index.record_drop({'channelId': 'a', 'startTs': now-6000,
                           'endTs': now, 'droppedMs': 6000, 'reason': 'backlog'})
        assert index.recent_drops(now-3600000) == {'a': 6000}
    index.close()
    restored = SegmentIndex(str(tmp_path / 's.db'))
    assert restored.recent_drops(now-3600000) == {'a': 6000}
    restored.close()


def test_buffer_reservations_include_backlog_after_rebalance():
    sup = Supervisor.__new__(Supervisor)
    sup.retiring = {}
    sup.orphans = {}
    gate = SimpleNamespace(hard_cap=512 << 20, queued_bytes=1200 << 20)
    sup.states = {'a': SimpleNamespace(proc=SimpleNamespace(gate=gate))}
    assert not sup._buffer_available(512 << 20)
    gate.queued_bytes = 0
    assert sup._buffer_available(512 << 20)
    assert GLOBAL_BUFFER_BYTES == 1536 << 20


def test_quota_cleanup_keeps_last_hour_drop_history(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    index.add_drop_event({'channelId': 'a', 'startTs': now-600000,
                         'endTs': now-594000, 'droppedMs': 6000, 'reason': 'backlog'})
    index.conn.execute("INSERT INTO segments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ('s','a','a','a',now-300000,now-240000,60000,1,'h265',1,1,30,0,0,'local','',
         'a.mp4',1,now,None,None))
    index.conn.commit()
    index.prune_drop_events()
    assert index.dropped_ms_since(now-3600000) == {'a': 6000}
    index.close()


def test_shutdown_retries_a_lost_cancellation():
    from recorder.app import stop_background_tasks
    async def check():
        started = asyncio.Event()
        async def race():
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                pass
            await asyncio.Future()
        task = asyncio.create_task(race(), name='cancellation-race')
        await started.wait()
        await asyncio.wait_for(stop_background_tasks([task]), 4)
        assert task.cancelled()
    asyncio.run(check())


def test_late_scanner_update_cannot_resurrect_quota_deleted_row(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    row = dict(id='s', channelId='a', channelName='a', streamName='a',
               startTs=1000, endTs=61000, durationMs=60000, sizeBytes=100,
               codec='h265', storage='local', relPath='a.mp4', complete=True)
    index.upsert_segment(row)
    index.delete('s')
    index.upsert_segment(row, require_existing_id='s')
    assert index.get('s') is None
    index.close()
