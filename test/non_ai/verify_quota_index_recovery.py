#!/usr/bin/env python3
"""AINVR: quota/index recovery with allocated SSD files and real SQLite errors.

Run on the authorized board using its production Python environment:
  .venv/bin/python test/non_ai/verify_quota_index_recovery.py

Each case has a private ConfigStore, SegmentIndex and StorageManager. SQLite's
authorizer injects statement failures without damaging the database. The byte
fixtures reserve real SSD blocks, are not videos, and have synthetic timestamps.
This verifies quota behavior, not a physical SSD failure or an SMB/NAS outage.
Only this run's exact fixture files are released; small indexes/results remain.
"""
import asyncio
import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'recording-service/src'))
from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager, StorageError

SSD = Path('/mnt/ainvr-ssd')
MIB = 1024 ** 2


def allowed(storage):
    try:
        storage.active_root()
        return True
    except StorageError:
        return False


async def exercise(work, name):
    case = work / name
    videos = case / 'fixtures'
    videos.mkdir(parents=True)
    store = ConfigStore(str(case / 'config.json'))
    index = SegmentIndex(str(case / 'segments.db'))
    storage = StorageManager()
    storage.status.root = str(videos)
    storage.status.kind = 'local'
    storage.status.healthy = True
    policy = 'stop' if name == 'read_stop_full' else 'overwrite'
    store.mutate().recording.quota = QuotaConfig(mode='gb', gb=1, onFull=policy)
    store.save()
    store.commit()
    enforcer = QuotaEnforcer(store, index, storage)
    paths = []
    original_candidates = index.oldest_segments
    result = {'case': name, 'policy': policy, 'passed': False}
    try:
        sizes = [4, 4] if name == 'read_overwrite_under' else [600, 600]
        for number, size in enumerate(sizes):
            path = videos / (str(number) + '.quota-byte-fixture')
            paths.append(path)
            with path.open('xb') as file:
                os.posix_fallocate(file.fileno(), 0, size * MIB)
                os.fsync(file.fileno())
            stat = path.stat()
            assert stat.st_blocks * 512 >= stat.st_size == size * MIB
            start = int(time.time() * 1000) - (10 - number) * 86_400_000
            index.upsert_segment({'id': str(number), 'channelId': 'isolated-quota',
                'channelName': 'AINVR SQLite recovery fixture', 'streamName': 'fixture',
                'startTs': start, 'endTs': start + 10_000, 'durationMs': 10_000,
                'sizeBytes': stat.st_size, 'codec': 'fixture', 'storage': 'local',
                'relPath': path.name, 'complete': True})
        used = index.used_bytes('local')
        allocated = sum(p.stat().st_blocks * 512 for p in paths)
        if name == 'read_stop_full':
            assert await enforcer.enforce('local') == 0
            assert storage.status.quota_stopped
        deny_reads = lambda action, *rest: (
            sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ else sqlite3.SQLITE_OK)
        if name.startswith('read_'):
            index.conn.set_authorizer(deny_reads)
        elif name == 'candidates_overwrite':
            def broken_candidates(*args, **kwargs):
                index.conn.set_authorizer(deny_reads)
                try:
                    return original_candidates(*args, **kwargs)
                finally:
                    index.conn.set_authorizer(lambda *args: sqlite3.SQLITE_OK)
            index.oldest_segments = broken_candidates
        elif name == 'delete_overwrite':
            index.conn.set_authorizer(lambda action, table, *rest:
                sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_DELETE and table == 'segments'
                else sqlite3.SQLITE_OK)
        deleted = await asyncio.wait_for(enforcer.enforce('local'), timeout=25)
        assert deleted == 0 and storage.status.quota_stopped and storage.status.healthy
        assert not allowed(storage)
        remaining = sum(p.exists() for p in paths)
        assert remaining == (1 if name == 'delete_overwrite' else 2)
        result.update(used_before=used, allocated_before=allocated,
                      reported_deletions_during_failure=deleted,
                      files_during_failure=remaining, writing_blocked_during_failure=True,
                      storage_connectivity_preserved=True)
        index.conn.set_authorizer(lambda *args: sqlite3.SQLITE_OK)
        index.oldest_segments = original_candidates
        assert len(index.all_segments()) == 2
        assert index.meta_get('overwrittenSegments') == 0
        if policy == 'stop':
            assert await enforcer.enforce('local') == 0
            assert storage.status.quota_stopped and not allowed(storage)
            result['restored_index_still_over_cap_stopped'] = True
            store.mutate().recording.quota.gb = 2
            store.save()
            store.commit()
        recovered = await asyncio.wait_for(enforcer.enforce('local'), timeout=25)
        assert recovered == (0 if name.startswith('read_stop') or name.endswith('under') else 1)
        assert not storage.status.quota_stopped and allowed(storage)
        result.update(recovered_deletions=recovered, used_after=index.used_bytes('local'),
                      verified_read_before_resume=True, writing_restored_after_recovery=True,
                      files_after=sum(p.exists() for p in paths), passed=True)
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        index.conn.set_authorizer(lambda *args: sqlite3.SQLITE_OK)
        index.oldest_segments = original_candidates
        storage.shutdown()
        index.close()
        for path in paths:
            assert path.resolve().parent == videos.resolve()
            if path.exists():
                path.unlink()
    return result


def main():
    if ROOT != Path('/home/sunrise/ainvr') or not SSD.is_mount():
        raise SystemExit('Run in the authorized board workspace with its SSD mounted')
    if os.statvfs(SSD).f_bavail * os.statvfs(SSD).f_frsize < 5 * 1024 ** 3:
        raise SystemExit('Keep at least 5 GiB of SSD reserve')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work = SSD / 'test-scratch' / ('quota-index-' + stamp)
    work.mkdir(parents=True)
    names = ['read_stop_full', 'read_overwrite_full', 'read_overwrite_under',
             'candidates_overwrite', 'delete_overwrite']
    results = [asyncio.run(exercise(work, name)) for name in names]
    report = {'checked_at': datetime.datetime.now().isoformat(), 'cases': results,
              'passed': all(case['passed'] for case in results), 'scratch': str(work),
              'fixture_files_released': True, 'production_data_modified': False,
              'fault_scope': 'SQLite authorizer statement failures in isolated indexes',
              'media_scope': 'allocated byte fixtures; not encoded videos',
              'physical_storage_failure_verified': False, 'nas_outage_verified': False}
    result = ROOT / 'test/results' / ('quota-index-ssd-' + stamp + '.json')
    result.write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'result': str(result)}))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
