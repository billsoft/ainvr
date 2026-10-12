"""relayctl：免开通的统一接入凭据、当前工作设备切换、按机器码暂停/重置身份/备注、状态汇总、审计。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "os-helper"))
import relay_auth  # noqa: E402
import relayctl  # noqa: E402
import remote_assist  # noqa: E402

CA = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n"
A = "AAAA1111BBBB2222"
B = "CCCC3333DDDD4444"


@pytest.fixture
def relay(tmp_path):
    conf = tmp_path / "conf"
    (conf / "tls").mkdir(parents=True)
    (conf / "token").write_text("global-tok\n")
    (conf / "tls" / "ca.crt").write_text(CA)
    restarts, units = [], []
    known = {A: {"first_seen": 900}, B: {"first_seen": 950}}
    r = relayctl.Relay(conf, gid=lambda: None, now=lambda: 1000, restart=lambda: restarts.append(1),
                       fetch_online=lambda: {}, fetch_clients=lambda: {}, fetch_sessions=lambda: {},
                       fetch_identities=lambda: known, systemctl=lambda *a: units.append(a),
                       service_state=lambda unit: "active", actor="tester")
    r.restarts, r.units, r.known = restarts, units, known
    return r


def auth(r):
    return json.loads((r.conf / "auth.json").read_text())


def toml(r):
    return (r.conf / "work.toml").read_text()


def test_fleet_material_is_shared_and_stable(relay, tmp_path):
    with pytest.raises(relayctl.RelayError):
        relay.fleet()  # 首次必须给出服务器地址
    m1 = relay.fleet("43.163.66.62")
    creds = json.loads(m1["credentials.json"])
    assert creds == {"auth_token": "global-tok", "secret_key": creds["secret_key"], "server_name": "43.163.66.62", "ca_cert": CA}
    assert json.loads(m1["server.json"]) == {"host": "43.163.66.62", "port": 33888}
    assert relay.fleet() == m1  # 再次导出不换密钥（已出货设备继续可用）
    assert oct((relay.conf / "fleet.json").stat().st_mode & 0o777) == "0o600"
    # 设备端直接接受：无需设备编号、设备令牌
    state = tmp_path / "state"; state.mkdir()
    for name, text in m1.items():
        (state / name).write_text(text)
    assist = remote_assist.RemoteAssist(state, run=lambda argv, timeout=10: (1, ""))
    assert assist._credentials() is not None and assist._server() == {"host": "43.163.66.62", "port": 33888}


def test_work_points_fixed_local_entry_at_selected_device(relay, tmp_path):
    relay.fleet("43.163.66.62")
    cmd = relay.work("aaaa-1111-bbbb-2222")
    text = toml(relay)
    secret = json.loads((relay.conf / "fleet.json").read_text())["secret_key"]
    assert f'user = "{A}"' in text and 'metadatas.role = "relay"' in text and f'serverName = "{A}-ssh"' in text
    assert f'secretKey = "{secret}"' in text and 'bindAddr = "127.0.0.1"' in text and "bindPort = 6000" in text
    assert "loginFailExit = false" in text and 'serverAddr = "127.0.0.1"' in text
    assert oct((relay.conf / "work.toml").stat().st_mode & 0o777) == "0o600"
    assert relay.units[-1] == ("restart", "ainvr-relay-work")
    assert auth(relay)["work_device"] == A
    assert cmd == f"ssh -J ubuntu@43.163.66.62 -p 6000 -o HostKeyAlias=ainvr-{A} ainvr@127.0.0.1"
    # 插件认得工作访问端：令牌来自同一份配置
    token = (relay.conf / "relay.token").read_text().strip()
    ids_path = tmp_path / "ids.json"
    ids_path.write_text(json.dumps({"version": 1, "devices": {A: {"token_sha256": "x", "first_seen": 1}}}))
    ids = relay_auth.Identities(ids_path)
    login = {"user": A, "client_address": "127.0.0.1:1", "metas": {"role": "relay", "device": A, "relay_token": token}}
    assert relay_auth.decide(auth(relay), ids, "Login", login)[0] is True


def test_work_switch_and_clear(relay):
    relay.fleet("1.2.3.4")
    relay.work(A)
    token = (relay.conf / "relay.token").read_text()
    relay.work(B)
    assert f'user = "{B}"' in toml(relay) and auth(relay)["work_device"] == B
    assert (relay.conf / "relay.token").read_text() == token  # 切换不换令牌
    assert relay.work(None) is None
    assert relay.units[-1] == ("stop", "ainvr-relay-work") and not (relay.conf / "work.toml").exists()
    assert "work_device" not in auth(relay)
    actions = [json.loads(l)["action"] for l in (relay.conf / "audit.log").read_text().splitlines()]
    assert actions[-3:] == ["work", "work", "work-clear"]


def test_work_refuses_unknown_device_bad_code_or_missing_fleet(relay):
    with pytest.raises(relayctl.RelayError, match="统一接入凭据"):
        relay.work(A)
    relay.fleet("1.2.3.4")
    with pytest.raises(relayctl.RelayError, match="还没有连上来过"):
        relay.work("ZZZZ9999ZZZZ9999")
    for bad in ("A001", "", "AAAA1111BBBB2222; rm -rf /"):
        with pytest.raises(relayctl.RelayError, match="机器码"):
            relay.work(bad)
    assert relay.units == []


def test_suspend_resume_by_machine_code_without_registration(relay):
    relay.suspend("aaaa-1111-bbbb-2222", "欠费")
    assert auth(relay)["devices"][A] == {"suspended": True, "reason": "欠费"}
    relay.suspend(None, "维护")
    relay.resume(None)
    assert auth(relay)["devices"][A]["suspended"] is True and auth(relay)["global_suspended"] is False
    relay.resume(A)
    assert auth(relay)["devices"][A]["suspended"] is False


def test_hard_suspend_single_device_kills_only_its_connections(relay):
    killed = []
    relay.kill_ip = lambda ip: killed.append(ip) or True
    relay.fetch_online = lambda: {A: {"status": "online", "clientID": "c1"}}
    relay.fetch_clients = lambda: {"c1": {"clientIP": "60.1.1.1"}}
    assert relay.suspend(A, hard=True) == "ip"
    assert killed == ["60.1.1.1"] and relay.restarts == []


def test_hard_suspend_falls_back_to_restart(relay):
    relay.kill_ip = lambda ip: False
    relay.fetch_online = lambda: {A: {"status": "online", "clientID": "c1"}}
    relay.fetch_clients = lambda: {"c1": {"clientIP": "60.1.1.1"}}
    assert relay.suspend(A, hard=True) == "restart" and relay.restarts == [1]
    relay.fetch_online = lambda: {}
    relay.restarts.clear()
    assert relay.suspend(A, hard=True) == "offline" and relay.restarts == []
    relay.suspend(None, hard=True)
    assert relay.restarts == [1]


def test_reset_identity_and_label(relay):
    relay.reset(A)
    assert auth(relay)["devices"][A]["reset_at"] == 1000
    relay.label(A, "某客户\n大门")
    assert json.loads((relay.conf / "labels.json").read_text()) == {A: "某客户大门"}
    relay.label(A, "")
    assert json.loads((relay.conf / "labels.json").read_text()) == {}


def test_default_proxy_parser_maps_tunnels_to_machine_codes(monkeypatch, tmp_path):
    monkeypatch.setattr(relayctl, "_dashboard", lambda conf, path: {"proxies": [
        {"name": f"{A}.{A}-ssh", "status": "online"}, {"name": f"{B}-ssh", "status": "offline"},
        {"name": "random", "status": "online"}]})
    out = relayctl._default_fetch_online(tmp_path)
    assert set(out) == {A, B} and out[A]["status"] == "online"


def test_status_lists_every_device_that_showed_up(relay):
    relay.fleet("1.2.3.4")
    relay.label(A, "某客户"); relay.suspend(B, "欠费")
    relay.fetch_online = lambda: {A: {"status": "online", "clientID": "c1", "curConns": 2, "lastStartTime": "10-08 13:00",
                                      "todayTrafficIn": 10, "todayTrafficOut": 20}}
    relay.fetch_clients = lambda: {"c1": {"clientIP": "60.1.1.1", "hostname": "nvr-a", "lastConnectedAt": 100},
                                   "c9": {"clientIP": "127.0.0.1", "hostname": "cloud", "lastConnectedAt": 200}}
    relay.fetch_sessions = lambda: {"logins": [{"role": "relay", "name": A, "hostname": "cloud", "ip": "127.0.0.1", "ts": 1}],
                                    "conflicts": [{"device": B, "hostname": "evil", "ip": "6.6.6.6", "ts": 999}]}
    relay.work(A)
    s = relay.status()
    a, b = s["devices"]
    assert a == {"device": A, "grouped": "AAAA-1111-BBBB-2222", "label": "某客户", "suspended": False, "reason": "",
                 "online": True, "first_seen": 900, "conflict": None, "work": True, "conns": 2,
                 "last_start": "10-08 13:00", "last_close": "", "traffic_in": 10, "traffic_out": 20,
                 "client_ip": "60.1.1.1", "hostname": "nvr-a", "connected_at": 100}
    assert b["suspended"] is True and b["online"] is False and b["conflict"]["ip"] == "6.6.6.6"
    assert s["work"]["device"] == A and "HostKeyAlias" in s["work"]["command"] and s["work"]["state"] == "active"
    assert {c["id"]: (c["role"], c["name"]) for c in s["connections"]} == {"c1": ("device", A), "c9": ("relay", A)}
    assert s["identities_ok"] and s["dashboard_ok"] and s["fleet_ready"]
    relay.reset(B)  # 重置后，此前的冲突记录不再显示
    assert relay.status()["devices"][1]["conflict"] is None


def test_status_when_sources_unreadable(relay):
    relay.fetch_online = lambda: None; relay.fetch_clients = lambda: None; relay.fetch_identities = lambda: None
    relay.label(A, "x")
    s = relay.status()
    assert s["dashboard_ok"] is False and s["identities_ok"] is False
    assert s["devices"][0]["online"] is None and s["work"]["device"] == ""


def test_cli_messages_and_errors(relay, capsys):
    relay.fleet("1.2.3.4")
    assert relayctl.main(["work", "aaaa-1111-bbbb-2222"], relay=relay) == 0
    out = capsys.readouterr().out
    assert "AAAA-1111-BBBB-2222" in out and "HostKeyAlias" in out
    assert relayctl.main(["list"], relay=relay) == 0
    out = capsys.readouterr().out
    assert "★AAAA-1111-BBBB-2222" in out and "当前工作设备" in out
    assert relayctl.main(["work", "--clear"], relay=relay) == 0
    assert "已结束" in capsys.readouterr().out
    assert relayctl.main(["suspend", "NOPE"], relay=relay) == 1
    assert "操作失败" in capsys.readouterr().err
    assert relayctl.main(["reset", A], relay=relay) == 0
    assert relayctl.main(["--json", "fleet"], relay=relay) == 0
    assert set(json.loads(capsys.readouterr().out.splitlines()[-1])) == {"credentials.json", "server.json"}
    assert relayctl.main(["--json", "audit", "--limit", "2"], relay=relay) == 0
    assert len(json.loads(capsys.readouterr().out)) == 2
    for removed in (["provision", A, "--server", "x"], ["operator-add", "a"], ["visitor", A, "--operator", "a"]):
        with pytest.raises(SystemExit):
            relayctl.main(removed, relay=relay)


def test_audit_log_records_actor_action_target_reason(relay):
    relay.suspend(A, "排查")
    lines = [json.loads(l) for l in (relay.conf / "audit.log").read_text().splitlines()]
    assert lines[-1] == {"ts": 1000, "actor": "tester", "action": "suspend", "target": A, "reason": "排查"}


def test_web_reset_clears_admin_and_issues_code(relay, tmp_path):
    relay.web_dir = tmp_path / "web"; relay.web_dir.mkdir()
    (relay.web_dir / "admin.json").write_text("{}")
    code = relay.web_reset()
    assert not (relay.web_dir / "admin.json").exists()
    assert (relay.web_dir / "setup.code").read_text().strip() == code and len(code) == 20
