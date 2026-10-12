#!/usr/bin/env python3
"""
远程协助中转管理页面（HTTPS，默认 8181 端口，只用标准库）。

- 首次打开需输入服务器上的初始化码并设置管理员密码；之后只验证密码。
  忘记密码：在服务器上 `sudo relayctl web-reset` 生成新的初始化码。
- 所有操作都通过 `sudo relayctl` 执行，与命令行同一套逻辑；页面不可用时命令行可完成全部操作。
- 安全：scrypt 密码哈希、登录失败锁定、HttpOnly+Secure+SameSite=Strict 会话、写操作 CSRF 令牌与来源校验、
  严格内容安全策略；以独立低权限账号运行，只能通过 sudoers 白名单调用 relayctl。
"""
from __future__ import annotations

import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit

STATIC_DIR = Path(__file__).resolve().parent
MACHINE_CODE = re.compile(r"^[A-Z0-9]{16,32}$")
MAX_BODY = 16 * 1024
IDLE_SECONDS, ABSOLUTE_SECONDS = 2 * 3600, 12 * 3600
STATIC = {"/": ("relay_web.html", "text/html; charset=utf-8"),
          "/app.js": ("relay_web.js", "application/javascript; charset=utf-8"),
          "/app.css": ("relay_web.css", "text/css; charset=utf-8")}
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                               "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _clean(text, limit: int) -> str:
    return "".join(ch for ch in str(text or "") if ch.isprintable()).strip()[:limit]


# ---------------------------------------------------------------- 认证
class Auth:
    def __init__(self, state_dir: Path, now=time.time) -> None:
        self.dir, self.now = Path(state_dir), now
        self._lock = threading.Lock()
        self._fails: dict[str, list[float]] = {}

    @property
    def admin_file(self) -> Path:
        return self.dir / "admin.json"

    def setup_required(self) -> bool:
        return not self.admin_file.exists()

    def version(self) -> str | None:
        """当前密码版本；密码被修改或在服务器上重置（删除）后，旧会话随之失效。"""
        try:
            return json.loads(self.admin_file.read_text())["hash"]
        except (OSError, ValueError, KeyError):
            return None

    @staticmethod
    def _hash(password: str, salt: bytes) -> str:
        return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32).hex()

    def _store(self, password: str) -> None:
        salt = secrets.token_bytes(16)
        data = {"salt": salt.hex(), "hash": self._hash(password, salt), "updated_at": int(self.now())}
        tmp = self.admin_file.with_name(".admin.json.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.admin_file)

    @staticmethod
    def _check_new(password: str) -> None:
        if not isinstance(password, str) or not 10 <= len(password) <= 128:
            raise ApiError(400, "密码长度需为 10–128 个字符")

    # 失败锁定：同一 IP 5 分钟内 5 次、全局 5 分钟内 30 次失败即暂停登录
    def _locked(self, ip: str) -> bool:
        t = self.now()
        with self._lock:
            for key in list(self._fails):
                self._fails[key] = [x for x in self._fails[key] if t - x < 300]
                if not self._fails[key]:
                    del self._fails[key]
            return len(self._fails.get(ip, [])) >= 5 or sum(len(v) for v in self._fails.values()) >= 30

    def _fail(self, ip: str) -> None:
        with self._lock:
            self._fails.setdefault(ip, []).append(self.now())

    def setup(self, code: str, password: str, ip: str) -> None:
        if self._locked(ip):
            raise ApiError(429, "尝试过于频繁，请 5 分钟后再试")
        if not self.setup_required():
            raise ApiError(409, "管理员密码已设置，请直接登录")
        try:
            expected = (self.dir / "setup.code").read_text().strip()
        except OSError:
            raise ApiError(409, "没有可用的初始化码，请在服务器上执行 sudo relayctl web-reset") from None
        if not expected or not hmac.compare_digest(expected, str(code or "").strip()):
            self._fail(ip)
            raise ApiError(403, "初始化码不正确")
        self._check_new(password)
        self._store(password)
        (self.dir / "setup.code").unlink(missing_ok=True)

    def verify(self, password: str, ip: str) -> bool:
        if self._locked(ip):
            raise ApiError(429, "尝试过于频繁，请 5 分钟后再试")
        try:
            data = json.loads(self.admin_file.read_text())
            ok = hmac.compare_digest(data["hash"], self._hash(str(password or ""), bytes.fromhex(data["salt"])))
        except (OSError, ValueError, KeyError):
            ok = False
        if not ok:
            self._fail(ip)
        return ok

    def change(self, old: str, new: str, ip: str) -> None:
        if not self.verify(old, ip):
            raise ApiError(403, "当前密码不正确")
        self._check_new(new)
        self._store(new)


class Sessions:
    def __init__(self, now=time.time, version=lambda: None) -> None:
        self.now, self.version = now, version
        self._items: dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self) -> tuple[str, str]:
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        t = self.now()
        with self._lock:
            self._items[token] = {"csrf": csrf, "created": t, "last": t, "version": self.version()}
        return token, csrf

    def get(self, token: str | None) -> dict | None:
        if not token:
            return None
        t = self.now()
        with self._lock:
            s = self._items.get(token)
            if not s or t - s["last"] > IDLE_SECONDS or t - s["created"] > ABSOLUTE_SECONDS                     or s["version"] is None or s["version"] != self.version():
                self._items.pop(token, None)
                return None
            s["last"] = t
            return s

    def destroy(self, token: str | None) -> None:
        with self._lock:
            self._items.pop(token or "", None)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


# ---------------------------------------------------------------- 执行 relayctl
def default_runner(args: list[str]) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["sudo", "-n", "/usr/local/sbin/relayctl", *args],
                           capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)


class App:
    def __init__(self, auth: Auth, sessions: Sessions, runner=default_runner,
                 public_ip: str = "127.0.0.1", relay_port: int = 33888) -> None:
        self.auth, self.sessions, self.runner = auth, sessions, runner
        sessions.version = auth.version  # 会话绑定密码版本
        self.public_ip, self.relay_port = public_ip, relay_port

    def relayctl(self, ip: str, *args: str, as_json: bool = False):
        argv = ["--actor", f"网页@{ip}"] + (["--json"] if as_json else []) + list(args)
        rc, out, err = self.runner(argv)
        if rc != 0:
            msg = (err or out).strip().splitlines()
            text = msg[-1] if msg else ""
            if text.startswith("操作失败"):  # relayctl 的中文业务错误
                raise ApiError(400, text.removeprefix("操作失败：") or "操作失败")
            raise ApiError(500, "管理命令执行失败，可在服务器上使用 relayctl")  # sudo/内部错误不外露原文
        if as_json:
            try:
                return json.loads(out)
            except ValueError:
                raise ApiError(500, "管理命令输出无法解析") from None
        return out.strip()

    # 参数校验：只允许白名单字符进入 relayctl 参数
    @staticmethod
    def device(value) -> str:
        code = str(value or "").replace("-", "").strip().upper() if isinstance(value, str) else ""
        if not MACHINE_CODE.match(code):
            raise ApiError(400, "机器码格式不对：应为授权页面上的本机机器码")
        return code

    def handle(self, method: str, path: str, body: dict, ip: str):
        parts = [p for p in path.split("/") if p][1:]  # 去掉 api
        if method == "GET" and parts == ["status"]:
            return self.relayctl(ip, "status", as_json=True)
        if method == "GET" and parts == ["audit"]:
            return self.relayctl(ip, "audit", "--limit", "300", as_json=True)
        if method != "POST":
            raise ApiError(404, "接口不存在")
        reason = _clean(body.get("reason"), 100)
        hard = ["--hard"] if body.get("hard") is True else []
        if parts == ["work"]:
            dev = body.get("device")
            if dev:
                return {"message": self.relayctl(ip, "work", self.device(dev))}
            return {"message": self.relayctl(ip, "work", "--clear")}
        if parts == ["fleet"]:
            return {"material": self.relayctl(ip, "fleet", "--server", self.public_ip,
                                              "--port", str(self.relay_port), as_json=True)}
        if len(parts) == 3 and parts[0] == "devices":
            dev, action = self.device(parts[1]), parts[2]
            if action == "suspend":
                return {"message": self.relayctl(ip, "suspend", dev, "--reason", reason, *hard)}
            if action == "resume":
                return {"message": self.relayctl(ip, "resume", dev)}
            if action == "label":
                return {"message": self.relayctl(ip, "label", dev, _clean(body.get("label"), 40))}
            if action == "reset":
                return {"message": self.relayctl(ip, "reset", dev)}
        if parts == ["global", "suspend"]:
            return {"message": self.relayctl(ip, "suspend", "--all", "--reason", reason, *hard)}
        if parts == ["global", "resume"]:
            return {"message": self.relayctl(ip, "resume", "--all")}
        raise ApiError(404, "接口不存在")


def server_from_env(env) -> str:
    """统一接入凭据里的服务器名：优先域名（AINVR_RELAY_SERVER），旧安装只有公网 IP。"""
    return env.get("AINVR_RELAY_SERVER") or env.get("AINVR_RELAY_PUBLIC_IP") or "127.0.0.1"


# ---------------------------------------------------------------- HTTP
def make_handler(app: App, secure: bool):
    cookie_attrs = "HttpOnly; SameSite=Strict; Path=/" + ("; Secure" if secure else "")

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "AINVRRelayWeb/1"
        sys_version = ""

        def log_message(self, fmt, *args):
            return

        @property
        def ip(self) -> str:
            return self.client_address[0]

        def _token(self) -> str | None:
            jar = SimpleCookie(self.headers.get("Cookie", ""))
            return jar["trw"].value if "trw" in jar else None

        def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(status)
            for k, v in {**SECURITY_HEADERS, **(extra or {})}.items():
                self.send_header(k, v)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, obj, extra: dict | None = None) -> None:
            self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", extra)

        def _session_cookie(self, token: str) -> dict:
            return {"Set-Cookie": f"trw={token}; Max-Age={ABSOLUTE_SECONDS}; {cookie_attrs}"}

        def do_GET(self):
            path = urlsplit(self.path).path
            if path in STATIC:
                name, ctype = STATIC[path]
                try:
                    return self._send(200, (STATIC_DIR / name).read_bytes(), ctype)
                except OSError:
                    return self._json(500, {"error": "页面文件缺失"})
            if path == "/api/session":
                s = app.sessions.get(self._token())
                return self._json(200, {"setup_required": app.auth.setup_required(), "authenticated": bool(s),
                                        "csrf": s["csrf"] if s else None})
            if not path.startswith("/api/"):
                return self._json(404, {"error": "页面不存在"})
            if not app.sessions.get(self._token()):
                return self._json(401, {"error": "请先登录"})
            self._dispatch("GET", path, {})

        def do_POST(self):
            path = urlsplit(self.path).path
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host", ""):
                return self._json(403, {"error": "来源不被允许"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > MAX_BODY:
                    raise ValueError
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "请求格式不正确"})
            try:
                if path == "/api/setup":
                    app.auth.setup(body.get("code"), body.get("password"), self.ip)
                    token, csrf = app.sessions.create()
                    return self._json(200, {"csrf": csrf}, self._session_cookie(token))
                if path == "/api/login":
                    if app.auth.setup_required():
                        raise ApiError(409, "尚未设置管理员密码")
                    if not app.auth.verify(body.get("password"), self.ip):
                        raise ApiError(401, "密码不正确")
                    token, csrf = app.sessions.create()
                    return self._json(200, {"csrf": csrf}, self._session_cookie(token))
            except ApiError as e:
                return self._json(e.status, {"error": str(e)})
            token = self._token()
            s = app.sessions.get(token)
            if not s:
                return self._json(401, {"error": "请先登录"})
            if not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), s["csrf"]):
                return self._json(403, {"error": "请求校验失败，请刷新页面"})
            if path == "/api/logout":
                app.sessions.destroy(token)
                return self._json(200, {"ok": True}, {"Set-Cookie": f"trw=; Max-Age=0; {cookie_attrs}"})
            if path == "/api/password":
                try:
                    app.auth.change(body.get("old"), body.get("new"), self.ip)
                except ApiError as e:
                    return self._json(e.status, {"error": str(e)})
                app.sessions.clear()  # 改密后其他会话全部失效
                token, csrf = app.sessions.create()
                return self._json(200, {"csrf": csrf}, self._session_cookie(token))
            self._dispatch("POST", path, body)

        def _dispatch(self, method: str, path: str, body: dict) -> None:
            try:
                result = app.handle(method, path, body, self.ip)
                self._json(200, result if isinstance(result, (dict, list)) else {"result": result})
            except ApiError as e:
                self._json(e.status, {"error": str(e)})
            except Exception:  # noqa: BLE001
                self._json(500, {"error": "服务器内部错误"})
    return Handler


class TLSServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler, context: ssl.SSLContext | None) -> None:
        self.context = context
        super().__init__(addr, handler)

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(30)
        if self.context:  # 握手放到处理线程里做，慢客户端不会卡住其他连接
            sock = self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return sock, addr

    def handle_error(self, request, client_address):  # 扫描器的坏握手不刷日志
        return


def main() -> int:
    state = Path(os.environ.get("AINVR_RELAY_WEB_STATE", "/var/lib/ainvr-relay-web"))
    port = int(os.environ.get("AINVR_RELAY_WEB_PORT", "8181"))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(state / "tls" / "server.crt", state / "tls" / "server.key")
    app = App(Auth(state), Sessions(), public_ip=server_from_env(os.environ),
              relay_port=int(os.environ.get("AINVR_RELAY_PORT", "33888")))
    server = TLSServer(("0.0.0.0", port), make_handler(app, secure=True), ctx)
    print(f"管理页面启动：https://0.0.0.0:{port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
