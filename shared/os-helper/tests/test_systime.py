"""系统日期时间与局域网对时服务器：离线现场靠它手动校时，校时不能误伤授权与录像。"""
from __future__ import annotations

import http.server
import json
import subprocess
import threading
import urllib.error
import urllib.request

import pytest

import main
import systime

NOW = 1791525000.5  # 2026-10-09


class FakeRun:
    def __init__(self, fail_on=None, timedatectl="NTP=yes\nNTPSynchronized=no\nTimezone=Asia/Shanghai\n",
                 states=None):
        self.calls = []
        self.fail_on = fail_on
        self.timedatectl = timedatectl
        # 服务运行状态（systemctl show -p ActiveState），未列出的按 active
        self.states = states or {}

    def __call__(self, cmd, capture_output=True, text=True, timeout=None):
        self.calls.append(cmd)
        joined = " ".join(cmd)
        if self.fail_on and self.fail_on in joined:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")
        out = self.timedatectl if cmd[:2] == ["timedatectl", "show"] else ""
        if cmd[:2] == ["systemctl", "show"]:
            out = self.states.get(cmd[-1], "active") + "\n"
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")


@pytest.fixture
def st(tmp_path):
    run = FakeRun()
    t = systime.SystemTime(run=run, conf_path=tmp_path / "conf.d" / "ainvr-ntp.conf",
                           marker_path=tmp_path / "time-set", clock=lambda: NOW)
    t.fake = run
    return t


def test_status_reports_time_sync_and_validity(st):
    s = st.status()
    assert s["epoch_ms"] == int(NOW * 1000)
    assert s["timezone"] == "Asia/Shanghai"
    assert s["ntp_enabled"] is True and s["ntp_synchronized"] is False
    assert s["valid"] is True and s["manually_set"] is False
    assert s["ntp_servers"] == []
    assert s["min_valid_epoch_ms"] == systime.MIN_VALID_EPOCH * 1000


def test_status_before_2026_is_invalid(tmp_path):
    t = systime.SystemTime(run=FakeRun(), conf_path=tmp_path / "c", marker_path=tmp_path / "m",
                           clock=lambda: 1735689600)
    assert t.status()["valid"] is False


def test_set_time_sets_clock_keeps_network_sync_and_restarts_recording_and_ai(st):
    target = 1791600000123
    result = st.set_time(target)
    cmds = [" ".join(c) for c in st.fake.calls]
    i_off = cmds.index("timedatectl set-ntp false")
    i_set = cmds.index("date -u -s @1791600000.123")
    i_on = cmds.index("timedatectl set-ntp true")
    assert i_off < i_set < i_on
    assert "hwclock --systohc --utc" in cmds
    assert "systemctl --no-block restart ainvr-recorder.service ai-service.service" in cmds
    assert result["restarted"] == ["录像服务", "AI 识别服务"]
    assert st.status()["manually_set"] is True


def test_set_time_does_not_start_services_someone_stopped(tmp_path):
    """调试/维护时被人主动停掉的服务，不能因为校时被拉起来：只重启校时前正在运行的。"""
    run = FakeRun(states={"ai-service.service": "inactive"})
    t = systime.SystemTime(run=run, conf_path=tmp_path / "c", marker_path=tmp_path / "m", clock=lambda: NOW)
    result = t.set_time(1791600000000)
    cmds = [" ".join(c) for c in run.calls]
    assert "systemctl --no-block restart ainvr-recorder.service" in cmds
    assert not any("restart" in c and "ai-service" in c for c in cmds)
    assert result["restarted"] == ["录像服务"]


def test_set_time_with_both_services_stopped_restarts_nothing(tmp_path):
    run = FakeRun(states={"ainvr-recorder.service": "inactive", "ai-service.service": "failed"})
    t = systime.SystemTime(run=run, conf_path=tmp_path / "c", marker_path=tmp_path / "m", clock=lambda: NOW)
    assert t.set_time(1791600000000)["restarted"] == []
    assert not any("restart" in " ".join(c) for c in run.calls)


def test_auto_restarting_service_counts_as_running(tmp_path):
    """崩溃后正等待自动重启（activating）的服务本来就该运行，照常重启。"""
    run = FakeRun(states={"ai-service.service": "activating"})
    t = systime.SystemTime(run=run, conf_path=tmp_path / "c", marker_path=tmp_path / "m", clock=lambda: NOW)
    assert t.set_time(1791600000000)["restarted"] == ["录像服务", "AI 识别服务"]


def test_set_time_failure_still_reenables_network_sync_and_does_not_restart(tmp_path):
    run = FakeRun(fail_on="date -u -s")
    t = systime.SystemTime(run=run, conf_path=tmp_path / "c", marker_path=tmp_path / "m", clock=lambda: NOW)
    with pytest.raises(systime.SysTimeError):
        t.set_time(1791600000000)
    cmds = [" ".join(c) for c in run.calls]
    assert cmds[-1] == "timedatectl set-ntp true"
    assert not any("restart" in c for c in cmds)
    assert t.status()["manually_set"] is False


def test_hwclock_failure_is_not_fatal(tmp_path):
    run = FakeRun(fail_on="hwclock")
    t = systime.SystemTime(run=run, conf_path=tmp_path / "c", marker_path=tmp_path / "m", clock=lambda: NOW)
    assert t.set_time(1791600000000)["restarted"]


@pytest.mark.parametrize("bad", [1735689600000, 4102444800001, -1, "1791600000000", True, None, 1.5])
def test_set_time_rejects_out_of_range_or_non_integer(st, bad):
    with pytest.raises(systime.SysTimeError):
        st.set_time(bad)
    assert st.fake.calls == []


def test_ntp_servers_written_as_dropin_and_service_restarted(st):
    st.set_ntp_servers([" 192.168.0.1 ", "ntp.example.lan", "192.168.0.1"])
    text = st.conf_path.read_text()
    assert text == "[Time]\nNTP=192.168.0.1 ntp.example.lan\n"
    cmds = [" ".join(c) for c in st.fake.calls]
    assert "systemctl restart systemd-timesyncd" in cmds
    assert "timedatectl set-ntp true" in cmds
    assert st.status()["ntp_servers"] == ["192.168.0.1", "ntp.example.lan"]


def test_empty_ntp_servers_removes_dropin(st):
    st.set_ntp_servers(["192.168.0.1"])
    st.set_ntp_servers([])
    assert not st.conf_path.exists()
    assert st.status()["ntp_servers"] == []


@pytest.mark.parametrize("bad", [["a b"], ["x;rm -rf /"], ["-host"], ["h" * 254], [""], "192.168.0.1",
                                 [1], ["1.2.3.4"] * 6, ["bad_host.lan"]])
def test_ntp_servers_validation(st, bad):
    with pytest.raises(systime.SysTimeError):
        st.set_ntp_servers(bad)
    assert not st.conf_path.exists()
    assert st.fake.calls == []


@pytest.fixture
def server(monkeypatch, st):
    monkeypatch.setattr(main, "TOKEN", "test-token")
    monkeypatch.setattr(main, "source_ip_allowed", lambda addr: True)
    monkeypatch.setattr(main, "SYSTEM_TIME", st)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), main.OSHelperHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _req(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_time_routes(server, st):
    status, body = _req(server, "GET", "/system/time")
    assert status == 200 and body["time"]["timezone"] == "Asia/Shanghai"
    status, body = _req(server, "PUT", "/system/time", {"epoch_ms": 1791600000000})
    assert status == 200 and body["restarted"] == ["录像服务", "AI 识别服务"]
    status, body = _req(server, "PUT", "/system/time", {"epoch_ms": 1})
    assert status == 400 and "2026" in body["error"]
    status, body = _req(server, "PUT", "/system/ntp", {"servers": ["192.168.0.1"]})
    assert status == 200 and body["time"]["ntp_servers"] == ["192.168.0.1"]
    status, body = _req(server, "PUT", "/system/ntp", {"servers": ["bad host"]})
    assert status == 400
