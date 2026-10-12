"""Blocking filesystem probes. Call only through an isolated I/O lane."""
import os
import tempfile
import time
from .storage_types import StorageError

RECYCLE_DIRS = ("@Recycle", "#recycle", ".recycle")

def _probe_sync(root: str, size: int) -> float:
    """写 + fsync + 读回 + 删除，返回 MB/s；失败抛 OSError/StorageError。"""
    os.makedirs(root, exist_ok=True)
    probe = os.path.join(root, f".recorder-probe-{os.getpid()}-{int(time.time()*1000)}")
    chunk = b"t" * (1024 * 1024)
    mb = max(1, size // (1024 * 1024))
    t0 = time.monotonic()
    try:
        with open(probe, "wb") as f:
            for _ in range(mb):
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        with open(probe, "rb") as f:
            got = f.read(16)
        if got != chunk[:16]:
            raise StorageError("共享可写但读回校验失败")
        elapsed = max(0.001, time.monotonic() - t0)
        return (mb * 1024 * 1024) / 1024 / 1024 / elapsed
    finally:
        try:
            os.unlink(probe)  # 同一线程内收尾；卡了随线程隔离，不波及事件循环
        except OSError:
            pass


def _local_probe_sync(root: str) -> None:
    """本机目录可建可写可删检查。"""
    os.makedirs(root, exist_ok=True)
    probe = os.path.join(root, ".recorder-probe")
    with open(probe, "wb") as f:
        f.write(b"t")
    os.unlink(probe)


def _find_recycle_dir(mount_root: str) -> str | None:
    for name in RECYCLE_DIRS:
        if os.path.isdir(os.path.join(mount_root, name)):
            return name
    return None


