"""
远程协助：在宿主机上管理反向隧道客户端，让技术支持经中转服务器远程登录本机。

边界：
  - 只转发本机远程登录端口（sshd 实际监听端口），绝不转发网页/接口端口——
    隧道进来的连接在本机看起来来自 127.0.0.1，而本机多个服务信任回环地址。
  - 开关以 systemd 启用状态为准：开启 = enable --now（重启后自动恢复），
    关闭 = disable 后 stop，并确认进程已停止（已建立的远程连接随之断开）；
    开关意图与进程实际状态分开报告，查询失败报"未知"，不默认为关闭。
  - 宿主机侧不依赖授权和参数库（网页开关仍需控制台登录）；对外错误一律中文。

状态目录（默认 /var/lib/ainvr-remote-assist，root 所有）：
  server.json       中转服务器 {"host","port"}，随安装包写入，管理员可在页面修改
  credentials.json  统一接入凭据，随安装包写入，所有设备相同 {"auth_token","secret_key","ca_cert","server_name"?}
  device.key        本机设备令牌：首次开启时在本机生成（root 0600，永不显示），中转服务器按机器码记住它；
                    设备无需逐台开通。旧版按设备签发的 credentials.json 里的 device_token 会被沿用。
  machine_code      本机授权机器码缓存（授权服务暂不可用时仍可开启远程协助）
  client.toml       由本模块生成，隧道进程所在组只读
  admin.json        隧道客户端本机状态接口的随机口令
  state.json        {"enabled_at": 毫秒}
  events.jsonl      最近事件
"""
from __future__ import annotations

import grp
import ipaddress
import json
import os
import re
import secrets
import socket
import subprocess
import threading
import time
import urllib.request
from base64 import b64encode
from pathlib import Path
from typing import Callable

STATE_DIR = Path(os.environ.get("REMOTE_ASSIST_DIR", "/var/lib/ainvr-remote-assist"))
BINARY = Path(os.environ.get("REMOTE_ASSIST_BIN", "/opt/ainvr/remote-assist/client"))
UNIT = os.environ.get("REMOTE_ASSIST_UNIT", "ainvr-remote-assist.service")
UNIT_FILE = Path("/etc/systemd/system") / UNIT
GROUP = os.environ.get("REMOTE_ASSIST_GROUP", "ainvr-assist")
ADMIN_PORT = int(os.environ.get("REMOTE_ASSIST_ADMIN_PORT", "7402"))
CONNECT_GRACE_SECONDS = 30
MAX_EVENTS = 200
_HOSTNAME = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
_MACHINE_CODE = re.compile(r"^[A-Z0-9]{16,32}$")
LICENSE_SOCK = os.environ.get("REMOTE_ASSIST_LICENSE_SOCK", "/run/ainvr-license/license.sock")


class RemoteAssistError(Exception):
    def __init__(self, message: str, http: int = 400) -> None:
        super().__init__(message)
        self.http = http


def validate_host(value) -> str:
    host = str(value or "").strip()
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if not _HOSTNAME.match(host):
        raise RemoteAssistError("中转服务器地址无效，请填写 IP 地址或域名")
    return host


def validate_port(value) -> int:
    if isinstance(value, bool):
        raise RemoteAssistError("端口必须是 1–65535 的整数")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise RemoteAssistError("端口必须是 1–65535 的整数") from None
    if str(value).strip() != str(port) or not 1 <= port <= 65535:
        raise RemoteAssistError("端口必须是 1–65535 的整数")
    return port


def _q(value: str) -> str:
    # JSON 基本字符串转义与 TOML 基本字符串兼容（引号、反斜杠、控制字符）。
    return json.dumps(str(value), ensure_ascii=False)


def render_config(server: dict, creds: dict, ssh_port: int, admin: dict, ca_file: Path | None,
                  server_name: str | None = None) -> str:
    lines = [
        f"serverAddr = {_q(server['host'])}",
        f"serverPort = {int(server['port'])}",
        # frp 用户绑定设备编号：隧道只允许同 user 的已登录访问者，不经登录的旧访问路径被拒
        f"user = {_q(creds['device_id'])}",
        "loginFailExit = false",
        'auth.method = "token"',
        f"auth.token = {_q(creds['auth_token'])}",
        "transport.tls.enable = true",
        # 连接复用时 frp 默认不发应用层心跳；显式开启，云端暂停才能在下一次心跳时让在线设备断开
        "transport.heartbeatInterval = 10",
        "transport.heartbeatTimeout = 30",
        # 设备身份：中转服务器据此校验设备令牌、绑定隧道名并判定是否暂停
        'metadatas.role = "device"',
        f"metadatas.device = {_q(creds['device_id'])}",
        f"metadatas.device_token = {_q(creds['device_token'])}",
    ]
    if ca_file:
        lines.append(f"transport.tls.trustedCaFile = {_q(str(ca_file))}")
    if server_name:
        lines.append(f"transport.tls.serverName = {_q(server_name)}")
    lines += [
        'log.to = "console"',
        'log.level = "info"',
        'webServer.addr = "127.0.0.1"',
        f"webServer.port = {ADMIN_PORT}",
        f"webServer.user = {_q(admin['user'])}",
        f"webServer.password = {_q(admin['password'])}",
        "",
        "[[proxies]]",
        f"name = {_q(creds['proxy_name'])}",
        'type = "stcp"',
        f"secretKey = {_q(creds['secret_key'])}",
        'localIP = "127.0.0.1"',
        f"localPort = {int(ssh_port)}",
        "",
    ]
    return "\n".join(lines)


SUSPENDED_MARK = "AINVR_SUSPENDED"
SUSPENDED_MESSAGE = "供应商已在中转服务器上暂停本设备的远程协助，恢复后会自动重新连接，无需操作"
_FAILURE_HINTS = ("ainvr_", "failed", "error", "timeout", "refused", "no such host")

_ERRORS = [
    # 中转服务器鉴权插件给出的固定标记优先匹配（经证书校验的连接传回，可信）
    (("ainvr_identity_conflict",), "中转服务器上登记的本机身份与当前不一致（例如重装系统后），请联系供应商在管理页面重置"),
    (("ainvr_unauthorized",), "中转服务器不认可本设备凭据，请联系供应商"),
    (("ainvr_unavailable", "to plugin error"), "中转服务器鉴权暂不可用，正在自动重试"),
    (("no such host", "lookup", "server misbehaving"), "无法解析中转服务器地址，请检查地址或本机网络"),
    (("connection refused",), "中转服务器拒绝连接，请确认地址和端口"),
    (("timeout", "timed out"), "连接中转服务器超时，请检查本机网络，或请网络管理员放行该端口的出站访问"),
    (("certificate", "x509", "handshake"), "中转服务器证书校验失败，请确认服务器地址是否正确"),
    (("token", "authorization", "authenticat"), "中转服务器拒绝本设备接入，请联系供应商核对设备凭据"),
    (("already", "proxy name"), "本设备的远程协助通道已被占用，请联系供应商"),
    (("network is unreachable", "no route"), "本机网络不可用，请检查网络连接"),
]


def latest_failure(raw: str) -> str:
    """日志中最近一条失败记录：恢复后若因其他原因连不上，不能继续显示旧的暂停原因。"""
    for line in reversed((raw or "").splitlines()):
        if any(h in line.lower() for h in _FAILURE_HINTS):
            return line
    return raw or ""


def translate_error(raw: str) -> str:
    text = (raw or "").lower()
    for keys, message in _ERRORS:
        if any(k in text for k in keys):
            return message
    return "暂时无法连接中转服务器，正在自动重试"


def _default_run(argv: list[str], timeout: float = 10) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def _default_http_get(url: str, user: str, password: str):
    req = urllib.request.Request(url, headers={
        "Authorization": "Basic " + b64encode(f"{user}:{password}".encode()).decode()})
    with urllib.request.urlopen(req, timeout=2) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_code(value) -> str:
    code = str(value or "").replace("-", "").strip().upper()
    return code if _MACHINE_CODE.match(code) else ""


def _default_machine_code() -> str | None:
    """经本机授权服务读取机器码（与授权页面显示的一致）；读不到返回 None。"""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(3)
            s.connect(LICENSE_SOCK)
            s.sendall(b"GET /api/v1/license/machine-code HTTP/1.0\r\nHost: localhost\r\n\r\n")
            data = b""
            while len(data) < 65536:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        body = data.split(b"\r\n\r\n", 1)[1]
        return json.loads(body.decode("utf-8")).get("machine_code")
    except (OSError, ValueError, IndexError, AttributeError):
        return None


def _default_gid() -> int | None:
    try:
        return grp.getgrnam(GROUP).gr_gid
    except KeyError:
        return None


class RemoteAssist:
    def __init__(self, state_dir: Path = STATE_DIR, *, run: Callable = _default_run,
                 http_get: Callable = _default_http_get, now: Callable[[], float] = time.time,
                 binary: Path = BINARY, unit: str = UNIT, unit_file: Path = UNIT_FILE,
                 group_gid: Callable[[], int | None] = _default_gid,
                 machine_code: Callable[[], str | None] = _default_machine_code) -> None:
        self.dir = Path(state_dir)
        self.fetch_machine_code = machine_code
        self.run, self.http_get, self.now = run, http_get, now
        self.binary, self.unit, self.unit_file, self.group_gid = binary, unit, Path(unit_file), group_gid
        self._lock = threading.Lock()
        self._sessions = 0
        self._session_since: float | None = None

    # ---------- 文件 ----------
    def _read(self, name: str) -> dict | None:
        try:
            data = json.loads((self.dir / name).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def _write(self, name: str, text: str, mode: int = 0o600, gid: int | None = None) -> None:
        self.dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        target = self.dir / name
        tmp = target.with_name(f".{name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, mode)
            if gid is not None:
                os.chown(tmp, 0, gid)
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink()

    def _log(self, kind: str, actor: str | None = None, detail: str | None = None) -> None:
        self.dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        path = self.dir / "events.jsonl"
        line = json.dumps({"ts": int(self.now() * 1000), "type": kind, "actor": actor, "detail": detail},
                          ensure_ascii=False)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return
        if len(lines) > MAX_EVENTS * 2:
            self._write("events.jsonl", "\n".join(lines[-MAX_EVENTS:]) + "\n")

    def events(self, limit: int = 50) -> list[dict]:
        try:
            lines = (self.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out = []
        for line in reversed(lines):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
            if len(out) >= max(1, min(limit, MAX_EVENTS * 2)):
                break
        return out

    # ---------- 宿主机事实 ----------
    def _installed(self) -> bool:
        return self.binary.is_file() and self.unit_file.is_file()

    def _enabled(self) -> bool | None:
        """开关意图（开机自启）。查询失败返回 None，不能当成关闭。"""
        out = self.run(["systemctl", "is-enabled", self.unit], 5)[1].strip()
        if out == "enabled":
            return True
        if out in ("disabled", "masked", "static", "indirect", "linked", "not-found"):
            return False
        return None

    def _running(self) -> bool | None:
        """隧道进程是否实际在运行（与开机自启无关）。查询失败返回 None。"""
        out = self.run(["systemctl", "is-active", self.unit], 5)[1].strip()
        if out in ("active", "activating", "deactivating", "reloading", "refreshing"):
            return True
        if out in ("inactive", "failed"):
            return False
        return None

    def _assert_stopped(self) -> None:
        """修改中转服务器前：必须确认已关闭且进程已停止。"""
        enabled, running = self._enabled(), self._running()
        if enabled is None or running is None:
            raise RemoteAssistError("暂时无法确认远程协助状态，请稍后重试", 503)
        if enabled or running:
            raise RemoteAssistError("远程协助开启或仍在运行时不能修改中转服务器，请先关闭远程协助", 409)

    def _ssh_port(self) -> int:
        """sshd 实际监听端口。读不到就报错，绝不猜 22：猜错会显示"已连接"但登录全部失败。"""
        override = os.environ.get("REMOTE_ASSIST_SSH_PORT")
        if override:
            return validate_port(override)
        rc, out = self.run(["sshd", "-T"], 10)
        for line in out.splitlines() if rc == 0 else []:
            parts = line.split()
            if len(parts) == 2 and parts[0] == "port" and parts[1].isdigit():
                return int(parts[1])
        raise RemoteAssistError("无法确定本机远程登录端口，请确认远程登录服务已启用", 500)

    def _sessions_now(self) -> int:
        try:
            port = self._ssh_port()
        except RemoteAssistError:
            return 0
        rc, out = self.run(["ss", "-Htn", "state", "established", f"( sport = :{port} )"], 5)
        count = 0
        for line in out.splitlines() if rc == 0 else []:
            parts = line.split()
            if len(parts) < 4:
                continue
            peer = parts[3].rsplit(":", 1)[0].strip("[]")
            if peer.startswith("::ffff:"):
                peer = peer[7:]
            try:
                if ipaddress.ip_address(peer).is_loopback:
                    count += 1
            except ValueError:
                continue
        return count

    def _credentials(self) -> dict | None:
        """统一接入凭据（所有设备相同）。服务器证书必须校验：只加密不验证，设备可能连到冒充的中转服务器。"""
        c = self._read("credentials.json")
        if not c:
            return None
        ok = all(isinstance(c.get(k), str) and 0 < len(c[k]) <= 512 for k in ("auth_token", "secret_key")) \
            and isinstance(c.get("ca_cert"), str) and "BEGIN CERTIFICATE" in c["ca_cert"] and len(c["ca_cert"]) <= 16384
        return c if ok else None

    def _cached_code(self) -> str:
        try:
            return normalize_code((self.dir / "machine_code").read_text(encoding="utf-8"))
        except OSError:
            return ""

    def _machine_code(self) -> str:
        """本机机器码：优先实时读取授权服务并刷新缓存，读不到用缓存（授权失效或服务异常时仍需远程支持）。"""
        code = normalize_code(self.fetch_machine_code())
        if code:
            if code != self._cached_code():
                self._write("machine_code", code + "\n", 0o600)
            return code
        code = self._cached_code()
        if not code:
            raise RemoteAssistError("暂时读不到本机机器码（授权服务未就绪），请稍后重试", 503)
        return code

    def _device_token(self, creds: dict) -> str:
        """本机设备令牌：首次开启时生成并永久保存；沿用旧版按设备签发的令牌，升级后身份不变。"""
        try:
            token = (self.dir / "device.key").read_text(encoding="utf-8").strip()
            if 16 <= len(token) <= 256:
                return token
        except OSError:
            pass
        old = creds.get("device_token")
        token = old if isinstance(old, str) and 16 <= len(old) <= 256 else secrets.token_urlsafe(32)
        self._write("device.key", token + "\n", 0o600)
        return token

    def _server(self) -> dict | None:
        s = self._read("server.json")
        try:
            return {"host": validate_host(s["host"]), "port": validate_port(s["port"])} if s else None
        except (KeyError, RemoteAssistError):
            return None

    def _tunnel_state(self, creds: dict | None, enabled_at: float | None) -> tuple[str, str | None]:
        admin = self._read("admin.json") or {}
        within_grace = enabled_at is not None and self.now() - enabled_at / 1000 < CONNECT_GRACE_SECONDS
        try:
            payload = self.http_get(f"http://127.0.0.1:{ADMIN_PORT}/api/status",
                                    admin.get("user", ""), admin.get("password", ""))
            proxies = [p for group in (payload or {}).values() if isinstance(group, list) for p in group]
            name = f"{self._cached_code()}-ssh"
            mine = next((p for p in proxies if creds and p.get("name") == name), None)
            if mine and mine.get("status") == "running":
                return "connected", None
            raw = (mine or {}).get("err") or ""
        except Exception:  # noqa: BLE001 - 状态接口未就绪等同于"仍在连接"
            raw = ""
        if within_grace:
            return "connecting", None
        if not raw:
            raw = self.run(["journalctl", "-u", self.unit, "-n", "30", "-o", "cat", "--no-pager"], 5)[1]
        failure = latest_failure(raw)
        if SUSPENDED_MARK in failure:  # 只认完整标记；其他失败一律按连接异常处理
            return "suspended", SUSPENDED_MESSAGE
        return "error", translate_error(failure)

    # ---------- 对外操作 ----------
    def status(self) -> dict:
        """enabled = 开关意图（开机自启），running = 进程实际状态；两者分开报告，查询失败为 None。"""
        installed = self._installed()
        creds = self._credentials()
        result = {
            "installed": installed, "enabled": False, "running": False, "server": self._server(),
            "credentials": creds is not None, "sessions": 0, "enabled_at": None,
            "machine_code": self._cached_code() or None,
            "state": "disabled", "message": None,
        }
        if not installed:
            result.update(state="unavailable", message="远程协助组件未安装，请升级设备软件")
            return result
        enabled, running = self._enabled(), self._running()
        result.update(enabled=enabled, running=running)
        if enabled is None or running is None:
            result.update(state="unknown", message="暂时无法确认远程协助状态，请稍后刷新")
            return result
        if running:
            result["sessions"] = self._sessions_now()
        if enabled:
            result["enabled_at"] = (self._read("state.json") or {}).get("enabled_at")
            if running:
                result["state"], result["message"] = self._tunnel_state(creds, result["enabled_at"])
            else:
                result.update(state="error", message="远程协助程序未在运行，正在自动重试")
        elif running:
            result.update(state="stopping", message="远程协助已关闭，但连接程序仍在运行，请再次关闭或稍后刷新")
        return result

    def set_server(self, host, port, actor: str | None) -> dict:
        with self._lock:
            server = {"host": validate_host(host), "port": validate_port(port)}
            if self._installed():
                self._assert_stopped()
            self._write("server.json", json.dumps(server))
            self._log("server_changed", actor, f"{server['host']}:{server['port']}")
            return server

    def enable(self, actor: str | None) -> None:
        with self._lock:
            if not self._installed():
                raise RemoteAssistError("远程协助组件未安装，请升级设备软件", 503)
            server = self._server()
            if not server:
                raise RemoteAssistError("请先填写中转服务器地址和端口")
            fleet = self._credentials()
            if not fleet:
                raise RemoteAssistError("设备未写入完整的远程协助凭据，请联系供应商")
            code = self._machine_code()
            creds = dict(fleet, device_id=code, device_token=self._device_token(fleet), proxy_name=f"{code}-ssh")
            ssh_port = self._ssh_port()
            gid = self.group_gid()
            admin = self._read("admin.json")
            if not admin:
                admin = {"user": "assist", "password": secrets.token_urlsafe(24)}
                self._write("admin.json", json.dumps(admin))
            self._write("ca.pem", creds["ca_cert"], 0o640, gid)
            ca_file = self.dir / "ca.pem"
            server_name = creds.get("server_name") if isinstance(creds.get("server_name"), str) else None
            text = render_config(server, creds, ssh_port, admin, ca_file, server_name)
            self._write("client.toml", text, 0o640, gid)
            rc, _ = self.run(["systemctl", "enable", "--now", self.unit], 30)
            if rc != 0:
                raise RemoteAssistError("远程协助启动失败，请查看运行日志", 500)
            self._write("state.json", json.dumps({"enabled_at": int(self.now() * 1000)}))
            self._log("enabled", actor)

    def disable(self, actor: str | None) -> None:
        """先取消开机自启，再停止进程；以进程确实停止为准才算关闭成功。"""
        with self._lock:
            self.run(["systemctl", "disable", self.unit], 15)
            if self._enabled() is not False:
                raise RemoteAssistError("远程协助关闭失败，请稍后重试", 500)
            self.run(["systemctl", "stop", self.unit], 30)
            if self._running() is not False:
                raise RemoteAssistError("已取消自动连接，但远程协助程序仍在运行，请稍后刷新或再次关闭", 500)
            self._write("state.json", json.dumps({}))
            self._log("disabled", actor)

    def test(self) -> dict:
        server = self._server()
        if not server:
            raise RemoteAssistError("请先填写中转服务器地址和端口")
        start = time.monotonic()
        try:
            with socket.create_connection((server["host"], server["port"]), timeout=5):
                pass
        except socket.gaierror:
            return {"ok": False, "latency_ms": None, "message": "无法解析中转服务器地址，请检查地址或本机网络"}
        except ConnectionRefusedError:
            return {"ok": False, "latency_ms": None, "message": "中转服务器拒绝连接，请确认地址和端口"}
        except (socket.timeout, TimeoutError):
            return {"ok": False, "latency_ms": None,
                    "message": "连接中转服务器超时，请检查本机网络，或请网络管理员放行该端口的出站访问"}
        except OSError:
            return {"ok": False, "latency_ms": None, "message": "本机网络不可用，请检查网络连接"}
        return {"ok": True, "latency_ms": int((time.monotonic() - start) * 1000), "message": "中转服务器可以连接"}

    def monitor_tick(self) -> None:
        """周期调用：本机远程登录端口的回环连接从无到有、从有到无时各记一条"连接活动"。

        这不是登录审计：未通过身份验证的连接也会计入，短于采样间隔的连接可能漏记，
        也无法区分人员。人员登录记录应以远程登录服务的认证日志为准。
        """
        count = self._sessions_now() if self._installed() and self._running() else 0
        if count and not self._sessions:
            self._session_since = self.now()
            self._log("session_started", None, None)
        elif not count and self._sessions:
            minutes = int((self.now() - (self._session_since or self.now())) // 60)
            self._log("session_ended", None, f"持续约 {minutes} 分钟")
            self._session_since = None
        self._sessions = count
