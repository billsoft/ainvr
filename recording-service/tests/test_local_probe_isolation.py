import asyncio
import threading
import time

import pytest

from recorder.storage import StorageManager
import recorder.storage as storage


def test_slow_local_probe_keeps_recording_and_reuses_one_worker(tmp_path, monkeypatch):
    sm = StorageManager()
    sm.status.root = str(tmp_path)
    sm.status.kind = 'local'
    sm.status.healthy = True
    release = threading.Event()
    calls = []
    monkeypatch.setattr(storage, 'LOCAL_PROBE_TIMEOUT', 0.03)

    def stats(root):
        calls.append(root)
        release.wait(2)
        return 100 * 1024**3, 50 * 1024**3

    monkeypatch.setattr(sm, 'fs_stats', stats)

    async def run():
        assert await sm.watchdog_check()
        assert await sm.watchdog_check()
        assert sm.status.healthy
        assert not sm.io.tripped
        assert len(calls) == 1
        assert '延迟' in sm.status.warning
        release.set()
        await asyncio.sleep(0.05)
        assert await sm.watchdog_check()
        assert not sm.status.warning

    try:
        asyncio.run(run())
    finally:
        release.set()
        sm.shutdown()


def test_local_readonly_error_still_stops_recording(tmp_path, monkeypatch):
    sm = StorageManager()
    sm.status.root = str(tmp_path)
    sm.status.healthy = True
    sm.status.kind = 'local'
    monkeypatch.setattr(sm, 'fs_stats', lambda root: (100 * 1024**3, 50 * 1024**3))
    def readonly(root):
        raise OSError(30, 'Read-only file system')
    monkeypatch.setattr(storage, '_local_probe_sync', readonly)
    try:
        assert not asyncio.run(sm.watchdog_check())
        assert not sm.status.healthy
        assert 'NAS' not in sm.status.message
    finally:
        sm.shutdown()


def test_unexpected_probe_error_is_retired_and_next_probe_recovers(tmp_path, monkeypatch):
    sm = StorageManager()
    sm.status.root = str(tmp_path)
    sm.status.kind = 'local'
    sm.status.healthy = True
    calls = []

    def stats(root):
        calls.append(root)
        if len(calls) == 1:
            raise ValueError('unexpected probe result')
        return 100 * 1024**3, 50 * 1024**3

    monkeypatch.setattr(sm, 'fs_stats', stats)
    monkeypatch.setattr(storage, '_local_probe_sync', lambda root: None)
    try:
        assert not asyncio.run(sm.watchdog_check())
        assert sm._local_probe_pending is None
        assert asyncio.run(sm.watchdog_check())
        assert len(calls) == 2
    finally:
        sm.shutdown()
