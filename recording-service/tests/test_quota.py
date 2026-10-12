import asyncio
import os
import time

from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager

MB = 1024 ** 2
GB = 1024 ** 3
DAY = 86_400_000


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
        f.truncate(size_mb * MB)
    start = int(time.time() * 1000) - start_days_ago * DAY
    index.upsert_segment({
        "id": f"{cid}-{start}", "channelId": cid, "channelName": name,
        "streamName": name, "startTs": start, "endTs": start + 60_000,
        "durationMs": 60_000, "sizeBytes": size_mb * MB, "codec": "h264",
        "storage": "local", "relPath": rel, "complete": True,
    })


def test_quota_does_not_delete_other_storage(tmp_path):
    store, index, sm, root = _setup(tmp_path, QuotaConfig(mode='gb', gb=1, onFull='overwrite'))
    _add_segment(index, root, 'other', 'nas', 20, 400)
    nas = index.all_segments()[0]
    nas['storage'] = 'smb'
    index.upsert_segment(nas)
    _add_segment(index, root, 'c1', 'local1', 10, 600)
    _add_segment(index, root, 'c2', 'local2', 9, 600)
    try:
        assert asyncio.run(QuotaEnforcer(store, index, sm).enforce('local')) == 1
        assert index.get(nas['id']) is not None
        assert os.path.exists(os.path.join(root, nas['relPath']))
    finally:
        sm.io.shutdown()
        index.close()


def test_lru_overwrite_deletes_oldest_to_hysteresis(tmp_path):
    # 1GB 上限，3×400MB = 1.2GB → 删最旧 1 段（剩 800MB < 0.95GB）
    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "old", 10, 400)
    _add_segment(index, root, "c1", "mid", 9, 400)
    _add_segment(index, root, "c1", "new", 8, 400)

    deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))
    sm.io.shutdown()
    assert deleted == 1
    remaining = index.all_segments()
    assert len(remaining) == 2
    assert not os.path.exists(os.path.join(root, "20260901/old.mp4"))
    assert index.meta_get("overwrittenSegments") == 1


def test_min_retention_blocks_deletion(tmp_path):
    # 要求至少保留 30 天：超限时没有可删段，overwrite 也不能动近期文件
    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite", minRetentionDays=30)
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "a", 2, 600)
    _add_segment(index, root, "c1", "b", 1, 600)
    enforcer = QuotaEnforcer(store, index, sm)
    try:
        assert index.used_bytes("local") > GB
        deleted = asyncio.run(enforcer.enforce("local"))
        assert deleted == 0
        assert len(index.all_segments()) == 2
        assert sm.status.quota_stopped and sm.status.healthy
        import pytest
        from recorder.storage import StorageError
        with pytest.raises(StorageError):
            sm.active_root()
        # Removing the retention constraint permits safe eviction and resumption.
        store.mutate().recording.quota.minRetentionDays = None
        store.save()
        store.commit()
        assert asyncio.run(enforcer.enforce("local")) == 1
        assert not sm.status.quota_stopped
        assert sm.active_root()[0] == root
        assert sm.status.message == ""
    finally:
        sm.shutdown()
        index.close()


def test_recent_segments_pause_and_resume_when_old_enough(tmp_path):
    store, index, sm, root = _setup(
        tmp_path, QuotaConfig(mode="gb", gb=1, onFull="overwrite"))
    _add_segment(index, root, "c1", "a", 0, 600)
    _add_segment(index, root, "c2", "b", 0, 600)
    enforcer = QuotaEnforcer(store, index, sm)
    try:
        assert index.used_bytes("local") > GB
        assert asyncio.run(enforcer.enforce("local")) == 0
        assert sm.status.quota_stopped and sm.status.healthy
        assert len(index.all_segments()) == 2
        # Advance fixture age, rather than sleeping or changing the system clock.
        for row in index.all_segments():
            row["startTs"] -= 120_000
            row["endTs"] -= 120_000
            index.upsert_segment(row)
        assert asyncio.run(enforcer.enforce("local")) == 1
        assert not sm.status.quota_stopped
        assert sm.active_root()[0] == root
    finally:
        sm.shutdown()
        index.close()


def test_stop_policy_marks_unhealthy(tmp_path):
    q = QuotaConfig(mode="gb", gb=1, onFull="stop")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "a", 5, 600)
    _add_segment(index, root, "c1", "b", 4, 600)
    deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))
    sm.io.shutdown()
    assert deleted == 0
    assert sm.status.quota_stopped is True
    assert sm.status.healthy is True  # 连通性仍健康，仅配额停录
    import pytest
    from recorder.storage import StorageError
    with pytest.raises(StorageError):
        sm.active_root()
    assert "配额" in sm.status.message
