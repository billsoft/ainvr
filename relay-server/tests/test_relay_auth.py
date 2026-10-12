"""鉴权插件：免开通设备按机器码首次记住、冒充被拒、隧道绑定与访问者范围、工作访问端、暂停、读不到状态一律拒绝。"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import relay_auth as ra  # noqa: E402

A = "AAAA1111BBBB2222"
B = "CCCC3333DDDD4444"
TOK_A = "device-token-of-a-0123456789"
RELAY_TOK = "relay-token-0123456789abcdef"


def state(**over):
    s = {"version": 2, "global_suspended": False, "devices": {}, "relay_token_sha256": ra.token_hash(RELAY_TOK)}
    s.update(over)
    return s


@pytest.fixture
def ids(tmp_path):
    path = tmp_path / "identities.json"
    path.write_text(json.dumps({"version": 1, "devices": {}}))
    clock = [1000.0]
    i = ra.Identities(path, now=lambda: clock[0], retry=0)
    i.clock = clock
    return i


def dev(op="Login", token=TOK_A, device=A, user=None, **content):
    metas = {"role": "device", "device": device, "device_token": token}
    user = device.replace("-", "").upper() if user is None else user
    return op, ({"metas": metas, "user": user, **content} if op == "Login"
                else {"user": {"user": user, "metas": metas}, **content})


def relay(op="Login", token=RELAY_TOK, device=A, user=None, addr="127.0.0.1:50000", **content):
    metas = {"role": "relay", "device": device, "relay_token": token}
    user = device if user is None else user
    return op, ({"metas": metas, "user": user, "client_address": addr, **content} if op == "Login"
                else {"user": {"user": user, "metas": metas}, **content})


def test_new_device_is_remembered_on_first_login_without_provisioning(ids):
    assert ra.decide(state(), ids, *dev()) == (True, "", f"device:{A}")
    data = json.loads(ids.path.read_text())["devices"][A]
    assert data["token_sha256"] == ra.token_hash(TOK_A) and data["first_seen"] == 1000
    assert TOK_A not in ids.path.read_text()  # 只存哈希
    assert oct(ids.path.stat().st_mode & 0o777) == "0o600"
    for op in ("Ping", "NewWorkConn"):
        assert ra.decide(state(), ids, *dev(op))[0] is True


def test_grouped_machine_code_is_normalized(ids):
    assert ra.decide(state(), ids, *dev(device="aaaa-1111-bbbb-2222"))[0] is True
    assert A in ids.snapshot()


@pytest.mark.parametrize("op", ["Login", "Ping", "NewWorkConn", "NewProxy"])
def test_impersonating_known_machine_code_rejected(ids, op):
    """拿到安装包统一凭据的人冒用在线设备的机器码：令牌不符即拒绝，不能借 user 绑定访问该设备隧道。"""
    ra.decide(state(), ids, *dev())
    allow, reason, _ = ra.decide(state(), ids, *dev(op, token="attacker-token-000000000000",
                                                    proxy_name=f"{A}-ssh", proxy_type="stcp"))
    assert allow is False and reason == ra.CONFLICT
    assert ids.snapshot()[A]["first_seen"] == 1000  # 冒用不改写已记住的身份


def test_unknown_device_only_registers_on_login(ids):
    assert ra.decide(state(), ids, *dev("Ping"))[1] == ra.UNAUTHORIZED
    assert A not in ids.snapshot()


@pytest.mark.parametrize("args", [dev(user=""), dev(user=B), dev(device="short"), dev(device="A001"),
                                  dev(token=""), dev(token="x" * 8), ("Login", {"metas": {"role": "device"}}),
                                  ("Login", {"metas": {}}), ("Login", {})])
def test_malformed_device_login_rejected(ids, args):
    allow, reason, _ = ra.decide(state(), ids, *args)
    assert allow is False and reason == ra.UNAUTHORIZED
    assert ids.snapshot() == {}


def test_reset_lets_reinstalled_device_be_remembered_again(ids):
    ra.decide(state(), ids, *dev())
    new = "reinstalled-token-0123456789"
    assert ra.decide(state(), ids, *dev(token=new))[1] == ra.CONFLICT
    ids.clock[0] = 2000
    s = state(devices={A: {"reset_at": 1500}})
    assert ra.decide(s, ids, *dev(token=new))[0] is True
    assert ids.snapshot()[A]["first_seen"] == 2000
    assert ra.decide(s, ids, *dev())[1] == ra.CONFLICT  # 旧令牌此后反而被拒


def test_identity_table_unreadable_fails_closed_and_never_relearns(tmp_path):
    path = tmp_path / "identities.json"
    i = ra.Identities(path, retry=0)
    assert ra.decide(state(), i, *dev())[1] == ra.UNAVAILABLE  # 文件缺失：不能当空表重新记住
    assert not path.exists()
    path.write_text("{broken")
    assert ra.decide(state(), i, *dev())[1] == ra.UNAVAILABLE
    path.write_text(json.dumps({"version": 1, "devices": {A: {"token_sha256": ra.token_hash(TOK_A), "first_seen": 1}}}))
    assert ra.decide(state(), i, *dev(token="attacker-token-000000000000"))[1] == ra.CONFLICT
    assert ra.decide(state(), i, *dev())[0] is True


def test_identity_table_is_capped(tmp_path):
    path = tmp_path / "identities.json"
    path.write_text(json.dumps({"version": 1, "devices": {}}))
    i = ra.Identities(path, retry=0, max_items=1)
    assert ra.decide(state(), i, *dev())[0] is True
    assert ra.decide(state(), i, *dev(device=B))[1] == ra.UNAUTHORIZED


def test_device_may_only_register_its_own_stcp_tunnel(ids):
    ra.decide(state(), ids, *dev())  # frp 先 Login 再 NewProxy
    ok = dict(proxy_type="stcp")
    assert ra.decide(state(), ids, *dev("NewProxy", proxy_name=f"{A}-ssh", **ok))[0] is True
    assert ra.decide(state(), ids, *dev("NewProxy", proxy_name=f"{A}.{A}-ssh", **ok))[0] is True
    for name, typ in [(f"{B}-ssh", "stcp"), (f"{B}.{A}-ssh", "stcp"), (f"{A}-ssh", "tcp"), (f"{A}-ssh", "xtcp")]:
        assert ra.decide(state(), ids, *dev("NewProxy", proxy_name=name, proxy_type=typ))[1] == ra.UNAUTHORIZED


@pytest.mark.parametrize("allow", [["*"], [B], [A, B], [""], "*"])
def test_device_cannot_widen_tunnel_visitors(ids, allow):
    ra.decide(state(), ids, *dev())
    """显式访问名单会覆盖 frp 的"仅同 user"默认限制，重新打开匿名/他人访问路径，必须拒绝。"""
    args = dev("NewProxy", proxy_name=f"{A}-ssh", proxy_type="stcp", allow_users=allow)
    assert ra.decide(state(), ids, *args)[1] == ra.UNAUTHORIZED


@pytest.mark.parametrize("allow", [None, [], [A]])
def test_default_or_own_visitor_scope_allowed(ids, allow):
    ra.decide(state(), ids, *dev())
    extra = {} if allow is None else {"allow_users": allow}
    assert ra.decide(state(), ids, *dev("NewProxy", proxy_name=f"{A}-ssh", proxy_type="stcp", **extra))[0] is True


@pytest.mark.parametrize("op", ["Login", "Ping", "NewWorkConn", "NewProxy"])
def test_suspended_device_rejected_with_marker(ids, op):
    ra.decide(state(), ids, *dev())
    s = state(devices={A: {"suspended": True}})
    extra = {"proxy_name": f"{A}-ssh", "proxy_type": "stcp"} if op == "NewProxy" else {}
    assert ra.decide(s, ids, *dev(op, **extra)) == (False, ra.SUSPENDED, f"device:{A}")
    assert ra.decide(state(global_suspended=True), ids, *dev(op, **extra))[1] == ra.SUSPENDED


def test_wrong_token_beats_suspension_marker(ids):
    """凭据不对时不能泄露设备是否被暂停。"""
    ra.decide(state(), ids, *dev())
    s = state(devices={A: {"suspended": True}})
    assert ra.decide(s, ids, *dev(token="attacker-token-000000000000"))[1] == ra.CONFLICT


def test_relay_visitor_rules(ids):
    ra.decide(state(), ids, *dev())
    assert ra.decide(state(), ids, *relay())[0] is True
    assert ra.decide(state(), ids, *relay("Ping"))[0] is True
    for args in [relay(token="bad-token-0000000000000"), relay(addr="9.9.9.9:1"), relay(addr="[::ffff:9.9.9.9]:1"),
                 relay(user=B), relay(device="bad"), relay("NewProxy", proxy_name="x", proxy_type="tcp")]:
        assert ra.decide(state(), ids, *args)[1] == ra.UNAUTHORIZED
    assert ra.decide(state(relay_token_sha256=""), ids, *relay())[1] == ra.UNAUTHORIZED
    assert ra.decide(state(), ids, *relay(addr="[::1]:5"))[0] is True


def test_operator_role_no_longer_exists(ids):
    metas = {"role": "operator", "operator": "alice", "operator_token": "x"}
    assert ra.decide(state(), ids, "Login", {"metas": metas, "user": A})[1] == ra.UNAUTHORIZED


def test_no_state_fails_closed(ids):
    assert ra.decide(None, ids, *dev()) == (False, ra.UNAVAILABLE, "-")


def test_store_fails_closed_when_file_corrupt_or_missing(tmp_path, ids):
    """读不到鉴权状态立即拒绝，恢复读取后再放行（不沿用旧权限）。"""
    path = tmp_path / "auth.json"
    store = ra.Store(path, check_interval=0)
    ra.write_state(path, state())
    assert ra.decide(store.get(), ids, *dev())[0] is True
    time.sleep(0.01); path.write_text("{broken")
    assert store.get() is None and ra.decide(store.get(), ids, *dev())[1] == ra.UNAVAILABLE
    path.unlink()
    assert store.get() is None
    ra.write_state(path, state())
    assert ra.decide(store.get(), ids, *dev())[0] is True


def test_store_reloads_on_change(tmp_path):
    path = tmp_path / "auth.json"
    store = ra.Store(path, check_interval=0)
    assert store.get() is None
    ra.write_state(path, state())
    assert store.get()["devices"] == {}
    time.sleep(0.01); ra.write_state(path, state(devices={A: {"suspended": True}}))
    assert store.get()["devices"][A]["suspended"] is True
    assert oct(os.stat(path).st_mode & 0o777) in ("0o640", "0o644", "0o664")


def test_rejection_logging_is_rate_limited():
    clock = [0.0]
    lim = ra.LogLimiter(interval=60, now=lambda: clock[0], max_keys=3)
    key = ("Ping", "device:X", ra.UNAUTHORIZED)
    assert lim.allow(key) is True
    assert all(lim.allow(key) is False for _ in range(1000))
    assert lim.allow(("Login", "device:X", ra.UNAUTHORIZED)) is True
    clock[0] = 61
    assert lim.allow(key) is True
    for i in range(10):
        lim.allow(("Ping", f"device:{i}", ra.UNAUTHORIZED))
    assert len(lim._last) <= 4


def test_sessions_record_logins_and_conflicts():
    s = ra.Sessions(max_items=2, now=lambda: 5)
    s.record(f"device:{A}", {"hostname": "nvr", "client_address": "60.1.1.1:5000"})
    s.record(f"relay:{A}", {"hostname": "cloud", "client_address": "[::1]:6000"})
    s.record(f"relay:{B}", {"hostname": "cloud", "client_address": "[::1]:6001"})
    snap = s.snapshot()
    assert {(x["role"], x["name"], x["ip"]) for x in snap["logins"]} == {("device", A, "60.1.1.1"), ("relay", B, "::1")}
    s.conflict(A, {"hostname": "evil", "client_address": "6.6.6.6:1"})
    assert s.snapshot()["conflicts"] == [{"device": A, "hostname": "evil", "ip": "6.6.6.6", "ts": 5}]
    s.record(f"device:{A}", {"hostname": "nvr", "client_address": "60.1.1.1:5000"})
    assert s.snapshot()["conflicts"] == []  # 真设备重新登录成功后清除冲突标记


def test_http_handler_speaks_frps_plugin_protocol(tmp_path, ids):
    path = tmp_path / "auth.json"
    ra.write_state(path, state(devices={B: {"suspended": True}}))
    server = ra.http.server.ThreadingHTTPServer(("127.0.0.1", 0), ra.make_handler(ra.Store(path, 0), ids))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(op, content, raw=None):
        body = raw if raw is not None else json.dumps({"version": "0.1.0", "op": op, "content": content}).encode()
        req = urllib.request.Request(f"{base}/handler?op={op}", data=body, headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=5).read())
    try:
        login = dict(dev()[1], hostname="nvr", client_address="60.1.1.1:5")
        assert call("Login", login) == {"reject": False, "unchange": True}
        assert call(*dev(device=B, token="token-of-b-000000000000")) == {"reject": True, "reject_reason": ra.SUSPENDED}
        evil = dict(dev(token="attacker-token-000000000000")[1], hostname="evil", client_address="6.6.6.6:1")
        assert call("Login", evil) == {"reject": True, "reject_reason": ra.CONFLICT}
        assert call("Login", None, raw=b"not json") == {"reject": True, "reject_reason": ra.UNAUTHORIZED}
        sess = json.loads(urllib.request.urlopen(base + "/sessions", timeout=5).read())
        assert {"role": "device", "name": A, "ip": "60.1.1.1"}.items() <= sess["logins"][-1].items()
        assert sess["conflicts"][0]["ip"] == "6.6.6.6"
        ident = json.loads(urllib.request.urlopen(base + "/identities", timeout=5).read())
        assert ident["available"] is True and set(ident["devices"]) == {A, B}
        assert "token_sha256" not in json.dumps(ident)  # 管理接口不外露令牌哈希
    finally:
        server.shutdown()


def test_relay_visitor_accepts_this_hosts_own_non_loopback_address(ids, monkeypatch):
    """云服务器上连 127.0.0.1 的来源可能显示为本机内网地址（实测 10.3.0.16）：本机地址都应放行，外部地址拒绝。"""
    ra.decide(state(), ids, *dev())
    monkeypatch.setattr(ra, "_bindable", lambda ip: ip == "10.3.0.16")
    assert ra.decide(state(), ids, *relay(addr="10.3.0.16:54472"))[0] is True
    assert ra.decide(state(), ids, *relay(addr="10.3.0.17:54472"))[1] == ra.UNAUTHORIZED
    assert ra.decide(state(), ids, *relay(addr="garbage"))[1] == ra.UNAUTHORIZED


def test_bindable_detects_local_addresses():
    assert ra._bindable("127.0.0.1") is True
    assert ra._bindable("203.0.113.9") is False  # 文档保留地址，不可能是本机
