import asyncio
import threading

import pytest

from recorder.storage import StorageManager, StorageError


def test_timeout_keeps_management_fence_until_worker_finishes():
    async def check():
        manager = StorageManager()
        release = threading.Event()
        try:
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(manager._management(release.wait, 2), 0.02)
            assert manager.io.tripped
            with pytest.raises(StorageError, match="仍未结束"):
                await manager._management(lambda: None)
            release.set()
            await asyncio.wrap_future(manager._mgmt_pending)
            assert await manager._management(lambda: 42) == 42
        finally:
            release.set()
            manager.shutdown()
    asyncio.run(check())
