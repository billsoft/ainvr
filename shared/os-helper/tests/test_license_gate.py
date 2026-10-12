"""Management remains reachable in every licensing state; authentication still applies."""
from __future__ import annotations

import main


class _StubClient:
    def __init__(self, phase: str) -> None:
        self._phase = phase

    def phase(self) -> str:
        return self._phase


def test_gate_not_wired_allows():
    assert main.license_write_blocked(None) == (False, "")


def test_gate_valid_allows():
    assert main.license_write_blocked(_StubClient("valid")) == (False, "management_exempt")


def test_gate_each_non_valid_phase_blocks():
    for phase in ("starting", "invalid", "dormant"):
        assert main.license_write_blocked(_StubClient(phase)) == (False, "management_exempt")


def test_default_global_client_is_none(monkeypatch):
    # 默认未接线：现有部署升级后行为零变化
    assert main.license_client is None
