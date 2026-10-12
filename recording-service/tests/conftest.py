"""pytest 公共夹具：src 入路径、临时数据目录装配的微服务。"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from recorder.app import create_app  # noqa: E402
from recorder.config import ConfigStore  # noqa: E402
from recorder.license_guard import LicenseGuard  # noqa: E402


class _Lease:
    """测试用授权状态：不读 /etc/ainvr-recorder、不连授权服务。"""

    def __init__(self, phase: str):
        self._phase = phase

    def phase(self) -> str:
        return self._phase


def guard_with_phase(phase: str):
    """create_app 的 guard_factory：client=None 表示没有需要启停的授权客户端。"""
    return lambda: (None, LicenseGuard(_Lease(phase)))


@pytest.fixture
def tmp_data(tmp_path):
    return str(tmp_path)


@pytest.fixture
def store(tmp_data):
    cfg_path = os.path.join(tmp_data, "config.json")
    s = ConfigStore(cfg_path)
    cfg = s.mutate()
    # 隔离：不打真实 BFF/SRS；录像根目录用临时目录
    cfg.console.base_url = "http://127.0.0.1:9"
    cfg.console.token = ""
    cfg.srs_api_url = "http://127.0.0.1:9"
    cfg.recording.storage.localPath = os.path.join(tmp_data, "videos")
    os.makedirs(cfg.recording.storage.localPath, exist_ok=True)
    s.save()
    s.commit()
    return s


@pytest.fixture
def client(store, tmp_data, monkeypatch):
    from fastapi.testclient import TestClient
    # Business endpoint tests do not contact production authentication services.
    monkeypatch.setattr('recorder.auth._authorize', lambda *_: 204)

    # 业务用例在"已授权"前提下测媒体/API 行为：授权本身由 license 服务与
    # test_license_guard / test_supervisor_license_gate / 下方未授权用例覆盖。
    # 此前这里走真实 build_guard，测试机没有授权配置 → configuration_error → 媒体端点
    # 一律 403，9 个媒体用例因此长期失败（与被测逻辑无关）。
    app = create_app(store, tmp_data, guard_factory=guard_with_phase("valid"))
    with TestClient(app) as c:
        yield c
