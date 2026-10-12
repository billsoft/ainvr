#!/usr/bin/env python3
"""AINVR: exercise the original quota enforcer on isolated SSD byte fixtures.

Each case uses a private ConfigStore, SQLite index, and StorageManager. Files
reserve real blocks with posix_fallocate; they are not encoded videos. Recorded
timestamps are synthetic to test retention boundaries without waiting days.
Production configuration, indexes and recordings are never opened for writing.
"""
import asyncio
import datetime
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'recording-service/src'))
from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.playback_protection import PlaybackProtection
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager, StorageError
from recorder.writer_protection import acquire, release

MIB = 1024 ** 2
GIB = 1024 ** 3
DAY = 86_400_000
SSD = Path('/mnt/ainvr-ssd')


def can_write(storage):
    try:
        storage.active_root()
        return True
    except StorageError:
        return False


async def exercise(work, name, sizes, ages, protection=None):
    case = work / name
    case.mkdir()
    videos = case / 'fixtures'
    videos.mkdir()
    store = ConfigStore(str(case / 'config.json'))
    index = SegmentIndex(str(case / 'segments.db'))
    storage = StorageManager()
    storage.status.root = str(videos)
    storage.status.kind = 'local'
    storage.status.healthy = True
    quota = QuotaConfig(mode='gb', gb=1,
                        onFull='stop' if name == 'stop_recovery' else 'overwrite',
                        minRetentionDays=30 if name == 'retention' else None)
    cfg = store.mutate()
    cfg.recording.quota = quota
    store.save()
    store.commit()
    playback = PlaybackProtection()
    enforcer = QuotaEnforcer(store, index, storage, playback)
    now = int(time.time() * 1000)
    paths = []
    token = None
    try:
        for number, (size, age) in enumerate(zip(sizes, ages)):
            path = videos / (str(number) + '.quota-fixture')
            assert path.resolve().parent == videos.resolve()
            paths.append(path)
            with path.open('xb') as file:
                os.posix_fallocate(file.fileno(), 0, size * MIB)
                os.fsync(file.fileno())
            st = path.stat()
            assert st.st_size == size * MIB and st.st_blocks * 512 >= st.st_size
            index.upsert_segment({
                'id': name + '-' + str(number), 'channelId': 'quota-fixture',
                'channelName': 'AINVR isolated quota fixture', 'streamName': 'fixture',
                'startTs': now - age, 'endTs': now - age + 10_000,
                'durationMs': 10_000, 'sizeBytes': st.st_size, 'codec': 'fixture',
                'storage': 'smb' if name == 'storage_partition' and number == 0 else 'local',
                'relPath': path.name,
                'complete': not (name == 'incomplete' and number == 0),
            })
        if protection == 'writer':
            token = acquire(str(paths[0]))
        elif protection == 'playback':
            assert playback.touch(name + '-0')
        used_before = index.used_bytes('local')
        assert used_before > GIB, 'Every quota case must actually exceed the cap'
        allocated_before = sum(p.stat().st_blocks * 512 for p in paths)
        deleted = await asyncio.wait_for(enforcer.enforce('local'), timeout=25)
        remaining = [p.name for p in paths if p.exists()]
        allocated_after = sum(p.stat().st_blocks * 512 for p in paths if p.exists())
        result = {'case': name, 'used_before': used_before,
                  'used_after': index.used_bytes('local'), 'deleted': deleted,
                  'allocated_before': allocated_before,
                  'allocated_after': allocated_after,
                  'released_fixture_blocks': allocated_before - allocated_after,
                  'remaining': remaining, 'quota_stopped': storage.status.quota_stopped,
                  'storage_healthy': storage.status.healthy,
                  'writing_allowed_after': can_write(storage)}
        if name in ('retention', 'recent'):
            assert deleted == 0 and len(remaining) == len(paths)
            assert storage.status.quota_stopped and not can_write(storage)
            result['protected_files_preserved'] = True
            result['hard_cap_enforced'] = not can_write(storage)
            if name == 'retention':
                store.mutate().recording.quota.minRetentionDays = None
                store.save()
                store.commit()
            else:
                for row in index.all_segments():
                    row['startTs'] -= 120_000
                    row['endTs'] -= 120_000
                    index.upsert_segment(row)
            assert await enforcer.enforce('local') == 1
            assert not storage.status.quota_stopped and can_write(storage)
            assert storage.status.message == ''
            result['resumed_when_safe_eviction_possible'] = True
        elif name == 'stop_recovery':
            assert deleted == 0 and storage.status.quota_stopped
            assert storage.status.healthy and not can_write(storage)
            cfg = store.mutate()
            cfg.recording.quota.gb = 2
            store.save()
            store.commit()
            assert await enforcer.enforce('local') == 0
            assert not storage.status.quota_stopped and can_write(storage)
            result['resumed_after_cap_raise'] = True
        else:
            expected_removed = '1.quota-fixture' if protection or name == 'incomplete' or name == 'storage_partition' else '0.quota-fixture'
            assert deleted == 1 and expected_removed not in remaining
            assert index.used_bytes('local') <= int(GIB * 0.95)
            assert allocated_before > allocated_after
            assert index.meta_get('overwrittenSegments') == 1
            if protection or name in ('incomplete', 'storage_partition'):
                assert paths[0].exists() and index.get(name + '-0') is not None
            result['index_file_consistency_verified'] = True
        result['passed'] = True
        return result
    finally:
        if token is not None:
            release(str(paths[0]), token)
        storage.shutdown()
        index.close()
        # Exact paths created by this case only; no recursive cleanup.
        for path in paths:
            assert path.parent == videos and path.name.endswith('.quota-fixture')
            if path.exists():
                path.unlink()
        videos.rmdir()


async def main():
    if ROOT.resolve() != Path('/home/sunrise/ainvr') or not SSD.is_mount():
        raise SystemExit('Run on the authorized S100P with the AINVR SSD mounted')
    vfs = os.statvfs(SSD)
    if vfs.f_bavail * vfs.f_frsize < 5 * GIB:
        raise SystemExit('Require at least 5 GiB free for bounded allocation probes')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work = SSD / 'migration-tests' / ('quota-' + stamp)
    work.mkdir(parents=True, mode=0o700)
    assert work.resolve().is_relative_to(SSD.resolve() / 'migration-tests')
    results = []
    for name, sizes, ages, protection in [
        ('lru', [400] * 3, [10 * DAY, 9 * DAY, 8 * DAY], None),
        ('retention', [600] * 2, [2 * DAY, DAY], None),
        ('stop_recovery', [600] * 2, [5 * DAY, 4 * DAY], None),
        ('writer', [400] * 3, [10 * DAY, 9 * DAY, 8 * DAY], 'writer'),
        ('playback', [400] * 3, [10 * DAY, 9 * DAY, 8 * DAY], 'playback'),
        ('incomplete', [400] * 3, [10 * DAY, 9 * DAY, 8 * DAY], None),
        ('recent', [400] * 3, [50_000, 40_000, 30_000], None),
        ('storage_partition', [600] * 3, [20 * DAY, 10 * DAY, 9 * DAY], None),
    ]:
        results.append(await exercise(work, name, sizes, ages, protection))
    report = {'checked_at': datetime.datetime.now().isoformat(),
              'scope': 'Original quota code, isolated allocated SSD fixtures; not media or NAS acceptance',
              'working_directory': str(work), 'fixtures_released': True,
              'production_configuration_changed': False,
              'tests_passed': len(results), 'cases': results,
              'unresolved_hard_cap_cases': [r['case'] for r in results
                  if r.get('hard_cap_enforced') is False]}
    destination = ROOT / 'test/results' / ('ssd-quota-' + stamp + '.json')
    with destination.open('x') as output:
        json.dump(report, output, indent=2)
    print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
