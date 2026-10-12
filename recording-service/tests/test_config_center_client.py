"""ConfigCenterClient 单元测试（mock HTTP，不依赖真实 BFF）。"""
from __future__ import annotations

import json
import threading
import time
from typing import Any
from unittest.mock import patch

import pytest

from recorder.config_center_client import ConfigCenterClient


class FakeBFF:
    """模拟 BFF /api/v1/config/* 端点。"""

    def __init__(self):
        self.state: dict[str, Any] = {"desiredVersion": 3, "appliedVersion": None}
        self.snapshot: list[dict] | None = [
            {"service": "recorder", "group": "system", "name": "settings",
             "config": {"files": {"segmentSeconds": 300}}}
        ]
        self.documents: list[dict] | None = None
        self.reports: list[dict] = []
        self.fail_snapshot = False
        self.fail_state = False

    def handle(self, path: str, method: str, body: dict | None) -> tuple[int, dict]:
        if path == "/service-states/recorder" and method == "POST":
            self.reports.append(body)
            return 200, {"code": 0, "data": body}
        if path == "/service-states/recorder":
            if self.fail_state:
                return 500, {"code": 500, "error": "boom"}
            return 200, {"code": 0, "data": dict(self.state)}
        if path.startswith("/versions/") and "/snapshot" in path:
            # 客户端现在带 ?service=<name> 查询参数请求服务视图（2026-09-15
            # A2/A3：BFF 按服务过滤 + 解密本服务 secret 占位符）——fake 端点
            # 对带不带参数的请求返回相同数据，与真实 BFF 的本服务文档一致
            if self.fail_snapshot or self.snapshot is None:
                return 500, {"code": 500, "error": "no snapshot"}
            return 200, {"code": 0, "data": self.snapshot}
        if path == "/documents?service=recorder":
            if self.documents is None:
                return 200, {"code": 0, "data": []}
            return 200, {"code": 0, "data": self.documents}
        return 404, {"code": 404, "error": "not found"}


def make_client(bff: FakeBFF, on_apply=None) -> ConfigCenterClient:
    c = ConfigCenterClient(
        base_url="http://bff.test",
        service_name="recorder",
        service_token="tok-123",
        on_apply=on_apply or (lambda cfg: True),
        poll_interval_seconds=1,
    )
    return c


def patch_request(bff: FakeBFF):
    """拦截 client._request 直接走 FakeBFF。"""

    def fake(self, path, method="GET", body=None):
        code, resp = bff.handle(path, method, body)
        if code != 200:
            return None
        return resp.get("data")

    return patch.object(ConfigCenterClient, "_request", fake)


def test_first_apply_success_and_report():
    bff = FakeBFF()
    applied: list[dict] = []
    with patch_request(bff):
        c = make_client(bff, on_apply=lambda cfg: (applied.append(cfg), True)[1])
        c._try_update()

    assert len(applied) == 1
    assert applied[0]["files"]["segmentSeconds"] == 300
    assert c.applied_version == 3
    # 上报了 applied
    assert bff.reports and bff.reports[-1]["status"] == "applied"
    # 2026-09-16 回归：上报的 appliedVersion 必须是这次真正应用成功的版本号
    # （3），不能是应用前的旧值（None）——此前的 bug 会让这里断言失败
    # （report 里恒是 self._applied_version 的"更新前"值）。
    assert bff.reports[-1]["appliedVersion"] == 3


def test_report_applied_version_tracks_new_version_not_stale_one():
    """2026-09-16 回归：_report() 上报的 appliedVersion 必须跟着这次真正
    应用成功的版本走，不能永远落后一拍。复现路径：先成功应用到 v3，
    BFF 再把 desiredVersion 推到 v5，第二次上报的 appliedVersion 必须是
    5，不能是 3（修复前的 bug：body 里恒用 self._applied_version，此时
    还是"更新前"的 3，导致 BFF 那边 detectDrift() 永远判定为漂移）。"""
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff)
        c._try_update()
        assert c.applied_version == 3
        assert bff.reports[-1]["appliedVersion"] == 3

        bff.state["desiredVersion"] = 5
        c._try_update()
        assert c.applied_version == 5
        assert bff.reports[-1]["appliedVersion"] == 5


def test_apply_failure_retries_same_version():
    """应用失败：同版本不会永久放弃，退避后重试。"""
    bff = FakeBFF()
    calls = {"n": 0}

    def flaky(cfg):
        calls["n"] += 1
        return calls["n"] >= 2  # 第一次失败，第二次成功

    with patch_request(bff):
        c = make_client(bff, on_apply=flaky)
        c._try_update()
        assert c.applied_version is None
        assert bff.reports[-1]["status"] == "failed"
        assert c._retry_delay > 5.0  # 退避增长

        c._try_update()  # 指数退避后同版本再试
        assert c.applied_version == 3
        assert bff.reports[-1]["status"] == "applied"
        assert c._retry_delay == 5.0  # 成功后重置


def test_on_apply_tuple_return_reports_restart_required():
    """2026-09-18：on_apply 除了 bool 还可以返回 (ok, restart_required) 元组
    ——ai-service 用这个告诉配置中心"这次改动落盘成功，但要重启进程才
    真正生效"（ChannelWorker 的 Mongo 连接只在构造时读一次）。"""
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff, on_apply=lambda cfg: (True, True))
        c._try_update()
    assert c.applied_version == 3
    assert bff.reports[-1]["status"] == "applied"
    assert bff.reports[-1]["restartRequired"] is True


def test_on_apply_tuple_return_false_restart_required():
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff, on_apply=lambda cfg: (True, False))
        c._try_update()
    assert bff.reports[-1]["restartRequired"] is False


def test_on_apply_plain_bool_still_reports_restart_required_false():
    """向后兼容：recorder 只返回 bool（自己内部热重启，用不上这个信号），
    restartRequired 恒上报 False，不因为改了返回值类型就报错/丢状态。"""
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff, on_apply=lambda cfg: True)
        c._try_update()
    assert bff.reports[-1]["restartRequired"] is False


def test_on_apply_tuple_with_ok_false_still_treated_as_failure():
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff, on_apply=lambda cfg: (False, True))
        c._try_update()
    assert c.applied_version is None
    assert bff.reports[-1]["status"] == "failed"


def test_no_settings_document_fallback_then_error():
    """从未配置 → fallback 并标记 applied；已应用过再丢配置 → failed。"""
    bff = FakeBFF()
    bff.snapshot = []  # 快照里没有 recorder 配置
    bff.documents = None  # 当前文档也没有 → 「从未配置」
    with patch_request(bff):
        c = make_client(bff)
        c._try_update()
        # 从未配置：fallback，不算失败
        assert c.applied_version == 3
        assert bff.reports[-1]["status"] == "applied"

        # 模拟「应用过之后快照丢了配置」：回到未应用状态 + 当前文档存在
        bff2 = FakeBFF()
        bff2.snapshot = []
        bff2.documents = [{"service": "recorder", "group": "system", "name": "settings",
                           "config": {}}]
        with patch_request(bff2):
            c2 = make_client(bff2)
            c2._applied_version = 2  # 之前应用过 v2
            c2._try_update()
            assert bff2.reports[-1]["status"] == "failed"


def test_snapshot_fetch_failure_reported_failed():
    bff = FakeBFF()
    bff.fail_snapshot = True
    with patch_request(bff):
        c = make_client(bff)
        c._try_update()
        assert c.applied_version is None
        assert bff.reports[-1]["status"] == "failed"


def test_no_desired_version_noop():
    bff = FakeBFF()
    bff.state["desiredVersion"] = None
    with patch_request(bff):
        c = make_client(bff)
        c._try_update()
        assert c.applied_version is None
        assert bff.reports == []


def test_same_version_skipped():
    bff = FakeBFF()
    with patch_request(bff):
        c = make_client(bff)
        c._try_update()
        reports_after_first = len(bff.reports)
        c._try_update()  # 同版本不再拉取/上报
        assert len(bff.reports) == reports_after_first


def test_service_token_env_name_mapping():
    # 与 BFF backend/src/services/serviceTokens.ts 的 ENV_BY_SERVICE 同规则
    from recorder.config_center_client import service_token_env_name

    assert service_token_env_name("recorder") == "CONFIG_SERVICE_TOKEN_RECORDER"
    assert service_token_env_name("ai-service") == "CONFIG_SERVICE_TOKEN_AI_SERVICE"


def test_client_from_env_per_service_token_precedence(monkeypatch):
    """分服务令牌变量优先于旧共享变量（2026-09-16 令牌收口）。"""
    from recorder.config_center_client import client_from_env

    monkeypatch.setenv("CONFIG_CENTER_URL", "http://bff.test")
    monkeypatch.setenv("CONFIG_SERVICE_TOKEN_RECORDER", "new-token")
    monkeypatch.setenv("CONFIG_SERVICE_TOKEN", "legacy-token")
    c = client_from_env("recorder", lambda cfg: True)
    assert c is not None
    assert c.service_token == "new-token"


def test_client_from_env_legacy_shared_token_fallback(monkeypatch):
    """只配旧共享变量时仍能工作（一个发布周期的回退兼容）。"""
    from recorder.config_center_client import client_from_env

    monkeypatch.setenv("CONFIG_CENTER_URL", "http://bff.test")
    monkeypatch.delenv("CONFIG_SERVICE_TOKEN_RECORDER", raising=False)
    monkeypatch.setenv("CONFIG_SERVICE_TOKEN", "legacy-token")
    c = client_from_env("recorder", lambda cfg: True)
    assert c is not None
    assert c.service_token == "legacy-token"


def test_client_from_env_disabled_without_url(monkeypatch):
    from recorder.config_center_client import client_from_env

    monkeypatch.delenv("CONFIG_CENTER_URL", raising=False)
    assert client_from_env("recorder", lambda cfg: True) is None
