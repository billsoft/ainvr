#!/usr/bin/env python3
"""
中转服务器鉴权与暂停闸门（frps 服务端插件，只监听本机）。

frps 对 Login / NewProxy / Ping / NewWorkConn 四类请求回调本服务：
  - 设备：免开通。设备用安装包里的统一接入凭据连上来，以授权机器码为身份，并带一枚设备首次开启时
    在本机生成的令牌。机器码首次出现时记住该令牌（identities.json，本插件唯一写入），之后同一机器码
    令牌不符即拒绝（AINVR_IDENTITY_CONFLICT），防止拿到安装包的人冒充在线设备。重装等正常场景由
    管理员 `relayctl reset <机器码>` 重置后重新记住。设备只能注册 "<机器码>-ssh" STCP 隧道，且不得
    放宽访问者范围（allow_users 只能为空或本机机器码）。
  - 工作访问端：云端本机唯一的访问者（relayctl work 生成），凭云端本机令牌登录、只能来自本机地址，
    访问当前选定的工作设备。没有其他访问者角色。
  - 暂停：单台暂停与全部暂停相互独立；被暂停的设备一律拒绝，原因固定为 AINVR_SUSPENDED。

身份绑定：设备与工作访问端的 frp user 都是机器码。frp 隧道默认只允许同 user 的访问者，于是不经登录
的旧访问路径（user 为空）与其他设备的访问者都被 frp 拒绝。

auth.json（root 写，本插件只读）读不到即拒绝全部请求；identities.json 读不到即拒绝全部设备请求，
绝不把已有设备当成首次出现重新记住。frps 在插件不可达或出错时同样拒绝（fail-closed）。只用标准库。
"""
from __future__ import annotations

import hashlib
import hmac
import http.server
import ipaddress
import json
import logging
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

AUTH_FILE = Path(os.environ.get("AINVR_RELAY_AUTH", "/etc/ainvr-relay/auth.json"))
IDENTITY_FILE = Path(os.environ.get("AINVR_RELAY_IDENTITIES", "/var/lib/ainvr-relay-auth/identities.json"))
LISTEN = ("127.0.0.1", int(os.environ.get("AINVR_RELAY_AUTH_PORT", "7600")))
SUSPENDED = "AINVR_SUSPENDED"
UNAUTHORIZED = "AINVR_UNAUTHORIZED"
UNAVAILABLE = "AINVR_UNAVAILABLE"
CONFLICT = "AINVR_IDENTITY_CONFLICT"
MAX_BODY = 64 * 1024
MAX_IDENTITIES = 20000
MACHINE_CODE = re.compile(r"^[A-Z0-9]{16,32}$")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_code(value) -> str:
    """机器码统一为去横杠大写（授权页显示为 4 位一组加横杠）。不合格返回空串。"""
    code = str(value or "").replace("-", "").strip().upper()
    return code if MACHINE_CODE.match(code) else ""


def proxy_name(code: str) -> str:
    return f"{code}-ssh"


def empty_state() -> dict:
    return {"version": 2, "global_suspended": False, "devices": {}}


def _atomic_write(path: Path, data: dict, mode: int, gid: int | None = None) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        if gid is not None:
            os.chown(tmp, 0, gid)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_state(path: Path, state: dict, gid: int | None = None) -> None:
    """原子写入 auth.json：插件账号只读（root:ainvr-relay 0640）。"""
    _atomic_write(path, state, 0o640, gid)


class Store:
    """auth.json 的内存副本；文件修改时间变化才重载。读失败立即作废状态（fail-closed），恢复后重新加载。"""

    def __init__(self, path: Path = AUTH_FILE, check_interval: float = 1.0) -> None:
        self.path = Path(path)
        self.check_interval = check_interval
        self._state: dict | None = None
        self._mtime: float | None = None
        self._checked = 0.0
        self._lock = threading.Lock()

    def get(self) -> dict | None:
        now = time.monotonic()
        with self._lock:
            if self._state is None or now - self._checked >= self.check_interval:
                self._checked = now
                try:
                    mtime = self.path.stat().st_mtime_ns
                    if mtime != self._mtime or self._state is None:
                        state = json.loads(self.path.read_text(encoding="utf-8"))
                        if not isinstance(state, dict) or not isinstance(state.get("devices"), dict):
                            raise ValueError("invalid auth state")
                        if self._state is None and self._mtime is not None:
                            logging.info("鉴权状态已恢复")
                        self._state, self._mtime = state, mtime
                except (OSError, ValueError) as e:
                    if self._state is not None or self._mtime is None:
                        logging.error("鉴权状态读取失败，拒绝全部接入直到恢复: %s", e)
                    self._state, self._mtime = None, -1
            return self._state


class Identities:
    """机器码 → 设备令牌哈希（首次出现即记住）。本插件是唯一写入者，内存为准、变更即原子落盘。

    文件读不到或损坏时 available=False：拒绝全部设备请求并定期重试读取，绝不从空表重新记住。"""

    def __init__(self, path: Path = IDENTITY_FILE, now=time.time, retry: float = 5.0,
                 max_items: int = MAX_IDENTITIES) -> None:
        self.path, self.now, self.retry, self.max_items = Path(path), now, retry, max_items
        self._items: dict | None = None
        self._next_try = 0.0
        self._lock = threading.Lock()

    def _load(self) -> None:
        if self._items is not None or time.monotonic() < self._next_try:
            return
        self._next_try = time.monotonic() + self.retry
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            items = data.get("devices") if isinstance(data, dict) else None
            if not isinstance(items, dict):
                raise ValueError("invalid identities")
            self._items = items
            logging.info("设备身份表已加载：%d 台", len(items))
        except (OSError, ValueError) as e:
            logging.error("设备身份表读取失败，拒绝全部设备接入直到恢复: %s", e)

    def _save(self, items: dict) -> None:
        _atomic_write(self.path, {"version": 1, "devices": items}, 0o600)

    @property
    def available(self) -> bool:
        with self._lock:
            self._load()
            return self._items is not None

    def check(self, code: str, digest: str, reset_at: float, register: bool) -> str:
        """返回 "ok" / "unknown"（未记住且不登记）/ "conflict" / "full" / "unavailable"。"""
        with self._lock:
            self._load()
            if self._items is None:
                return "unavailable"
            entry = self._items.get(code)
            if entry and reset_at and entry.get("first_seen", 0) < reset_at:
                entry = None  # 管理员重置后，旧记录作废，下一次登录重新记住
            if entry:
                return "ok" if hmac.compare_digest(entry.get("token_sha256", ""), digest) else "conflict"
            if not register:
                return "unknown"
            if code not in self._items and len(self._items) >= self.max_items:
                return "full"
            items = dict(self._items)
            items[code] = {"token_sha256": digest, "first_seen": int(self.now())}
            try:
                self._save(items)
            except OSError as e:
                logging.error("设备身份表写入失败: %s", e)
                return "unavailable"
            self._items = items
            logging.info("记住新设备 %s", code)
            return "ok"

    def snapshot(self) -> dict:
        with self._lock:
            self._load()
            return {k: {"first_seen": v.get("first_seen", 0)} for k, v in (self._items or {}).items()}


def _metas(op: str, content: dict) -> dict:
    metas = content.get("metas") if op == "Login" else (content.get("user") or {}).get("metas")
    return metas if isinstance(metas, dict) else {}


def _frp_user(op: str, content: dict) -> str:
    user = content.get("user") if op == "Login" else (content.get("user") or {}).get("user")
    return user if isinstance(user, str) else ""


def _bindable(ip: str) -> bool:
    """该地址属于本机（能在本机绑定）。外部地址绑定必然失败。"""
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as s:
            s.bind((ip, 0))
        return True
    except OSError:
        return False


def _from_this_host(content: dict) -> bool:
    """来源是本机。不能只认回环：这台云服务器上连 127.0.0.1 的来源可能显示为本机内网地址
    （本机还有其他代理改写流量，实测为 10.3.0.16）。"""
    addr = str(content.get("client_address") or "")
    host = addr.rsplit(":", 1)[0].strip("[]") if ":" in addr else addr
    try:
        ip = ipaddress.ip_address(host.removeprefix("::ffff:"))
    except ValueError:
        return False
    return ip.is_loopback or _bindable(str(ip))


def decide(state: dict | None, identities: Identities, op: str, content: dict) -> tuple[bool, str, str]:
    """返回 (是否放行, 拒绝原因, 日志主体)。"""
    if state is None:
        return False, UNAVAILABLE, "-"
    metas = _metas(op, content)
    role = metas.get("role")
    code = normalize_code(metas.get("device"))
    user = _frp_user(op, content)
    if role == "device":
        token = metas.get("device_token")
        if not code or user != code or not isinstance(token, str) or not 16 <= len(token) <= 256:
            return False, UNAUTHORIZED, f"device:{str(metas.get('device', ''))[:48]}"
        ctl = state.get("devices", {}).get(code) or {}
        verdict = identities.check(code, token_hash(token), ctl.get("reset_at", 0), register=op == "Login")
        if verdict == "unavailable":
            return False, UNAVAILABLE, f"device:{code}"
        if verdict == "conflict":
            return False, CONFLICT, f"device:{code}"
        if verdict != "ok":
            return False, UNAUTHORIZED, f"device:{code}"
        if op == "NewProxy":
            allow = content.get("allow_users")
            if content.get("proxy_name") not in (proxy_name(code), f"{code}.{proxy_name(code)}") \
                    or content.get("proxy_type") != "stcp" or allow not in (None, [], [code]):
                return False, UNAUTHORIZED, f"device:{code}"
        if ctl.get("suspended") or state.get("global_suspended"):
            return False, SUSPENDED, f"device:{code}"
        return True, "", f"device:{code}"
    if role == "relay":
        expected = state.get("relay_token_sha256", "")
        token = metas.get("relay_token")
        if not (expected and isinstance(token, str) and hmac.compare_digest(expected, token_hash(token))) \
                or not code or user != code or op == "NewProxy" or (op == "Login" and not _from_this_host(content)):
            return False, UNAUTHORIZED, f"relay:{code}"
        if not identities.available:
            return False, UNAVAILABLE, f"relay:{code}"
        return True, "", f"relay:{code}"
    return False, UNAUTHORIZED, "unknown"


class LogLimiter:
    """同一来源同一拒绝原因 interval 秒内只记一条，防止异常客户端反复请求刷满日志。"""

    def __init__(self, interval: float = 60.0, now=time.monotonic, max_keys: int = 4096) -> None:
        self.interval, self.now, self.max_keys = interval, now, max_keys
        self._last: dict = {}
        self._lock = threading.Lock()

    def allow(self, key) -> bool:
        t = self.now()
        with self._lock:
            if len(self._last) > self.max_keys:
                self._last.clear()
            if t - self._last.get(key, -1e18) < self.interval:
                return False
            self._last[key] = t
            return True


def _ip(content: dict) -> str:
    addr = str(content.get("client_address") or "")
    return addr.rsplit(":", 1)[0].strip("[]") if ":" in addr else addr


class Sessions:
    """最近成功登录的身份（主机名+公网 IP → 设备/工作访问端），以及最近的身份冲突，供管理页面显示。"""

    def __init__(self, max_items: int = 2000, now=time.time) -> None:
        self.max_items, self.now = max_items, now
        self._items: dict = {}
        self._conflicts: dict = {}
        self._lock = threading.Lock()

    def record(self, who: str, content: dict) -> None:
        role, _, name = who.partition(":")
        key = (str(content.get("hostname") or ""), _ip(content))
        with self._lock:
            self._items.pop(key, None)
            self._items[key] = {"role": role, "name": name, "hostname": key[0], "ip": key[1], "ts": int(self.now())}
            if role == "device":
                self._conflicts.pop(name, None)
            while len(self._items) > self.max_items:
                self._items.pop(next(iter(self._items)))

    def conflict(self, code: str, content: dict) -> None:
        with self._lock:
            self._conflicts.pop(code, None)
            self._conflicts[code] = {"device": code, "hostname": str(content.get("hostname") or ""),
                                     "ip": _ip(content), "ts": int(self.now())}
            while len(self._conflicts) > self.max_items:
                self._conflicts.pop(next(iter(self._conflicts)))

    def snapshot(self) -> dict:
        with self._lock:
            return {"logins": list(self._items.values()), "conflicts": list(self._conflicts.values())}


def make_handler(store: Store, identities: Identities, limiter: LogLimiter | None = None,
                 sessions: Sessions | None = None):
    limiter = limiter or LogLimiter()
    sessions = sessions if sessions is not None else Sessions()

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "AINVRRelayAuth/2"

        def log_message(self, fmt, *args):
            return

        def _send(self, code: int, obj) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/sessions":
                self._send(200, sessions.snapshot())
            elif path == "/identities":
                self._send(200, {"available": identities.available, "devices": identities.snapshot()})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY:
                    raise ValueError("bad length")
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                op = str(body.get("op", ""))
                content = body.get("content") if isinstance(body.get("content"), dict) else {}
                allow, reason, who = decide(store.get(), identities, op, content)
            except Exception as e:  # noqa: BLE001 - 任何解析异常都拒绝
                allow, reason, who, op, content = False, UNAUTHORIZED, "-", "?", {}
                logging.warning("插件请求无法解析: %s", e)
            if allow and op == "Login":
                sessions.record(who, content)
            if reason == CONFLICT and op == "Login":
                sessions.conflict(who.partition(":")[2], content)
            if not allow and limiter.allow((op, who, reason)):
                logging.info("拒绝 %s %s: %s（同类 60 秒内只记一次）", op, who, reason)
            self._send(200, {"reject": False, "unchange": True} if allow
                       else {"reject": True, "reject_reason": reason})
    return Handler


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout)])
    store = Store()
    if store.get() is None:
        logging.error("未能加载 %s：所有接入将被拒绝，直到状态文件可用", AUTH_FILE)
    identities = Identities()
    identities.available  # noqa: B018 - 启动时尝试加载并记录结果
    server = http.server.ThreadingHTTPServer(LISTEN, make_handler(store, identities))
    logging.info("鉴权插件启动: %s:%d", *LISTEN)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
