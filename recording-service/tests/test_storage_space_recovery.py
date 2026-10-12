"""2026-09-24 NAS 写满事件回归：

- 卷真实剩余空间低于阈值必须主动停录并明确报"空间不足"（gb 配额只管自己，
  挡不住别的数据/回收站把卷写满；写满后 NAS 对 SMB2 WRITE 不回包→D 状态）；
- 恢复流程里的写探测卡死不能把管理车道围栏永久锁死（旧实现把探针写放在
  管理车道，一卡就每轮"上一次存储管理操作仍未结束"，自愈永久失效）；
- 恢复失败要退避且文案如实（第 N 次、多久后重试）；
- 共享开了回收站要显式告警（滚动覆盖删除的段进回收站继续占空间）。
"""
import asyncio
import logging
import threading
import time
from unittest.mock import MagicMock

import pytest

import recorder.storage as storage_mod
from recorder.config import QuotaConfig, SmbConfig, StorageConfig
from recorder.quota import QuotaEnforcer
from recorder.storage import StorageError, StorageManager

GB = 1024 ** 3
TB = 1024 ** 4


def _smb_cfg():
    smb = SmbConfig(host="10.0.0.1", share="wanglei", path="AI/videos2",
                    username="u", password="", smbVersion="3.0")
    return StorageConfig(kind="smb", smb=smb)


def _manager(tmp_path, monkeypatch, avail_bytes):
    """挂载点换成临时目录；挂载/卸载打桩，容量按可变字典返回。"""
    mnt = tmp_path / "mnt"
    mnt.mkdir()
    monkeypatch.setattr(storage_mod, "DEFAULT_MOUNT_POINT", str(mnt))
    monkeypatch.setattr(storage_mod, "mounted_source", lambda _p: "//10.0.0.1/wanglei")
    cap = {"avail": avail_bytes}
    monkeypatch.setattr(StorageManager, "fs_stats",
                        staticmethod(lambda _p: (11 * TB, cap["avail"])))
    sm = StorageManager()
    sm._umount = MagicMock()
    sm._mount_smb_sync = MagicMock(return_value="3.0")
    return sm, mnt, cap


def test_hung_probe_does_not_wedge_management_fence(tmp_path, monkeypatch):
    sm, _mnt, _cap = _manager(tmp_path, monkeypatch, 500 * GB)
    release = threading.Event()
    calls = {"n": 0}

    def probe(root, size):
        calls["n"] += 1
        if calls["n"] == 1:
            release.wait(5)  # 第一次：模拟 NAS 不回 WRITE，线程 D 住
        return 50.0

    monkeypatch.setattr(storage_mod, "_probe_sync", probe)
    monkeypatch.setattr(storage_mod, "RECOVER_PROBE_TIMEOUT", 0.2)

    async def run():
        sm.io.trip("nas-probe", "模拟卡死")
        first = await sm.try_recover(_smb_cfg())
        sm._next_recover_at = 0.0  # 跳过退避，立刻第二次
        second = await sm.try_recover(_smb_cfg())
        return first, second

    try:
        first, second = asyncio.run(run())
    finally:
        release.set()
        sm.shutdown()
    assert first is False
    # 第二次必须真正重挂，而不是被"上一次存储管理操作仍未结束"挡回
    assert sm._mount_smb_sync.call_count == 2
    assert second is True
    assert sm.status.healthy is True
    assert not sm.io.tripped


def test_recovery_on_full_nas_skips_write_probe_and_reports_space(tmp_path, monkeypatch):
    sm, mnt, _cap = _manager(tmp_path, monkeypatch, 1 * GB)
    probe = MagicMock(return_value=50.0)
    monkeypatch.setattr(storage_mod, "_probe_sync", probe)
    try:
        ok = asyncio.run(sm.try_recover(_smb_cfg()))
    finally:
        sm.shutdown()
    assert ok is True
    # 满盘上建目录/写探测都会把线程送进 D 状态（现场卡的正是 mkdir）
    probe.assert_not_called()
    assert not (mnt / "AI").exists()
    assert sm.status.healthy is True  # 连通性正常，可回放
    assert sm.status.space_low is True
    with pytest.raises(StorageError, match="空间不足"):
        sm.active_root()


def test_watchdog_space_guard_with_hysteresis(tmp_path, monkeypatch):
    sm, mnt, cap = _manager(tmp_path, monkeypatch, 1 * GB)
    probe = MagicMock(return_value=50.0)
    monkeypatch.setattr(storage_mod, "_probe_sync", probe)
    root = mnt / "AI" / "videos2"
    root.mkdir(parents=True)
    sm.status.kind = "smb"
    sm.status.root = str(root)
    sm.status.healthy = True
    try:
        assert asyncio.run(sm.watchdog_check()) is True
        assert sm.status.space_low is True
        assert "空间不足" in sm.status.message
        probe.assert_not_called()

        cap["avail"] = 7 * GB  # 高于停录线、低于恢复线：保持停录，防抖动
        asyncio.run(sm.watchdog_check())
        assert sm.status.space_low is True

        cap["avail"] = 50 * GB
        assert asyncio.run(sm.watchdog_check()) is True
        assert sm.status.space_low is False
        assert sm.status.message == ""
        probe.assert_called_once()
        assert sm.active_root() == (str(root), "smb")
    finally:
        sm.shutdown()


def test_recovery_failure_backs_off_with_truthful_message(tmp_path, monkeypatch):
    sm, _mnt, _cap = _manager(tmp_path, monkeypatch, 500 * GB)
    sm._mount_smb_sync = MagicMock(side_effect=StorageError("挂载 //10.0.0.1/wanglei 失败：X"))
    sm.status.kind = "smb"
    sm.status.healthy = False
    try:
        assert asyncio.run(sm.try_recover(_smb_cfg())) is False
        assert "第 1 次" in sm.status.message and "失败：X" in sm.status.message
        assert sm.recover_due() is False
        # 退避期内再调：不再触碰挂载
        assert asyncio.run(sm.try_recover(_smb_cfg())) is False
        assert sm._mount_smb_sync.call_count == 1

        sm._next_recover_at = 0.0
        assert asyncio.run(sm.try_recover(_smb_cfg())) is False
        assert sm._mount_smb_sync.call_count == 2
        assert "第 2 次" in sm.status.message
        # 指数退避：第 2 次失败后等待比第 1 次长
        assert sm._next_recover_at - time.monotonic() > 45
    finally:
        sm.shutdown()


def test_recycle_bin_on_share_is_reported(tmp_path, monkeypatch):
    sm, mnt, _cap = _manager(tmp_path, monkeypatch, 500 * GB)
    (mnt / "@Recycle").mkdir()
    monkeypatch.setattr(storage_mod, "_probe_sync", MagicMock(return_value=50.0))
    try:
        assert asyncio.run(sm.try_recover(_smb_cfg())) is True
    finally:
        sm.shutdown()
    assert "回收站" in sm.status.warning
    assert "@Recycle" in sm.status.warning


def test_health_reports_space_low_and_warning(client):
    st = client.app.state.storage.status
    st.healthy = True
    st.space_low = True
    st.message = "NAS 可用空间不足"
    st.warning = "NAS 共享开启了回收站"
    body = client.get("/v1/recorder/health").json()
    assert body["storageHealthy"] is False
    assert body["warning"] == "NAS 共享开启了回收站"
    assert client.get("/v1/recorder/stats").json()["storageHealthy"] is False


def test_quota_log_reports_used_not_remaining(tmp_path, caplog):
    from test_quota import _add_segment, _setup
    store, index, sm, root = _setup(tmp_path, QuotaConfig(mode="gb", gb=1, onFull="overwrite"))
    for i, name in enumerate(("a", "b", "c")):
        _add_segment(index, root, "c1", name, 10 - i, 600)
    with caplog.at_level(logging.INFO, logger="recorder.quota"):
        deleted = asyncio.run(QuotaEnforcer(store, index, sm).enforce("local"))
    sm.io.shutdown()
    assert deleted >= 1
    assert "已用约" in caplog.text
    assert "剩余约" not in caplog.text
