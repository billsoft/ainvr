"""管理页面：初始化码+首次设密、登录锁定、会话/CSRF/来源校验、参数白名单、改密使其他会话失效、安全响应头。"""
from __future__ import annotations

import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import relay_web as rw  # noqa: E402


class Fake:
    def __init__(self):
        self.calls = []
        self.reply = (0, json.dumps({"devices": [], "connections": []}), "")

    def __call__(self, args):
        self.calls.append(args)
        return self.reply


@pytest.fixture
def web(tmp_path):
    (tmp_path / "setup.code").write_text("abc123-def456-0a0b0c\n")
    fake = Fake()
    app = rw.App(rw.Auth(tmp_path), rw.Sessions(), runner=fake, public_ip="43.163.66.62", relay_port=33888)
    server = rw.TLSServer(("127.0.0.1", 0), rw.make_handler(app, secure=False), None)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    class Client:
        def __init__(self):
            self.cookie, self.csrf = None, None

        def req(self, method, path, body=None, headers=None, csrf=True):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            h = {"Content-Type": "application/json", "Host": f"127.0.0.1:{port}", **(headers or {})}
            if self.cookie:
                h["Cookie"] = self.cookie
            if csrf and self.csrf:
                h["X-CSRF-Token"] = self.csrf
            c.request(method, path, body=None if body is None else json.dumps(body), headers=h)
            r = c.getresponse()
            raw = r.read()
            sc = r.getheader("Set-Cookie")
            if sc:
                self.cookie = sc.split(";")[0]
            try:
                data = json.loads(raw)
            except ValueError:
                data = raw
            if isinstance(data, dict) and data.get("csrf"):
                self.csrf = data["csrf"]
            return r.status, data, r

    yield Client, fake, tmp_path, port
    server.shutdown()


def setup_admin(Client, password="correct horse 1"):
    c = Client()
    status, data, _ = c.req("POST", "/api/setup", {"code": "abc123-def456-0a0b0c", "password": password})
    assert status == 200, data
    return c


def test_first_visit_requires_setup_code(web):
    Client, fake, d, _ = web
    c = Client()
    assert c.req("GET", "/api/session")[1] == {"setup_required": True, "authenticated": False, "csrf": None}
    assert c.req("POST", "/api/setup", {"code": "wrong", "password": "correct horse 1"})[0] == 403
    assert c.req("POST", "/api/setup", {"code": "abc123-def456-0a0b0c", "password": "short"})[0] == 400
    assert c.req("POST", "/api/login", {"password": "x"})[0] == 409
    c = setup_admin(Client)
    assert not (d / "setup.code").exists()
    assert json.loads((d / "admin.json").read_text())["hash"]  # 只存哈希
    assert "correct horse" not in (d / "admin.json").read_text()
    assert c.req("GET", "/api/session")[1]["authenticated"] is True
    assert Client().req("POST", "/api/setup", {"code": "abc123-def456-0a0b0c", "password": "another pass 1"})[0] == 409


def test_login_and_lockout(web):
    Client, *_ = web
    setup_admin(Client)
    c = Client()
    for _ in range(5):
        assert c.req("POST", "/api/login", {"password": "nope"})[0] == 401
    assert c.req("POST", "/api/login", {"password": "correct horse 1"})[0] == 429


def test_api_requires_session_csrf_and_same_origin(web):
    Client, fake, _, port = web
    anon = Client()
    assert anon.req("GET", "/api/status")[0] == 401
    assert anon.req("POST", "/api/global/resume", {})[0] == 401
    c = setup_admin(Client)
    assert c.req("GET", "/api/status")[0] == 200
    assert fake.calls[-1] == ["--actor", "网页@127.0.0.1", "--json", "status"]
    assert c.req("POST", "/api/global/resume", {}, csrf=False)[0] == 403
    assert c.req("POST", "/api/global/resume", {}, headers={"Origin": "https://evil.example"})[0] == 403
    assert c.req("POST", "/api/global/resume", {}, headers={"Origin": f"https://127.0.0.1:{port}"})[0] == 200


def test_actions_map_to_relayctl_with_whitelisted_args(web):
    Client, fake, *_ = web
    c = setup_admin(Client)
    fake.reply = (0, "已暂停", "")
    c.req("POST", "/api/devices/abcd-1234-efgh-5678/suspend", {"reason": "客户占用\n; rm -rf /", "hard": True})
    assert fake.calls[-1] == ["--actor", "网页@127.0.0.1", "suspend", "ABCD1234EFGH5678", "--reason", "客户占用; rm -rf /", "--hard"]
    c.req("POST", "/api/devices/ABCD1234EFGH5678/resume", {})
    assert fake.calls[-1][-2:] == ["resume", "ABCD1234EFGH5678"]
    c.req("POST", "/api/devices/ABCD1234EFGH5678/reset", {})
    assert fake.calls[-1][-2:] == ["reset", "ABCD1234EFGH5678"]
    c.req("POST", "/api/global/suspend", {"reason": "维护", "hard": "yes"})  # 非 True 不算强制
    assert fake.calls[-1][2:] == ["suspend", "--all", "--reason", "维护"]
    n = len(fake.calls)
    for path, body in [("/api/devices/A%20B/suspend", {}), ("/api/devices/..%2Fx/resume", {}),
                       ("/api/devices/A001/suspend", {}), ("/api/work", {"device": "--clear"}),
                       ("/api/work", {"device": ["ABCD1234EFGH5678"]})]:
        assert c.req("POST", path, body)[0] == 400
    for path in ["/api/operators", "/api/visitor", "/api/devices", "/api/devices/ABCD1234EFGH5678/rotate"]:
        assert c.req("POST", path, {})[0] == 404  # 免开通后不再有开通、人员与访问端接口
    assert len(fake.calls) == n  # 不合法参数不触发 relayctl


def test_work_endpoint_sets_and_clears_current_device(web):
    Client, fake, *_ = web
    c = setup_admin(Client)
    fake.reply = (0, "当前工作设备", "")
    assert c.req("POST", "/api/work", {"device": "abcd-1234-efgh-5678"})[0] == 200
    assert fake.calls[-1][-2:] == ["work", "ABCD1234EFGH5678"]
    assert c.req("POST", "/api/work", {"device": ""})[0] == 200
    assert fake.calls[-1][-2:] == ["work", "--clear"]


def test_fleet_material_endpoint(web):
    Client, fake, *_ = web
    c = setup_admin(Client)
    fake.reply = (0, json.dumps({"credentials.json": "{}", "server.json": "{}"}), "")
    status, data, _ = c.req("POST", "/api/fleet", {})
    assert status == 200 and data["material"]["server.json"] == "{}"
    assert fake.calls[-1] == ["--actor", "网页@127.0.0.1", "--json", "fleet", "--server", "43.163.66.62", "--port", "33888"]


def test_relayctl_failure_message_passed_through(web):
    Client, fake, *_ = web
    c = setup_admin(Client)
    fake.reply = (1, "", "操作失败：设备 ABCD 还没有连上来过")
    status, data, _ = c.req("POST", "/api/work", {"device": "ABCD1234EFGH5678"})
    assert status == 400 and data["error"] == "设备 ABCD 还没有连上来过"
    fake.reply = (1, "", "sudo: a password is required")
    status, data, _ = c.req("POST", "/api/devices/ABCD1234EFGH5678/suspend", {})
    assert status == 500 and "relayctl" in data["error"]


def test_password_change_invalidates_other_sessions(web):
    Client, *_ = web
    a = setup_admin(Client)
    b = Client(); assert b.req("POST", "/api/login", {"password": "correct horse 1"})[0] == 200
    assert a.req("POST", "/api/password", {"old": "wrong", "new": "new password 1"})[0] == 403
    assert a.req("POST", "/api/password", {"old": "correct horse 1", "new": "new password 1"})[0] == 200
    assert b.req("GET", "/api/status")[0] == 401
    assert a.req("GET", "/api/status")[0] == 200
    assert Client().req("POST", "/api/login", {"password": "new password 1"})[0] == 200


def test_web_reset_on_server_kills_existing_sessions(web):
    """服务器上 relayctl web-reset 删除密码文件后，已登录的浏览器必须立即失效。"""
    Client, fake, d, _ = web
    c = setup_admin(Client)
    assert c.req("GET", "/api/status")[0] == 200
    (d / "admin.json").unlink()
    assert c.req("GET", "/api/status")[0] == 401
    assert c.req("GET", "/api/session")[1]["authenticated"] is False


def test_logout(web):
    Client, *_ = web
    c = setup_admin(Client)
    assert c.req("POST", "/api/logout", {})[0] == 200
    assert c.req("GET", "/api/status")[0] == 401


def test_static_pages_have_strict_security_headers(web):
    Client, *_ = web
    for path in ("/", "/app.js", "/app.css"):
        status, _, r = Client().req("GET", path)
        assert status == 200
        csp = r.getheader("Content-Security-Policy")
        assert "script-src 'self'" in csp and "unsafe-inline" not in csp and "frame-ancestors 'none'" in csp
        assert r.getheader("X-Frame-Options") == "DENY"


def test_session_cookie_flags(web):
    Client, *_ = web
    c = Client()
    _, _, r = c.req("POST", "/api/setup", {"code": "abc123-def456-0a0b0c", "password": "correct horse 1"})
    flags = r.getheader("Set-Cookie")
    assert "HttpOnly" in flags and "SameSite=Strict" in flags
    secure = rw.make_handler(rw.App(rw.Auth(Path(".")), rw.Sessions()), secure=True)
    assert secure  # 生产（TLS）下附加 Secure，见 make_handler


def test_session_idle_expiry():
    t = [0.0]
    s = rw.Sessions(now=lambda: t[0], version=lambda: "v1")
    tok, _ = s.create()
    t[0] = rw.IDLE_SECONDS - 1; assert s.get(tok)
    t[0] += rw.IDLE_SECONDS + 1; assert s.get(tok) is None


def test_frontend_never_uses_innerhtml():
    js = (Path(rw.__file__).parent / "relay_web.js").read_text(encoding="utf-8")
    assert "innerHTML" not in js and "style:" not in js


def test_server_name_prefers_domain_over_ip():
    assert rw.server_from_env({"AINVR_RELAY_SERVER": "relay.gpling.com", "AINVR_RELAY_PUBLIC_IP": "43.163.66.62"}) == "relay.gpling.com"
    assert rw.server_from_env({"AINVR_RELAY_PUBLIC_IP": "43.163.66.62"}) == "43.163.66.62"  # 旧安装
    assert rw.server_from_env({}) == "127.0.0.1"
