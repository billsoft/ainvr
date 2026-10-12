import asyncio
import threading

import pytest

from recorder.storage_io import IsolatedIO, StorageIOError


def test_queued_cancellation_is_storage_error_and_old_timeout_cannot_trip_new_pool():
    async def run():
        io = IsolatedIO()
        release = threading.Event()
        entered = threading.Event()
        def blocked():
            entered.set()
            release.wait(2)
        first = asyncio.create_task(io.run(blocked, timeout=.1))
        try:
            while not entered.is_set():
                await asyncio.sleep(.001)
            queued = asyncio.create_task(io.run(lambda: None, timeout=1))
            await asyncio.sleep(.01)
            io.reset('test recovery')
            with pytest.raises(StorageIOError):
                await queued
            with pytest.raises(StorageIOError):
                await first
            assert not io.tripped
            assert await io.run(lambda: 42, timeout=1) == 42
        finally:
            release.set()
            io.shutdown()
    asyncio.run(run())
