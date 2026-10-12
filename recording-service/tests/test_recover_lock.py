"""等待恢复锁有界，但绝不能释放另一恢复协程仍持有的锁。"""
import asyncio
from unittest.mock import MagicMock

from recorder.config import SmbConfig, StorageConfig
from recorder.storage import StorageManager


def test_recover_preserves_held_lock(tmp_path):
    sm = StorageManager()
    smb = SmbConfig(host="10.0.0.1", share="wanglei", path="AI/videos",
                    username="u", password="p", smbVersion="3.0")
    cfg = StorageConfig(kind="smb", smb=smb)

    async def run():
        # 模拟悬挂的旧恢复协程：锁拿着不放
        await sm._recover_lock.acquire()
        sm._umount = MagicMock()
        sm._mount_smb_sync = MagicMock(return_value="3.0")

        t0 = asyncio.get_event_loop().time()
        ok = await sm.try_recover(cfg)
        elapsed = asyncio.get_event_loop().time() - t0
        return ok, elapsed

    ok, elapsed = asyncio.run(run())
    sm.io.shutdown()

    assert ok is False
    assert 4.5 < elapsed < 8  # 等满 5s 接管预算，而不是永远挂着
    assert sm._recover_lock.locked() is True
    sm._recover_lock.release()
    sm._umount.assert_not_called()
    sm._mount_smb_sync.assert_not_called()
