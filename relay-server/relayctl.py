#!/usr/bin/env python3
"""
中转服务器管理命令（仅本机 root）。设备免开通：装了统一接入凭据的设备开启远程协助后自动出现，
以授权机器码标识；选一台在线设备设为"当前工作设备"，经云服务器本机固定端口远程登录。

  relayctl list                                   设备（机器码）、在线、暂停、当前工作设备
  relayctl work <机器码> | --clear                 设为当前工作设备（云本机 127.0.0.1:6000 → 该设备）/ 结束
  relayctl suspend <机器码>|--all [--reason R] [--hard]
  relayctl resume <机器码>|--all
  relayctl reset <机器码>                           重置设备身份（重装系统后"身份冲突"时使用）
  relayctl label <机器码> <备注>                    设备备注（客户名称等）
  relayctl fleet --server IP [--port 33888]        生成随安装包下发的统一接入凭据（credentials.json、server.json）
  relayctl status --json / audit [--limit N] --json  供管理页面使用的机器可读输出
  relayctl web-reset                              重置管理页面密码（生成新的初始化码）

存储（/etc/ainvr-relay）：
  auth.json      插件读取：暂停标志、身份重置时间、工作访问端令牌哈希（root:ainvr-relay 0640）
  fleet.json     统一隧道密钥与服务器地址（root 0600）
  relay.token    工作访问端令牌（root 0600）；work.toml 当前工作访问端配置（root 0600）
  labels.json    设备备注；audit.log 管理操作记录
设备身份表由鉴权插件维护：/var/lib/ainvr-relay-auth/identities.json。

单台暂停与全部暂停相互独立：解除全部暂停不会解除某台设备原有的暂停。
--hard（单台）：按该设备当前公网 IP 断开它到中转服务器的连接，不重启服务（同一公网 IP 后面的
其他设备会被一并断开并在几秒内自动重连）；拿不到 IP 或断开失败时退回重启中转服务。
--all --hard：重启中转服务，所有连接立即断开。
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import grp
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from relay_auth import empty_state, normalize_code, proxy_name, token_hash, write_state  # noqa: E402

WORK_PORT = 6000
WORK_UNIT = "ainvr-relay-work"
LABEL_MAX = 40


class RelayError(Exception):
    pass


def _q(value) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def _default_gid():
    try:
        return grp.getgrnam("ainvr-relay").gr_gid
    except KeyError:
        return None


def _dashboard(conf: Path, path: str):
    password = (conf / "dashboard.pass").read_text().strip()
    req = urllib.request.Request(f"http://127.0.0.1:7500{path}", headers={
        "Authorization": "Basic " + base64.b64encode(f"admin:{password}".encode()).decode()})
    with urllib.request.urlopen(req, timeout=3) as resp:
        return json.loads(resp.read().decode())


def _default_fetch_online(conf: Path) -> dict | None:
    """本机管理面板里的 STCP 隧道：机器码 → 隧道信息；读取失败返回 None（显示为未知）。"""
    try:
        proxies = _dashboard(conf, "/api/proxy/stcp").get("proxies") or []
    except Exception:  # noqa: BLE001
        return None
    out = {}
    for p in proxies:
        code = normalize_code(str(p.get("name", "")).split(".")[-1].removesuffix("-ssh"))
        if code and (code not in out or p.get("status") == "online"):
            out[code] = p
    return out


def _default_fetch_clients(conf: Path):
    """当前连到中转服务器的客户端；读取失败返回 None。"""
    try:
        return {c.get("clientID") or c.get("key"): c for c in _dashboard(conf, "/api/clients") if c.get("online")}
    except Exception:  # noqa: BLE001
        return None


def _plugin(path: str):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:7600{path}", timeout=2) as resp:
            return json.loads(resp.read().decode())
    except Exception:  # noqa: BLE001
        return None


def _default_fetch_sessions() -> dict:
    """鉴权插件记录的最近登录身份与身份冲突。"""
    return _plugin("/sessions") or {"logins": [], "conflicts": []}


def _default_fetch_identities() -> dict | None:
    """鉴权插件记住的设备（机器码 → 首次出现时间）；读不到返回 None。"""
    data = _plugin("/identities")
    return data.get("devices") if isinstance(data, dict) and data.get("available") else None


def _default_kill_ip(ip: str) -> bool:
    """销毁该公网 IP 到中转端口的已建立连接（需内核 SOCK_DESTROY 支持）。"""
    try:
        r = subprocess.run(["ss", "-K", "state", "established", "( sport = :33888 )", "dst", ip],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _default_service_state(unit: str) -> str:
    return subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True).stdout.strip() or "unknown"


def _default_systemctl(*args: str) -> None:
    subprocess.run(["systemctl", *args], check=True, capture_output=True, timeout=30)


def grouped(code: str) -> str:
    return "-".join(code[i:i + 4] for i in range(0, len(code), 4))


class Relay:
    def __init__(self, conf: Path, *, gid=_default_gid, now=time.time, restart=None, fetch_online=None,
                 actor=None, fetch_clients=None, fetch_sessions=None, fetch_identities=None,
                 service_state=None, kill_ip=None, systemctl=None,
                 web_dir: Path = Path("/var/lib/ainvr-relay-web")):
        self.conf = Path(conf)
        self.gid, self.now = gid, now
        self.restart = restart or (lambda: subprocess.run(["systemctl", "restart", "ainvr-relay"], check=True))
        self.fetch_online = fetch_online or (lambda: _default_fetch_online(self.conf))
        self.fetch_clients = fetch_clients or (lambda: _default_fetch_clients(self.conf))
        self.fetch_sessions = fetch_sessions or _default_fetch_sessions
        self.fetch_identities = fetch_identities or _default_fetch_identities
        self.service_state = service_state or _default_service_state
        self.kill_ip = kill_ip or _default_kill_ip
        self.systemctl = systemctl or _default_systemctl
        self.web_dir = Path(web_dir)
        self.actor = actor or os.environ.get("SUDO_USER") or os.environ.get("USER") or "root"

    # ---------- 存储 ----------
    def _load(self, name: str, default):
        path = self.conf / name
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default

    def _auth(self) -> dict:
        state = self._load("auth.json", empty_state())
        state.setdefault("devices", {})
        state.setdefault("global_suspended", False)
        return state

    def _save_auth(self, state: dict) -> None:
        write_state(self.conf / "auth.json", state, self.gid())

    def _audit(self, action: str, target: str, reason: str = "") -> None:
        line = json.dumps({"ts": int(self.now()), "actor": self.actor, "action": action,
                           "target": target, "reason": reason}, ensure_ascii=False)
        with open(self.conf / "audit.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")

    @contextmanager
    def _locked(self):
        with open(self.conf / ".relayctl.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    @staticmethod
    def code(value: str) -> str:
        code = normalize_code(value)
        if not code:
            raise RelayError("机器码格式不对：应为授权页面上的本机机器码（16–32 位字母数字，可带横杠）")
        return code

    def _ctl(self, auth: dict, code: str) -> dict:
        return auth["devices"].setdefault(code, {})

    # ---------- 统一接入凭据 ----------
    def _fleet(self) -> dict:
        fleet = self._load("fleet.json", {})
        if not fleet.get("secret_key"):
            raise RelayError("尚未生成统一接入凭据，请先执行 relayctl fleet --server <公网IP>")
        return fleet

    def fleet(self, server: str | None = None, port: int = 33888) -> dict:
        """统一接入凭据：所有设备相同，随安装包下发。设备身份另由设备本机令牌在首次连接时确立。"""
        with self._locked():
            fleet = self._load("fleet.json", {})
            changed = False
            if not fleet.get("secret_key"):
                fleet["secret_key"] = secrets.token_urlsafe(32)
                changed = True
            if server and (fleet.get("server"), fleet.get("port")) != (server, int(port)):
                fleet.update(server=server, port=int(port))
                changed = True
            if not fleet.get("server"):
                raise RelayError("请用 --server 指定中转服务器公网地址")
            if changed:
                _write(self.conf / "fleet.json", json.dumps(fleet, ensure_ascii=False, indent=2), 0o600)
                self._audit("fleet", fleet["server"])
        creds = {"auth_token": (self.conf / "token").read_text(encoding="utf-8").strip(),
                 "secret_key": fleet["secret_key"], "server_name": fleet["server"],
                 "ca_cert": (self.conf / "tls" / "ca.crt").read_text(encoding="utf-8")}
        return {"credentials.json": json.dumps(creds, ensure_ascii=False, indent=2),
                "server.json": json.dumps({"host": fleet["server"], "port": fleet.get("port", 33888)})}

    def _relay_token(self) -> str:
        path = self.conf / "relay.token"
        if not path.exists():
            _write(path, secrets.token_urlsafe(32) + "\n", 0o600)
        return path.read_text(encoding="utf-8").strip()

    # ---------- 当前工作设备 ----------
    def work(self, code: str | None) -> str | None:
        """设为当前工作设备：生成云本机工作访问端配置并重启（127.0.0.1:WORK_PORT → 该设备）。
        code 为 None 时结束工作（停止访问端）。返回远程登录命令。"""
        with self._locked():
            auth = self._auth()
            if code is None:
                self.systemctl("stop", WORK_UNIT)
                (self.conf / "work.toml").unlink(missing_ok=True)
                auth.pop("work_device", None)
                self._save_auth(auth)
                self._audit("work-clear", "*")
                return None
            code = self.code(code)
            known = self.fetch_identities()
            if known is not None and code not in known:
                raise RelayError(f"设备 {grouped(code)} 还没有连上来过，请先让客户开启远程协助")
            fleet = self._fleet()
            token = self._relay_token()
            auth["relay_token_sha256"] = token_hash(token)
            text = "\n".join([
                'serverAddr = "127.0.0.1"', "serverPort = 33888", f"user = {_q(code)}", "loginFailExit = false",
                'auth.method = "token"',
                f"auth.token = {_q((self.conf / 'token').read_text(encoding='utf-8').strip())}",
                "transport.tls.enable = true", f"transport.tls.trustedCaFile = {_q(self.conf / 'tls' / 'ca.crt')}",
                f"transport.tls.serverName = {_q(fleet['server'])}",
                "transport.heartbeatInterval = 10", "transport.heartbeatTimeout = 30",
                'metadatas.role = "relay"', f"metadatas.device = {_q(code)}", f"metadatas.relay_token = {_q(token)}",
                'log.to = "console"', "",
                "[[visitors]]", 'name = "work"', 'type = "stcp"', f"serverName = {_q(proxy_name(code))}",
                f"secretKey = {_q(fleet['secret_key'])}", 'bindAddr = "127.0.0.1"', f"bindPort = {WORK_PORT}", ""])
            auth["work_device"] = code
            self._save_auth(auth)  # 先写令牌哈希，访问端登录时插件已认得
            _write(self.conf / "work.toml", text, 0o600)
            self.systemctl("restart", WORK_UNIT)
            self._audit("work", code)
            return self.work_command(code, fleet)

    @staticmethod
    def work_command(code: str, fleet: dict) -> str:
        # HostKeyAlias：同一个本机端口切换设备后主机密钥会变，按机器码分别记住各设备的主机密钥
        return (f"ssh -J ubuntu@{fleet.get('server', '<中转服务器>')} -p {WORK_PORT} "
                f"-o HostKeyAlias=ainvr-{code} ainvr@127.0.0.1")

    # ---------- 暂停 / 身份 / 备注 ----------
    def suspend(self, code: str | None, reason: str = "", hard: bool = False) -> str | None:
        """返回强制断开方式：None（未强制）/ "ip"（只断该设备公网 IP）/ "restart"（重启中转）/ "offline"（设备不在线）。"""
        with self._locked():
            auth = self._auth()
            if code is None:
                auth["global_suspended"] = True
                auth["global_reason"] = reason
            else:
                code = self.code(code)
                self._ctl(auth, code).update(suspended=True, reason=reason)
            self._save_auth(auth)
            self._audit("suspend-hard" if hard else "suspend", code or "*", reason)
        if not hard:
            return None
        if code is not None:
            ip = self._device_ip(code)
            if ip is None and self.fetch_online() is not None:
                return "offline"
            if ip and self.kill_ip(ip):
                return "ip"
        self.restart()
        return "restart"

    def resume(self, code: str | None) -> None:
        with self._locked():
            auth = self._auth()
            if code is None:
                auth["global_suspended"] = False  # 不触碰单台暂停
                auth.pop("global_reason", None)
            else:
                code = self.code(code)
                self._ctl(auth, code).update(suspended=False, reason="")
            self._save_auth(auth)
            self._audit("resume", code or "*")

    def reset(self, code: str) -> None:
        """作废该机器码记住的设备令牌：下一次以该机器码登录的设备被重新记住。"""
        code = self.code(code)
        with self._locked():
            auth = self._auth()
            self._ctl(auth, code)["reset_at"] = int(self.now())
            self._save_auth(auth)
            self._audit("reset", code)

    def label(self, code: str, text: str) -> None:
        code = self.code(code)
        text = "".join(ch for ch in (text or "") if ch.isprintable()).strip()[:LABEL_MAX]
        with self._locked():
            labels = self._load("labels.json", {})
            if text:
                labels[code] = text
            else:
                labels.pop(code, None)
            _write(self.conf / "labels.json", json.dumps(labels, ensure_ascii=False, indent=2), 0o600)
            self._audit("label", code, text)

    def _device_ip(self, code: str) -> str | None:
        p = (self.fetch_online() or {}).get(code) or {}
        if p.get("status") != "online":
            return None
        c = (self.fetch_clients() or {}).get(p.get("clientID")) or {}
        return c.get("clientIP") or None

    # ---------- 查看 ----------
    def audit(self, limit: int = 200) -> list[dict]:
        try:
            lines = (self.conf / "audit.log").read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        out = []
        for line in reversed(lines):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
            if len(out) >= max(1, min(limit, 1000)):
                break
        return out

    def web_reset(self) -> str:
        """清除管理页面密码并生成新的初始化码（仅 root），下次打开页面需用初始化码重新设置密码。"""
        self.web_dir.mkdir(parents=True, exist_ok=True)
        (self.web_dir / "admin.json").unlink(missing_ok=True)
        code = "-".join(secrets.token_hex(3) for _ in range(3))
        _write(self.web_dir / "setup.code", code + "\n", 0o600)
        try:
            import pwd
            u = pwd.getpwnam("ainvr-relay-web")
            os.chown(self.web_dir / "setup.code", u.pw_uid, u.pw_gid)
        except (KeyError, OSError):
            pass
        self._audit("web-reset", "web")
        return code

    def status(self) -> dict:
        """管理页面一次取全：服务、设备（在线/公网 IP/流量/身份冲突/当前工作）、在线连接。"""
        auth = self._auth()
        labels = self._load("labels.json", {})
        fleet = self._load("fleet.json", {})
        online = self.fetch_online()
        clients = self.fetch_clients()
        sess = self.fetch_sessions() or {}
        known = self.fetch_identities()
        conflicts = {c.get("device"): c for c in sess.get("conflicts") or []}
        ident = {(x.get("hostname"), x.get("ip")): x for x in sorted(sess.get("logins") or [], key=lambda x: x.get("ts", 0))}
        work = auth.get("work_device", "")
        codes = set(auth["devices"]) | set(labels) | set(known or {}) | set(online or {}) | set(conflicts) | ({work} - {""})
        devices, device_clients = [], {}
        for code in sorted(codes):
            ctl = auth["devices"].get(code) or {}
            p = (online or {}).get(code) or {}
            c = (clients or {}).get(p.get("clientID")) if p.get("status") == "online" else None
            if c:
                device_clients[p.get("clientID")] = code
            conflict = conflicts.get(code)
            if conflict and ctl.get("reset_at", 0) >= conflict.get("ts", 0):
                conflict = None  # 重置之后的冲突记录已过时
            devices.append({
                "device": code, "grouped": grouped(code), "label": labels.get(code, ""),
                "suspended": bool(ctl.get("suspended")), "reason": ctl.get("reason", ""),
                "online": None if online is None else p.get("status") == "online",
                "first_seen": (known or {}).get(code, {}).get("first_seen", 0),
                "conflict": conflict, "work": code == work,
                "conns": p.get("curConns", 0), "last_start": p.get("lastStartTime", ""),
                "last_close": p.get("lastCloseTime", ""), "traffic_in": p.get("todayTrafficIn", 0),
                "traffic_out": p.get("todayTrafficOut", 0),
                "client_ip": (c or {}).get("clientIP", ""), "hostname": (c or {}).get("hostname", ""),
                "connected_at": (c or {}).get("lastConnectedAt", 0)})
        devices.sort(key=lambda d: (not d["work"], not d["online"], d["device"]))
        conn_list = []
        for cid, c in (clients or {}).items():
            who = ident.get((c.get("hostname"), c.get("clientIP"))) or {}
            role, name = ("device", device_clients[cid]) if cid in device_clients else (who.get("role", ""), who.get("name", ""))
            conn_list.append({"id": cid, "ip": c.get("clientIP", ""), "hostname": c.get("hostname", ""),
                              "connected_at": c.get("lastConnectedAt", 0), "version": c.get("version", ""),
                              "role": role, "name": name})
        conn_list.sort(key=lambda x: (x["role"] != "relay", x["name"]))
        return {
            "services": {"relay": self.service_state("ainvr-relay"), "auth": self.service_state("ainvr-relay-auth")},
            "dashboard_ok": online is not None and clients is not None, "identities_ok": known is not None,
            "global_suspended": bool(auth.get("global_suspended")), "global_reason": auth.get("global_reason", ""),
            "work": {"device": work, "grouped": grouped(work) if work else "", "port": WORK_PORT,
                     "state": self.service_state(WORK_UNIT) if work else "inactive",
                     "command": self.work_command(work, fleet) if work else ""},
            "fleet_ready": bool(fleet.get("secret_key")),
            "devices": devices, "connections": conn_list,
        }


def _print_list(relay: Relay) -> None:
    s = relay.status()
    print(f"全部暂停：{'是 ' + s['global_reason'] if s['global_suspended'] else '否'}")
    w = s["work"]
    print(f"当前工作设备：{w['grouped'] + '（' + w['command'] + '）' if w['device'] else '无'}")
    print(f"{'机器码':<32}{'云端':<6}{'在线':<6}{'公网 IP':<17}备注 / 原因")
    for d in s["devices"]:
        online = "未知" if d["online"] is None else ("在线" if d["online"] else "离线")
        state = "冲突" if d["conflict"] else ("暂停" if d["suspended"] else "允许")
        mark = "★" if d["work"] else " "
        print(f"{mark}{d['grouped']:<31}{state:<6}{online:<6}{d['client_ip'] or '-':<17}{d['label']} {d['reason']}")


def main(argv=None, relay: Relay | None = None) -> int:
    ap = argparse.ArgumentParser(prog="relayctl", description="远程协助中转服务器管理")
    ap.add_argument("--actor", default=None, help="审计日志中的操作人（管理页面调用时传入）")
    ap.add_argument("--json", action="store_true", help="机器可读输出（status/audit/fleet）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("status")
    p = sub.add_parser("audit"); p.add_argument("--limit", type=int, default=200)
    p = sub.add_parser("label"); p.add_argument("device"); p.add_argument("text")
    sub.add_parser("web-reset")
    p = sub.add_parser("fleet"); p.add_argument("--server"); p.add_argument("--port", type=int, default=33888)
    for name in ("suspend", "resume"):
        p = sub.add_parser(name); g = p.add_mutually_exclusive_group(required=True)
        g.add_argument("device", nargs="?"); g.add_argument("--all", action="store_true")
        if name == "suspend":
            p.add_argument("--reason", default=""); p.add_argument("--hard", action="store_true")
    p = sub.add_parser("work"); g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("device", nargs="?"); g.add_argument("--clear", action="store_true")
    p = sub.add_parser("reset"); p.add_argument("device")
    args = ap.parse_args(argv)
    if relay is None:
        if os.geteuid() != 0:
            print("relayctl 需要 root 运行", file=sys.stderr)
            return 1
        relay = Relay(Path(os.environ.get("AINVR_RELAY_CONF", "/etc/ainvr-relay")))
    if args.actor:
        relay.actor = "".join(ch for ch in args.actor if ch.isprintable())[:40]
    out = lambda data: print(json.dumps(data, ensure_ascii=False))  # noqa: E731
    try:
        if args.cmd == "list":
            _print_list(relay)
        elif args.cmd == "status":
            out(relay.status())
        elif args.cmd == "audit":
            entries = relay.audit(args.limit)
            if args.json:
                out(entries)
            else:
                for e in entries:
                    print(time.strftime("%m-%d %H:%M:%S", time.localtime(e.get("ts", 0))), e.get("actor"),
                          e.get("action"), e.get("target"), e.get("reason", ""))
        elif args.cmd == "label":
            relay.label(args.device, args.text); print("备注已更新")
        elif args.cmd == "web-reset":
            code = relay.web_reset()
            print(f"管理页面密码已清除。初始化码：{code}（打开页面后用它设置新密码）")
        elif args.cmd == "fleet":
            material = relay.fleet(args.server, args.port)
            if args.json:
                return out(material) or 0
            base = Path("/root/ainvr-relay-fleet")
            for name, text in material.items():
                _write(base / name, text, 0o600)
            print(f"统一接入凭据：{base}（credentials.json、server.json 放到打包机 deploy-package/vendor/remote-assist/，"
                  "随安装包写入设备 /var/lib/ainvr-remote-assist/）")
        elif args.cmd == "suspend":
            mode = relay.suspend(None if args.all else args.device, args.reason, args.hard)
            tail = {None: "，在线设备将在下一次心跳时断开", "ip": "，已断开该设备公网 IP 的连接（中转服务未重启）",
                    "restart": "，中转服务已重启，所有连接已断开", "offline": "，设备当前不在线"}[mode]
            print(("已全部暂停" if args.all else f"已暂停 {args.device}") + tail)
        elif args.cmd == "resume":
            relay.resume(None if args.all else args.device)
            print("已解除全部暂停（单台暂停保持不变）" if args.all else f"已恢复 {args.device}，设备将自动重连")
        elif args.cmd == "work":
            cmd = relay.work(None if args.clear else args.device)
            print("已结束当前工作设备" if cmd is None else
                  f"当前工作设备：{grouped(relay.code(args.device))}，约 5 秒后可登录：\n  {cmd}")
        elif args.cmd == "reset":
            relay.reset(args.device)
            print(f"已重置 {args.device} 的设备身份，下一次以该机器码连上来的设备将被记住")
    except (RelayError, OSError, ValueError, subprocess.CalledProcessError) as e:
        print(f"操作失败：{e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
