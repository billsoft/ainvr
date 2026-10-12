"""AINVR: real SQLite statement failures must not remove a configured quota gate."""
import asyncio
import sqlite3
import time

import pytest

from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager, StorageError

MIB = 1024 ** 2


@pytest.fixture
def resources(tmp_path):
    store = ConfigStore(str(tmp_path / 'config.json'))
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    storage = StorageManager()
    root = tmp_path / 'videos'
    root.mkdir()
    storage.status.root = str(root)
    storage.status.kind = 'local'
    storage.status.healthy = True
    store.mutate().recording.quota = QuotaConfig(mode='gb', gb=1, onFull='overwrite')
    store.save()
    store.commit()
    try:
        yield store, index, storage, root
    finally:
        allow_all(index)
        storage.shutdown()
        index.close()


def add(index, root, name, size=10):
    path = root / (name + '.mp4')
    with path.open('xb') as file:
        file.truncate(size * MIB)  # Sparse unit fixture; allocated SSD tests are separate.
    start = int(time.time() * 1000) - 10 * 86_400_000
    index.upsert_segment({'id': name, 'channelId': name, 'channelName': name,
        'streamName': name, 'startTs': start, 'endTs': start + 10_000,
        'durationMs': 10_000, 'sizeBytes': size * MIB, 'codec': 'h264',
        'storage': 'local', 'relPath': path.name, 'complete': True})
    return path


def block_reads(index):
    index.conn.set_authorizer(lambda action, *rest:
        sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ else sqlite3.SQLITE_OK)


def allow_all(index):
    # Use an allowing callback to restore statements on the board's Python 3.10.
    index.conn.set_authorizer(lambda *args: sqlite3.SQLITE_OK)


@pytest.mark.parametrize('policy', ['stop', 'overwrite'])
@pytest.mark.parametrize('already_paused', [False, True])
def test_failed_usage_read_pauses_until_verified_read(resources, policy, already_paused):
    store, index, storage, root = resources
    store.mutate().recording.quota.onFull = policy
    store.save()
    store.commit()
    path = add(index, root, 'one')
    storage.status.quota_stopped = already_paused
    block_reads(index)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped and storage.status.healthy
    assert '索引' in storage.status.message
    with pytest.raises(StorageError, match='索引'):
        storage.active_root()
    assert path.exists()
    allow_all(index)
    assert index.used_bytes('local') == 10 * MIB
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert not storage.status.quota_stopped and storage.status.message == ''
    assert storage.active_root()[0] == str(root)


def test_candidate_query_failure_preserves_files_and_recovers(resources, monkeypatch):
    store, index, storage, root = resources
    paths = [add(index, root, name, 600) for name in ('a', 'b')]
    original = index.oldest_segments

    def failed_candidates(*args, **kwargs):
        block_reads(index)
        try:
            return original(*args, **kwargs)
        finally:
            allow_all(index)

    monkeypatch.setattr(index, 'oldest_segments', failed_candidates)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped and storage.status.healthy
    assert all(p.exists() for p in paths)
    monkeypatch.setattr(index, 'oldest_segments', original)
    assert len(index.all_segments()) == 2
    assert asyncio.run(enforcer.enforce('local')) == 1
    assert sum(p.exists() for p in paths) == 1
    assert not storage.status.quota_stopped


def test_index_delete_failure_does_not_report_committed_cleanup(resources):
    store, index, storage, root = resources
    paths = [add(index, root, name, 600) for name in ('a', 'b')]
    index.conn.set_authorizer(lambda action, table, *rest:
        sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_DELETE and table == 'segments'
        else sqlite3.SQLITE_OK)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped and storage.status.healthy
    assert sum(p.exists() for p in paths) == 1  # unlink succeeded, index removal failed.
    allow_all(index)
    assert len(index.all_segments()) == 2
    assert index.meta_get('overwrittenSegments') == 0
    # The original FileNotFound handling reconciles the stale row on retry.
    assert asyncio.run(enforcer.enforce('local')) == 1
    assert len(index.all_segments()) == 1
    assert not storage.status.quota_stopped


def test_index_failure_does_not_overwrite_other_storage_diagnostics(resources):
    store, index, storage, root = resources
    storage.status.message = '存储连接故障，请等待恢复'
    storage.status.healthy = False
    block_reads(index)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped
    assert storage.status.message == '存储连接故障，请等待恢复'
    allow_all(index)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert not storage.status.quota_stopped and not storage.status.healthy
    assert storage.status.message == '存储连接故障，请等待恢复'


def test_disabling_limit_releases_quota_without_reading_broken_index(resources):
    store, index, storage, root = resources
    storage.status.quota_stopped = True
    storage.status.message = '配额暂停：索引暂不可用'
    store.mutate().recording.quota.gb = None
    store.save()
    store.commit()
    block_reads(index)
    assert asyncio.run(QuotaEnforcer(store, index, storage).enforce('local')) == 0
    assert not storage.status.quota_stopped
    assert storage.active_root()[0] == str(root)


def test_missing_percent_capacity_preserves_existing_pause(resources):
    store, index, storage, root = resources
    store.mutate().recording.quota = QuotaConfig(mode='percent', percent=50)
    store.save()
    store.commit()
    storage.status.quota_stopped = True
    storage.status.message = '配额暂停：已有容量约束'
    block_reads(index)
    assert asyncio.run(QuotaEnforcer(store, index, storage).enforce('local')) == 0
    assert storage.status.quota_stopped
    assert storage.status.message == '配额暂停：已有容量约束'


def test_stale_generation_cannot_resume_new_storage_view(resources, monkeypatch):
    store, index, storage, root = resources
    storage.status.quota_stopped = True
    original = index.run

    async def changed(operation, *args, **kwargs):
        value = await original(operation, *args, **kwargs)
        storage.io.reset('isolated test changes storage generation')
        return value

    monkeypatch.setattr(index, 'run', changed)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped
    monkeypatch.setattr(index, 'run', original)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert not storage.status.quota_stopped


def test_negative_usage_is_not_treated_as_empty_storage(resources):
    store, index, storage, root = resources
    path = add(index, root, 'one')
    row = index.get('one')
    row['sizeBytes'] = -1
    index.upsert_segment(row)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert storage.status.quota_stopped and path.exists()
    row['sizeBytes'] = path.stat().st_size
    index.upsert_segment(row)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert not storage.status.quota_stopped


def test_metadata_write_failure_keeps_pause_until_verified_usage(resources):
    store, index, storage, root = resources
    paths = [add(index, root, name, 600) for name in ('a', 'b')]
    index.conn.set_authorizer(lambda action, table, *rest:
        sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_INSERT and table == 'meta'
        else sqlite3.SQLITE_OK)
    enforcer = QuotaEnforcer(store, index, storage)
    assert asyncio.run(enforcer.enforce('local')) == 1
    assert storage.status.quota_stopped and storage.status.healthy
    assert len(index.all_segments()) == sum(p.exists() for p in paths) == 1
    allow_all(index)
    assert asyncio.run(enforcer.enforce('local')) == 0
    assert not storage.status.quota_stopped


def test_old_generation_failure_cannot_pause_new_storage_view(resources, monkeypatch):
    store, index, storage, root = resources

    async def stale_failure(*args, **kwargs):
        storage.io.reset('isolated storage generation changes during query')
        raise sqlite3.DatabaseError('isolated old-generation failure')

    monkeypatch.setattr(index, 'run', stale_failure)
    assert asyncio.run(QuotaEnforcer(store, index, storage).enforce('local')) == 0
    assert not storage.status.quota_stopped and storage.status.message == ''


def test_cancellation_is_not_misreported_as_index_failure(resources, monkeypatch):
    store, index, storage, root = resources

    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(index, 'run', cancelled)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(QuotaEnforcer(store, index, storage).enforce('local'))
    assert not storage.status.quota_stopped
