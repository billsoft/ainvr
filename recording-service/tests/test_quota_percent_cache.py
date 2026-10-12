"""percent 配额只信任容量缓存：缓存缺失/过期时本轮跳过清理与停录，
绝不在配额轮直连 statvfs（卡死 NAS 上会 D 住工作线程），也不误判
onFull=stop。"""
import asyncio
import os
import time

from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager


def _setup(tmp_path, quota: QuotaConfig):
    store = ConfigStore(str(tmp_path / "config.json"))
    index = SegmentIndex(str(tmp_path / "segments.db"))
    sm = StorageManager()
    root = str(tmp_path / "videos")
    os.makedirs(root, exist_ok=True)
    sm.status.root = root
    sm.status.kind = "local"
    sm.status.healthy = True
    cfg = store.mutate()
    cfg.recording.quota = quota
    store.save()
    store.commit()
    return store, index, sm, root


def _add_segment(index, root, cid, name, start_days_ago, size_mb):
    rel = f"20260901/{name}.mp4"
    abs_path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "wb") as f:
        f.truncate(size_mb * 1024 ** 2)
    start = int(time.time() * 1000) - start_days_ago * 86_400_000
    index.upsert_segment({
        "id": f"{cid}-{start}", "channelId": cid, "channelName": name,
        "streamName": name, "startTs": start, "endTs": start + 60_000,
        "durationMs": 60_000, "sizeBytes": size_mb * 1024 ** 2, "codec": "h264",
        "storage": "local", "relPath": rel, "complete": True,
    })


def test_percent_skips_when_capacity_cache_missing(tmp_path):
    # 合法的最低配额；容量未知时不能直连 NAS 或误停录。
    q = QuotaConfig(mode="percent", percent=50, onFull="stop")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "a", 5, 400)

    assert sm.capacity_cached() is None
    deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))

    sm.io.shutdown()
    assert deleted == 0
    # 关键：容量未知时绝不能误触发停录
    assert sm.status.quota_stopped is False
    assert sm.status.healthy is True
    # 物理文件与索引都不动
    assert len(index.all_segments()) == 1


def test_percent_runs_after_cache_refreshed(tmp_path):
    # 容量缓存就位后，percent 模式恢复正常判定。
    q = QuotaConfig(mode="percent", percent=99, onFull="stop")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "a", 5, 1)
    sm._update_cap_cache(root)
    assert sm.capacity_cached() is not None

    deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))

    sm.io.shutdown()
    assert deleted == 0
    assert sm.status.quota_stopped is False


def test_stale_cache_treated_as_missing(tmp_path):
    q = QuotaConfig(mode="percent", percent=50, onFull="stop")
    store, index, sm, root = _setup(tmp_path, q)
    sm._update_cap_cache(root)
    # 把缓存时间戳改老
    ts, total, avail = sm._cap_cache
    sm._cap_cache = (ts - 10_000, total, avail)
    assert sm.capacity_cached() is None
    sm.io.shutdown()
