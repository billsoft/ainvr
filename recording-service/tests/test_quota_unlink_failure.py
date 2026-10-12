import asyncio
import os
import time
from unittest.mock import patch

from recorder.config import ConfigStore, QuotaConfig
from recorder.index import SegmentIndex
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageManager

MB = 1024 ** 2
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


def test_unlink_non_enoent_failure_keeps_index_row_for_retry(tmp_path):
    """2026-09-16 回归：os.unlink 因非 ENOENT 原因失败（比如 CIFS soft
    挂载瞬时 I/O 错误）时，索引行必须保留，不能被当成"已删除"计数——
    否则 scanner 会在下一轮把物理文件重新扫描回索引，enforce() 又删一次
    索引行，形成删除-复活死循环，空间从未真正释放。"""
    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "old", 10, 400)
    _add_segment(index, root, "c1", "mid", 9, 400)
    _add_segment(index, root, "c1", "new", 8, 400)

    with patch("recorder.quota.os.unlink", side_effect=OSError(5, "Input/output error")):
        deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))
    sm.io.shutdown()

    assert deleted == 0
    remaining = index.all_segments()
    assert len(remaining) == 3  # 一行都不能少
    # 物理文件本来就还在（mock 根本没真删），索引也还在 —— 状态一致，下轮可重试
    assert os.path.exists(os.path.join(root, "20260901/old.mp4"))
    assert index.meta_get("overwrittenSegments") in (None, 0)


def test_unlink_file_not_found_still_clears_index_row(tmp_path):
    """对照组：文件确实已经不在了（ENOENT/FileNotFoundError）时，索引行
    应该正常清掉，不能被上面那条修复误伤成"永远不删"。"""
    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "old", 10, 400)
    _add_segment(index, root, "c1", "mid", 9, 400)
    _add_segment(index, root, "c1", "new", 8, 400)
    # 手动把物理文件删掉，模拟"文件已经不存在"
    os.unlink(os.path.join(root, "20260901/old.mp4"))

    deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))
    sm.io.shutdown()

    assert deleted == 1
    assert len(index.all_segments()) == 2
    assert index.meta_get("overwrittenSegments") == 1


def test_stuck_unlink_trips_fast_and_keeps_remaining_rows(tmp_path):
    """2026-09-18 现场回归：某个 unlink 在内核 D 住时，必须按单文件短超时
    快速熔断（而不是把整条数据车道堵满 120s），本轮立即收尾，其余索引行
    全部保留，scanner/下轮配额对账。"""
    import recorder.quota as quota_mod

    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "old", 10, 400)
    _add_segment(index, root, "c1", "mid", 9, 400)
    _add_segment(index, root, "c1", "new", 8, 400)

    import threading
    release = threading.Event()

    def stuck_unlink(_path):
        release.wait(30)  # 模拟内核 D 状态：永不返回（测试结束由熔断换代替掉）

    async def run():
        with patch.object(quota_mod, "UNLINK_TIMEOUT_SEC", 0.3), \
                patch("recorder.quota.os.unlink", side_effect=stuck_unlink):
            return await quota_mod.QuotaEnforcer(store, index, sm).enforce("local")

    import time as _t
    t0 = _t.monotonic()
    deleted = asyncio.run(run())
    assert _t.monotonic() - t0 < 3  # 不再等 120s
    sm.io.shutdown()
    release.set()

    assert deleted == 0
    assert len(index.all_segments()) == 3  # 三行全保留（卡死结果未知）
    assert index.meta_get("overwrittenSegments") in (None, 0)


def test_poison_file_backoff_keeps_recording_cleanup_moving(tmp_path):
    """毒文件退避：卡死文件触发熔断后被拉黑，下一轮跳过它、继续删后面的
    文件，不会"自愈→同一文件再卡死→再熔断"空转。"""
    import recorder.quota as quota_mod

    q = QuotaConfig(mode="gb", gb=1, onFull="overwrite")
    store, index, sm, root = _setup(tmp_path, q)
    _add_segment(index, root, "c1", "old", 10, 400)
    _add_segment(index, root, "c1", "mid", 9, 400)
    _add_segment(index, root, "c1", "new", 8, 400)
    old_path = os.path.join(root, "20260901/old.mp4")

    import threading
    calls: list[str] = []
    release = threading.Event()

    def fake_unlink(path):
        calls.append(path)
        if path.endswith("old.mp4"):
            release.wait(30)  # 仅毒文件卡死

    async def run():
        qe = quota_mod.QuotaEnforcer(store, index, sm)
        sm.status.kind = "smb"  # 此用例验证 NAS 重挂换代；本机不会废弃慢维护线程。
        with patch.object(quota_mod, "UNLINK_TIMEOUT_SEC", 0.3), \
                patch("recorder.quota.os.unlink", side_effect=fake_unlink):
            first = await qe.enforce("local")  # 首轮：old 卡死 → 拉黑
            assert first == 0
            assert old_path in qe._poison
            # 模拟线上：watchdog 懒卸载重挂成功 → 熔断换代 CLOSED
            sm.io.reset("测试重挂成功")
            # 第二轮：old 必须跳过（不再提交 unlink），mid 正常删除
            second = await qe.enforce("local")
        return qe, second

    qe, second = asyncio.run(run())
    sm.io.shutdown()
    release.set()

    assert second == 1
    assert all(not c.endswith("old.mp4") for c in calls[1:])  # 毒文件没再碰
    rows = index.all_segments()
    assert len(rows) == 2  # old（毒，保留）+ new；mid 已删
    assert index.meta_get("overwrittenSegments") == 1
