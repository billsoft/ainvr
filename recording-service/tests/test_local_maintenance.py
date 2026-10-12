import asyncio
import threading

import pytest

from recorder.storage import StorageManager
from recorder.storage_io import StorageIOError


def test_slow_local_maintenance_is_bounded_and_does_not_stop_writers():
    storage = StorageManager()
    storage.status.kind = 'local'
    storage.status.healthy = True
    release = threading.Event()
    calls = []

    def blocked():
        calls.append('first')
        release.wait(5)

    async def scenario():
        with pytest.raises(StorageIOError):
            await storage.maintenance_io.run(blocked, timeout=0.02, op='quota-unlink')
        assert storage.status.healthy
        assert not storage.io.tripped
        # A timed-out syscall still exists: reject, never queue replacements.
        for _ in range(5):
            with pytest.raises(StorageIOError):
                await storage.maintenance_io.run(calls.append, 'queued', timeout=0.02)
        assert await storage.io.run(lambda: 'writer', timeout=0.1) == 'writer'
        assert calls == ['first']
        release.set()
        for _ in range(100):
            if not storage.maintenance_io.snapshot()['pending']:
                break
            await asyncio.sleep(0.001)
        assert await storage.maintenance_io.run(lambda: 'recovered', timeout=0.1) == 'recovered'

    try:
        asyncio.run(scenario())
    finally:
        release.set()
        storage.shutdown()


def test_nas_maintenance_retains_existing_circuit_protection():
    storage = StorageManager()
    storage.status.kind = 'smb'
    try:
        assert storage.maintenance_io is storage.io
    finally:
        storage.shutdown()


def test_short_maintenance_overlap_waits_instead_of_starving_cleanup():
    storage = StorageManager()
    release = threading.Event()

    async def scenario():
        first = asyncio.create_task(storage.maintenance_io.run(release.wait, 1, timeout=1))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(storage.maintenance_io.run(lambda: 'cleanup', timeout=1))
        await asyncio.sleep(0.01)
        release.set()
        assert await first
        assert await second == 'cleanup'

    try:
        asyncio.run(scenario())
    finally:
        release.set()
        storage.shutdown()
