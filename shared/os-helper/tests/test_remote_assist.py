"""远程协助：开关以 systemd 启用状态为准、只转发本机远程登录端口、错误一律中文。"""
from __future__ import annotations

import json
import socket
import threading

import pytest

import remote_assist as ra


CA = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n"
CREDS = {"auth_token": "tok-1", "secret_key": "sk-1", "ca_cert": CA}  # 统一接入凭据：所有设备相同
CODE = "ABCD1234EFGH5678"
IDENT = dict(CREDS, device_id="A001", device_token="dt-1", proxy_name="A001-ssh")


class FakeHost:
    """记录 systemctl/ss/sshd 调用的假宿主机。"""

    def __init__(self, enabled=False, active="inactive", sshd_port="33888", ss_out=""):
        self.enabled = enabled
        self.active = active
        self.sshd_port = sshd_port
        self.ss_out = ss_out
        self.calls: list[list[str]] = []
        self.fail_enable = False
        self.fail_stop = False
        self.query_fails = False
        self.journal = ""

    def run(self, argv, timeout=10):
        self.calls.append(list(argv))
        if argv[:2] == ["systemctl", "is-enabled"]:
            if self.query_fails:
                return 1, ""
            return (0, "enabled\n") if self.enabled else (1, "disabled\n")
        if argv[:2] == ["systemctl", "is-active"]:
            if self.query_fails:
                return 4, ""
            return (0 if self.active == "active" else 3, self.active + "\n")
        if argv[:3] == ["systemctl", "enable", "--now"]:
            if self.fail_enable:
                return 1, "boom"
            self.enabled, self.active = True, "active"
            return 0, ""
        if argv[:2] == ["systemctl", "disable"]:
            self.enabled = False
            return 0, ""
        if argv[:2] == ["systemctl", "stop"]:
            if self.fail_stop:  # 停止超时：命令失败，进程仍在运行
                return 1, "timeout"
            self.active = "inactive"
            return 0, ""
        if argv[:2] == ["sshd", "-T"]:
            return 0, f"port {self.sshd_port}\naddressfamily any\n"
        if argv[0] == "ss":
            return 0, self.ss_out
        if argv[0] == "journalctl":
            return 0, self.journal
        return 0, ""


@pytest.fixture
def env(tmp_path):
    binary = tmp_path / "client"
    binary.write_text("")
    unit = tmp_path / "unit.service"
    unit.write_text("")
    host = FakeHost()
    clock = [1_000.0]
    api = {"payload": None, "code": "abcd-1234-efgh-5678"}

    def http_get(url, user, password):
        if api["payload"] is None:
            raise OSError("unreachable")
        return api["payload"]

    assist = ra.RemoteAssist(
        tmp_path / "state", run=host.run, http_get=http_get, now=lambda: clock[0],
        binary=binary, unit_file=unit, group_gid=lambda: None, machine_code=lambda: api["code"])
    return assist, host, clock, api, tmp_path


def configure(assist):
    assist.set_server("relay.example.com", 443, actor="admin")
    (assist.dir / "credentials.json").write_text(json.dumps(CREDS))


def test_validate_host_accepts_ip_and_domain_rejects_injection():
    assert ra.validate_host(" 1.2.3.4 ") == "1.2.3.4"
    assert ra.validate_host("relay.example.com") == "relay.example.com"
    assert ra.validate_host("2001:db8::1") == "2001:db8::1"
    for bad in ["", "a b", 'x"\nserverPort = 1', "-bad.com", "a" * 254, "例子.com", "http://x"]:
        with pytest.raises(ra.RemoteAssistError):
            ra.validate_host(bad)


@pytest.mark.parametrize("port", [0, 65536, "443x", None, True])
def test_validate_port_rejects(port):
    with pytest.raises(ra.RemoteAssistError):
        ra.validate_port(port)


def test_rendered_config_forwards_only_local_login_port_with_tls():
    text = ra.render_config({"host": "relay.example.com", "port": 443}, IDENT, ssh_port=33888,
                            admin={"user": "assist", "password": "pw"}, ca_file=None)
    assert 'serverAddr = "relay.example.com"' in text
    assert "serverPort = 443" in text
    assert "transport.tls.enable = true" in text
    assert 'type = "stcp"' in text
    assert 'localIP = "127.0.0.1"' in text
    assert "localPort = 33888" in text
    assert 'webServer.addr = "127.0.0.1"' in text
    assert text.count("[[proxies]]") == 1


def test_rendered_config_identifies_device_and_enables_heartbeat():
    """设备身份随登录与每次心跳送达中转服务器；显式开启心跳，云端暂停才能让在线设备断开。"""
    text = ra.render_config({"host": "r.example.com", "port": 33888}, IDENT, 33888,
                            {"user": "u", "password": "p"}, None)
    assert 'metadatas.role = "device"' in text
    assert 'user = "A001"' in text  # frp 用户绑定设备编号：隧道只允许同 user 的已登录访问者
    assert 'metadatas.device = "A001"' in text and 'metadatas.device_token = "dt-1"' in text
    assert "transport.heartbeatInterval = 10" in text and "transport.heartbeatTimeout = 30" in text
    assert text.index("metadatas.device_token") < text.index("[[proxies]]")


@pytest.mark.parametrize("missing", ["auth_token", "secret_key", "ca_cert"])
def test_fleet_credentials_require_token_key_and_ca(env, missing):
    assist, *_ = env
    assist.dir.mkdir(parents=True, exist_ok=True)
    (assist.dir / "credentials.json").write_text(json.dumps({k: v for k, v in CREDS.items() if k != missing}))
    assert assist._credentials() is None


def test_enable_identifies_by_machine_code_without_provisioning(env):
    """免开通：机器码来自本机授权服务，设备令牌首次开启时本机生成并永久保存。"""
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    cfg = (assist.dir / "client.toml").read_text()
    token = (assist.dir / "device.key").read_text().strip()
    assert len(token) >= 32 and oct((assist.dir / "device.key").stat().st_mode & 0o777) == "0o600"
    assert f'user = "{CODE}"' in cfg and f'metadatas.device = "{CODE}"' in cfg
    assert f'metadatas.device_token = "{token}"' in cfg and f'name = "{CODE}-ssh"' in cfg
    assist.disable(actor="admin"); assist.enable(actor="admin")
    assert (assist.dir / "device.key").read_text().strip() == token  # 令牌不随重新开启改变
    assert assist.status()["machine_code"] == CODE


def test_device_token_reuses_legacy_per_device_credentials(env):
    assist, host, clock, api, tmp = env
    assist.set_server("relay.example.com", 443, actor="admin")
    legacy = dict(CREDS, device_id=CODE, device_token="legacy-token-0123456789", proxy_name=f"{CODE}-ssh")
    (assist.dir / "credentials.json").write_text(json.dumps(legacy))
    assist.enable(actor="admin")
    assert 'metadatas.device_token = "legacy-token-0123456789"' in (assist.dir / "client.toml").read_text()


def test_machine_code_falls_back_to_cache_then_refuses(env):
    assist, host, clock, api, tmp = env
    configure(assist)
    api["code"] = None
    with pytest.raises(ra.RemoteAssistError, match="机器码"):
        assist.enable(actor="admin")
    assert not any(c[:2] == ["systemctl", "enable"] for c in host.calls)
    api["code"] = CODE
    assist.enable(actor="admin")
    assist.disable(actor="admin")
    api["code"] = "garbage"  # 授权服务异常时用缓存
    assist.enable(actor="admin")
    assert f'user = "{CODE}"' in (assist.dir / "client.toml").read_text()


def test_identity_conflict_message():
    msg = ra.translate_error("login to server failed: AINVR_IDENTITY_CONFLICT")
    assert "身份" in msg and "重置" in msg


def test_rendered_config_escapes_credentials():
    creds = dict(IDENT, auth_token='a"b\\c\nd')
    text = ra.render_config({"host": "r.example.com", "port": 1}, creds, 22,
                            {"user": "u", "password": "p"}, None)
    assert 'auth.token = "a\\"b\\\\c\\nd"' in text


def test_status_disabled_by_default(env):
    assist, host, *_ = env
    configure(assist)
    s = assist.status()
    assert s["installed"] is True and s["enabled"] is False
    assert s["state"] == "disabled"
    assert s["server"] == {"host": "relay.example.com", "port": 443}
    assert s["credentials"] is True


def test_status_unavailable_when_component_missing(env):
    assist, host, clock, api, tmp = env
    (tmp / "client").unlink()
    s = assist.status()
    assert s["installed"] is False and s["state"] == "unavailable"
    assert "未安装" in s["message"]


def test_enable_requires_server_and_credentials(env):
    assist, host, *_ = env
    with pytest.raises(ra.RemoteAssistError, match="中转服务器"):
        assist.enable(actor="admin")
    assist.set_server("relay.example.com", 443, actor="admin")
    with pytest.raises(ra.RemoteAssistError, match="凭据"):
        assist.enable(actor="admin")
    assert not any(c[:2] == ["systemctl", "enable"] for c in host.calls)


def test_enable_writes_config_and_enables_unit_persistently(env):
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    assert ["systemctl", "enable", "--now", assist.unit] in host.calls
    cfg = (assist.dir / "client.toml").read_text()
    assert "localPort = 33888" in cfg and f"{CODE}-ssh" in cfg
    assert f'transport.tls.trustedCaFile = "{assist.dir / "ca.pem"}"' in cfg
    assert (assist.dir / "ca.pem").read_text() == CA
    assert oct((assist.dir / "client.toml").stat().st_mode & 0o777) == "0o640"
    events = assist.events()
    assert events[0]["type"] == "enabled" and events[0]["actor"] == "admin"


def test_enable_refused_without_server_certificate(env):
    assist, host, *_ = env
    assist.set_server("relay.example.com", 443, actor="admin")
    (assist.dir / "credentials.json").write_text(json.dumps({k: v for k, v in CREDS.items() if k != "ca_cert"}))
    assert assist.status()["credentials"] is False
    with pytest.raises(ra.RemoteAssistError, match="凭据"):
        assist.enable(actor="admin")
    assert not any(c[:2] == ["systemctl", "enable"] for c in host.calls)


def test_enable_refused_when_login_port_unknown(env):
    assist, host, *_ = env
    configure(assist)
    orig = host.run
    host.run = lambda argv, timeout=10: (1, "") if argv[:2] == ["sshd", "-T"] else orig(argv, timeout)
    assist.run = host.run
    with pytest.raises(ra.RemoteAssistError, match="远程登录端口"):
        assist.enable(actor="admin")
    assert not (assist.dir / "client.toml").exists()
    assert not assist._enabled()


def test_enable_failure_is_reported_in_chinese(env):
    assist, host, *_ = env
    configure(assist)
    host.fail_enable = True
    with pytest.raises(ra.RemoteAssistError, match="启动失败"):
        assist.enable(actor="admin")


def test_connected_when_tunnel_reports_running(env):
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    api["payload"] = {"stcp": [{"name": f"{CODE}-ssh", "status": "running", "err": ""}]}
    host.ss_out = ("0 0 127.0.0.1:33888 127.0.0.1:51000\n"
                   "0 0 192.168.1.5:33888 192.168.1.9:60000\n")
    s = assist.status()
    assert s["state"] == "connected" and s["sessions"] == 1
    assert s["enabled_at"] == 1_000_000


def test_connecting_then_error_with_translated_reason(env):
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    assert assist.status()["state"] == "connecting"
    clock[0] += 60
    host.journal = "login to the server failed: dial tcp 1.2.3.4:443: i/o timeout"
    s = assist.status()
    assert s["state"] == "error"
    assert "超时" in s["message"]
    assert "i/o" not in s["message"] and "dial" not in s["message"]


@pytest.mark.parametrize("raw,expect", [
    ("lookup relay.example.com: no such host", "解析"),
    ("dial tcp 1.2.3.4:443: connect: connection refused", "拒绝连接"),
    ("authorization failed: token mismatch", "凭据"),
    ("tls: failed to verify certificate: x509", "证书"),
    ("something unexpected", "自动重试"),
])
def test_error_translation(raw, expect):
    assert expect in ra.translate_error(raw)


@pytest.mark.parametrize("journal", [
    "login to the server failed: AINVR_SUSPENDED",
    "pong message contains error: AINVR_SUSPENDED",
])
def test_cloud_suspension_shown_as_suspended_state(env, journal):
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    clock[0] += 60
    host.journal = "start frpc service\nlogin to server success\n" + journal
    s = assist.status()
    assert s["state"] == "suspended" and s["enabled"] is True
    assert "暂停" in s["message"] and "自动重新连接" in s["message"]


def test_latest_failure_wins_over_older_suspension(env):
    """恢复后若因网络问题连不上，不能继续显示"云端已暂停"。"""
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    clock[0] += 60
    host.journal = ("login to the server failed: AINVR_SUSPENDED\n"
                    "login to the server failed: dial tcp 1.2.3.4:33888: i/o timeout")
    s = assist.status()
    assert s["state"] == "error" and "超时" in s["message"]


@pytest.mark.parametrize("raw,expect", [
    ("login to the server failed: AINVR_UNAUTHORIZED", "不认可本设备凭据"),
    ("login to the server failed: send Login request to plugin error", "鉴权暂不可用"),
    ("login to the server failed: AINVR_UNAVAILABLE", "鉴权暂不可用"),
])
def test_relay_auth_errors_translated(raw, expect):
    assert expect in ra.translate_error(raw)



def test_disable_stops_unit_and_logs(env):
    assist, host, *_ = env
    configure(assist)
    assist.enable(actor="admin")
    assist.disable(actor="admin")
    assert ["systemctl", "disable", assist.unit] in host.calls
    assert ["systemctl", "stop", assist.unit] in host.calls
    s = assist.status()
    assert s["state"] == "disabled" and s["enabled"] is False and s["running"] is False
    assert [e["type"] for e in assist.events()][:2] == ["disabled", "enabled"]


def test_disable_reports_failure_when_process_keeps_running(env):
    """取消自启成功、停止失败：不能报"已关闭"，状态要显示仍在运行。"""
    assist, host, *_ = env
    configure(assist)
    assist.enable(actor="admin")
    host.fail_stop = True
    with pytest.raises(ra.RemoteAssistError, match="仍在运行") as err:
        assist.disable(actor="admin")
    assert err.value.http == 500
    s = assist.status()
    assert s["enabled"] is False and s["running"] is True
    assert s["state"] == "stopping" and "仍在运行" in s["message"]
    assert assist.events()[0]["type"] == "enabled"


def test_status_disabled_but_running_counts_connections(env):
    assist, host, *_ = env
    configure(assist)
    host.active = "active"
    host.ss_out = "0 0 127.0.0.1:33888 127.0.0.1:51000\n"
    s = assist.status()
    assert s["state"] == "stopping" and s["sessions"] == 1


def test_status_unknown_when_systemd_query_fails(env):
    assist, host, *_ = env
    configure(assist)
    host.query_fails = True
    s = assist.status()
    assert s["state"] == "unknown"
    assert s["enabled"] is None and s["running"] is None
    assert "无法确认" in s["message"]


def test_server_change_refused_while_process_still_running(env):
    assist, host, *_ = env
    configure(assist)
    host.active = "active"
    with pytest.raises(ra.RemoteAssistError, match="请先关闭") as err:
        assist.set_server("other.example.com", 443, actor="admin")
    assert err.value.http == 409
    host.active = "inactive"
    host.query_fails = True
    with pytest.raises(ra.RemoteAssistError, match="无法确认") as err:
        assist.set_server("other.example.com", 443, actor="admin")
    assert err.value.http == 503
    assert assist._server()["host"] == "relay.example.com"


def test_server_cannot_change_while_enabled(env):
    assist, host, *_ = env
    configure(assist)
    assist.enable(actor="admin")
    with pytest.raises(ra.RemoteAssistError, match="请先关闭") as err:
        assist.set_server("other.example.com", 443, actor="admin")
    assert err.value.http == 409
    assert assist.status()["server"]["host"] == "relay.example.com"


def test_server_change_logged(env):
    assist, *_ = env
    assist.set_server("relay.example.com", 8443, actor="admin")
    ev = assist.events()[0]
    assert ev["type"] == "server_changed" and ev["detail"] == "relay.example.com:8443"


def test_session_monitor_logs_start_and_end(env):
    assist, host, clock, api, tmp = env
    configure(assist)
    assist.enable(actor="admin")
    host.ss_out = "0 0 127.0.0.1:33888 127.0.0.1:51000\n"
    assist.monitor_tick()
    clock[0] += 125
    host.ss_out = ""
    assist.monitor_tick()
    types = [e["type"] for e in assist.events()]
    assert types[:2] == ["session_ended", "session_started"]
    assert assist.events()[0]["detail"] == "持续约 2 分钟"


def test_events_capped(env):
    assist, *_ = env
    for i in range(ra.MAX_EVENTS * 2 + 5):
        assist._log("server_changed", "admin", str(i))
    events = assist.events(limit=1000)
    assert len(events) <= ra.MAX_EVENTS * 2
    assert events[0]["detail"] == str(ra.MAX_EVENTS * 2 + 4)


def test_connectivity_test_reports_dns_and_success(env):
    assist, *_ = env
    assist.set_server("nonexistent.invalid", 443, actor="admin")
    r = assist.test()
    assert r["ok"] is False and "解析" in r["message"]

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    threading.Thread(target=lambda: srv.accept()[0].close(), daemon=True).start()
    assist.set_server("127.0.0.1", port, actor="admin")
    r = assist.test()
    srv.close()
    assert r["ok"] is True and isinstance(r["latency_ms"], int)


def test_connectivity_test_requires_server(env):
    assist, *_ = env
    with pytest.raises(ra.RemoteAssistError, match="中转服务器"):
        assist.test()
