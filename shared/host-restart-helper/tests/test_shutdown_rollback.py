"""安全关机中途失败不能留下"没断电、也没在录像"的设备：已停的服务要恢复，
失败原因能被页面查到；每步等待不短于服务自身允许的停止时间。"""
from __future__ import annotations

import http.server
import json
import re
import subprocess
import threading
import urllib.request
from pathlib import Path

import pytest

import restart_helper as rh

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _reset():
    if rh._shutdown_lock.locked():
        rh._shutdown_lock.release()
    rh._reset_shutdown_status()
    yield
    if rh._shutdown_lock.locked():
        rh._shutdown_lock.release()
    rh._reset_shutdown_status()


def _fake(monkeypatch, fail_on=None, timeout_on=None, restore_fails=False, inactive=()):
    calls = []

    def fake_run(cmd, capture_output, text, timeout):
        calls.append((" ".join(cmd), timeout))
        joined = " ".join(cmd)
        if "systemctl show" in joined:
            state = "inactive" if cmd[-1] in inactive else "active"
            return subprocess.CompletedProcess(cmd, 0, stdout=state + "\n", stderr="")
        if timeout_on and timeout_on in joined:
            raise subprocess.TimeoutExpired(cmd, timeout)
        if fail_on and fail_on in joined:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")
        if restore_fails and " restart " in f" {joined} ":
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="restore boom")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(rh.subprocess, "run", fake_run)
    return calls


def _stop_timeout_sec(unit_text: str, default: int = 90) -> int:
    m = re.search(r"^\s*TimeoutStopSec=(\d+)\s*$", unit_text, re.M)
    return int(m.group(1)) if m else default


def test_step_wait_not_shorter_than_service_stop_budget():
    recorder = _stop_timeout_sec((REPO / "recording-service/deploy/ainvr-recorder.service.example").read_text())
    steps = {s["name"]: s["timeout"] for s in rh.SHUTDOWN_SEQUENCE}
    assert steps["停止录像服务"] > recorder
    ai_unit = REPO / "ai-service/deploy/ai-service.service.example"
    if ai_unit.exists():
        assert steps["停止 AI 识别服务"] > _stop_timeout_sec(ai_unit.read_text())


def test_non_ai_installation_can_shutdown_without_an_ai_unit(monkeypatch):
    calls = _fake(monkeypatch)
    original = rh.subprocess.run

    def run(cmd, **kwargs):
        if 'LoadState' in cmd and cmd[-1] == 'ai-service.service':
            return subprocess.CompletedProcess(cmd, 0, stdout='not-found\n', stderr='')
        return original(cmd, **kwargs)

    monkeypatch.setattr(rh.subprocess, 'run', run)
    assert rh.run_shutdown()[0]
    assert not any('stop ai-service.service' in command for command, _ in calls)
    assert any('poweroff' in command for command, _ in calls)


def test_ai_stop_failure_restores_stopped_services_and_never_powers_off(monkeypatch):
    calls = _fake(monkeypatch, fail_on="stop ai-service")
    ok, err, step = rh.run_shutdown()
    cmds = [c for c, _ in calls]
    assert ok is False and step == 1
    assert not any("poweroff" in c for c in cmds)
    restores = [c for c in cmds if " restart " in f" {c} "]
    assert any("ai-service.service" in c for c in restores)
    assert any("ainvr-recorder.service" in c for c in restores)
    assert "已恢复" in err
    status = rh.shutdown_status()
    assert status["state"] == "failed"
    assert set(status["restored"]) == {"录像服务", "AI 识别服务"}
    assert status["restoreFailed"] == []


def test_poweroff_failure_restores_both_services(monkeypatch):
    calls = _fake(monkeypatch, fail_on="poweroff")
    ok, err, step = rh.run_shutdown()
    assert ok is False and step == 2
    restores = [c for c, _ in calls if " restart " in f" {c} "]
    assert len(restores) == 2
    assert rh.shutdown_status()["state"] == "failed"


def test_timed_out_stop_is_also_restored(monkeypatch):
    """停服务超时后 systemd 仍可能把它停掉：同样要拉回来。"""
    calls = _fake(monkeypatch, timeout_on="stop ainvr-recorder")
    ok, err, step = rh.run_shutdown()
    assert ok is False and step == 0 and "超时" in err
    restores = [(c, t) for c, t in calls if " restart " in f" {c} "]
    assert [c for c, _ in restores] == ["sudo -n /usr/bin/systemctl restart ainvr-recorder.service"]
    # 恢复要等得比服务停止更久：restart 会排在仍在进行的 stop 之后
    assert restores[0][1] >= rh.SHUTDOWN_SEQUENCE[0]["timeout"]


def test_service_already_stopped_before_shutdown_is_not_started_on_rollback(monkeypatch):
    """关机前就被人停掉的服务（调试/维护），关机失败回滚时不能被拉起来。"""
    calls = _fake(monkeypatch, fail_on="poweroff", inactive=("ai-service.service",))
    ok, err, _ = rh.run_shutdown()
    assert ok is False
    restores = [c for c, _ in calls if " restart " in f" {c} "]
    assert restores == ["sudo -n /usr/bin/systemctl restart ainvr-recorder.service"]
    assert rh.shutdown_status()["restored"] == ["录像服务"]


def test_restore_failure_is_reported(monkeypatch):
    _fake(monkeypatch, fail_on="stop ai-service", restore_fails=True)
    ok, err, _ = rh.run_shutdown()
    assert ok is False and "恢复失败" in err
    status = rh.shutdown_status()
    assert set(status["restoreFailed"]) == {"录像服务", "AI 识别服务"}


def test_success_status_is_powering_off(monkeypatch):
    _fake(monkeypatch)
    ok, _, _ = rh.run_shutdown()
    assert ok is True
    assert rh.shutdown_status()["state"] == "poweringOff"


def test_status_idle_before_any_shutdown():
    assert rh.shutdown_status()["state"] == "idle"


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("RESTART_HELPER_TOKEN", "t0k")
    monkeypatch.setattr(rh, "source_ip_allowed", lambda addr: True)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), rh.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def test_http_status_endpoint_reports_failure(server, monkeypatch):
    _fake(monkeypatch, fail_on="stop ai-service")
    rh.run_shutdown()
    req = urllib.request.Request(server + "/shutdown/status", headers={"Authorization": "Bearer t0k"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    assert body["ok"] is True
    assert body["status"]["state"] == "failed"
    assert "已恢复" in body["status"]["error"]
