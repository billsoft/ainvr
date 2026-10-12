"""
os-helper — 操作系统代理服务（RDK S100P 版）

提供系统级操作的统一 HTTP 接口：
  - /network/*    网卡管理（列表、IP配置、WiFi、连通性检测、安全回滚）
  - /remote-assist/*  远程协助（中转服务器、开关、连通性检测、事件记录）

职责边界（2026-09-22 定稿）：只管网络与远程协助通道。关机/重启/资源采集由
shared/host-restart-helper 负责，backend 也只对接那一份——本服务不再
维护重复实现，避免两份"关机顺序"手工同步走漏。

安全模型（三层）：
  1. 来源 IP 白名单：loopback + 部署时登记的 Docker 子网
  2. Bearer Token：常数时间比较，token 存 /etc/ainvr-ai/os-helper.env
  3. 最小权限：root 运行但只执行白名单内的 nmcli 子命令

端口：8299
运行用户：root（网卡配置需要 root + SO_BINDTODEVICE）
"""
from __future__ import annotations

import hmac
import http.server
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

import nm  # 同目录下的 nm.py
import remote_assist
import systime

REMOTE_ASSIST = remote_assist.RemoteAssist()
# 系统日期时间（离线现场手动校时 / 局域网对时服务器）
SYSTEM_TIME = systime.SystemTime()

# Network maintenance is independent of licensing; token/IP/rate checks remain.
license_client = None


def license_write_blocked(client) -> tuple[bool, str]:
    return False, "" if client is None else "management_exempt"


# =========================== 配置 ===========================

PORT = int(os.environ.get("OS_HELPER_PORT", "8299"))
TOKEN = os.environ.get("OS_HELPER_TOKEN", "")

# 来源 IP 白名单：本机回环 + 动态部署策略（最多 5 秒热更新）
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from internal_network import NetworkPolicy
SOURCE_POLICY = NetworkPolicy()

# 写操作并发限制（防滥用）
WRITE_SEMAPHORE = threading.BoundedSemaphore(2)

# 读操作并发限制
READ_SEMAPHORE = threading.BoundedSemaphore(8)

# 请求体大小限制（防滥用）
MAX_BODY_BYTES = 8 * 1024  # 8 KB，网卡配置用不到太大


# =========================== 工具 ===========================

def source_ip_allowed(addr: str) -> bool:
    return SOURCE_POLICY.allows(addr)


def token_is_valid(provided: str | None, expected: str) -> bool:
    """常数时间比较，防时序侧信道；空 token 恒拒绝。"""
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


# =========================== HTTP Handler ===========================

class OSHelperHandler(http.server.BaseHTTPRequestHandler):
    server_version = "AINVROSHelper/1"

    def log_message(self, fmt: str, *args) -> None:
        # 轮询请求不算事件，失败返回给调用方自己记日志
        return

    # ---- 鉴权 ----
    def authorized(self) -> bool:
        if not source_ip_allowed(self.client_address[0]):
            self._send_json(403, {"ok": False, "error": "forbidden"})
            return False
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if not token_is_valid(token, TOKEN):
            logging.warning("鉴权失败: IP=%s", self.client_address[0])
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return False
        return True

    # ---- 路由 ----
    def do_GET(self):
        if not self.authorized():
            return
        if not READ_SEMAPHORE.acquire(blocking=False):
            self._send_json(429, {"error": "busy"})
            return
        try:
            route = urlsplit(self.path)
            query = parse_qs(route.query)
            get = lambda k, d="": query.get(k, [d])[0]
            path = route.path

            # === 健康检查 ===
            if path == "/health":
                self._send_json(200, {"ok": True, "service": "os-helper"})

            # === 网卡列表 ===
            elif path == "/network/interfaces":
                include_system = get("all", "false").lower() == "true"
                interfaces = nm.list_interfaces(include_system=include_system)
                self._send_json(200, {"ok": True, "interfaces": interfaces})

            # === 单网卡详情 ===
            elif path.startswith("/network/interfaces/") and path.endswith("/test"):
                # /network/interfaces/<name>/test
                iface = path[len("/network/interfaces/"):-len("/test")]
                try:
                    result = nm.check_connectivity(iface)
                    self._send_json(200, {"ok": True, **result})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 待确认变更 ===
            elif path == "/network/pending":
                pending = nm.pending_info()
                self._send_json(200, {"ok": True, "pending": pending})

            # === 出厂兜底地址（只读，没走 provisioning 的设备返回 fallback: null） ===
            elif path == "/network/fallback":
                fallback = nm.get_fallback_info()
                self._send_json(200, {"ok": True, "fallback": fallback})

            # === WiFi 扫描 ===
            elif path.startswith("/network/wifi/") and path.endswith("/scan"):
                # /network/wifi/<iface>/scan
                iface = path[len("/network/wifi/"):-len("/scan")]
                rescan = get("rescan", "true").lower() == "true"
                try:
                    aps = nm.wifi_scan(iface, rescan=rescan)
                    self._send_json(200, {"ok": True, "access_points": aps})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 系统日期时间 ===
            elif path == "/system/time":
                self._send_json(200, {"ok": True, "time": SYSTEM_TIME.status()})

            # === 远程协助 ===
            elif path == "/remote-assist/status":
                self._send_json(200, {"ok": True, **REMOTE_ASSIST.status()})
            elif path == "/remote-assist/events":
                try:
                    limit = int(get("limit", "50"))
                except ValueError:
                    limit = 50
                self._send_json(200, {"ok": True, "events": REMOTE_ASSIST.events(limit)})

            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            logging.exception("GET 处理异常: %s", self.path)
            self._send_json(500, {"ok": False, "error": "internal error"})
        finally:
            READ_SEMAPHORE.release()

    def _license_deny_if_blocked(self) -> bool:
        """写接口授权门：被拦截时已发 403 并返回 True，调用方应立即 return。"""
        blocked, phase = license_write_blocked(license_client)
        if blocked:
            self._send_json(403, {
                "ok": False,
                "code": "LICENSE_REQUIRED",
                "error": "license required",
                "phase": phase,
            })
            return True
        return False

    def do_PUT(self):
        if not self.authorized():
            return
        if self._license_deny_if_blocked():
            return
        if not WRITE_SEMAPHORE.acquire(blocking=False):
            self._send_json(429, {"error": "busy"})
            return
        try:
            route = urlsplit(self.path)
            path = route.path
            body = self._read_json()
            if body is None:
                return

            # === IP 配置（带安全回滚） ===
            # /network/interfaces/<name>/config
            if path.startswith("/network/interfaces/") and path.endswith("/config"):
                iface = path[len("/network/interfaces/"):-len("/config")]
                # rollback 必须是合法整数，否则 int() 会抛 ValueError 落到 500；
                # 范围交给 nm.start_apply 校验（1-300），这里只保类型
                try:
                    rollback = int(body.get("rollback_seconds", nm.DEFAULT_ROLLBACK_SECONDS))
                except (TypeError, ValueError):
                    self._send_json(400, {"ok": False, "error": "rollback_seconds 必须是整数秒"})
                    return
                config = {
                    "ipv4": body.get("ipv4", {}),
                    "ipv6": body.get("ipv6", {}),
                }
                try:
                    nm.start_apply(iface, config, rollback_seconds=rollback)
                    logging.info("IP 配置已应用（待确认）: iface=%s rollback=%ds", iface, rollback)
                    self._send_json(202, {"ok": True, "rollback_seconds": rollback})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 系统日期时间：手动校时（随后自动重启录像与 AI） ===
            elif path == "/system/time":
                try:
                    result = SYSTEM_TIME.set_time(body.get("epoch_ms"))
                    self._send_json(200, {"ok": True, "time": result, "restarted": result["restarted"]})
                except systime.SysTimeError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 系统日期时间：局域网对时服务器 ===
            elif path == "/system/ntp":
                try:
                    self._send_json(200, {"ok": True, "time": SYSTEM_TIME.set_ntp_servers(body.get("servers"))})
                except systime.SysTimeError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 远程协助：中转服务器（开启期间拒绝修改） ===
            elif path == "/remote-assist/server":
                server = REMOTE_ASSIST.set_server(body.get("host"), body.get("port"), body.get("actor"))
                logging.info("远程协助中转服务器已修改: %s:%s", server["host"], server["port"])
                self._send_json(200, {"ok": True, "server": server})

            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except remote_assist.RemoteAssistError as e:
            self._send_json(e.http, {"ok": False, "error": str(e)})
        except Exception as e:
            logging.exception("PUT 处理异常: %s", self.path)
            self._send_json(500, {"ok": False, "error": "internal error"})
        finally:
            WRITE_SEMAPHORE.release()

    def do_POST(self):
        if not self.authorized():
            return
        if self._license_deny_if_blocked():
            return
        if not WRITE_SEMAPHORE.acquire(blocking=False):
            self._send_json(429, {"error": "busy"})
            return
        try:
            route = urlsplit(self.path)
            path = route.path
            body = self._read_json()
            if body is None:
                return

            # === 确认变更（取消回滚） ===
            if path == "/network/confirm":
                change_id = body.get("id")
                if change_id is not None and not isinstance(change_id, str):
                    self._send_json(400, {"ok": False, "error": "id 必须是字符串"})
                    return
                try:
                    nm.confirm_pending(change_id)
                    logging.info("配置变更已确认")
                    self._send_json(200, {"ok": True})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 手动回滚 ===
            elif path == "/network/revert":
                try:
                    nm.revert_pending()
                    logging.info("配置已手动回滚")
                    self._send_json(200, {"ok": True})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === WiFi 连接 ===
            # /network/wifi/<iface>/connect
            elif path.startswith("/network/wifi/") and path.endswith("/connect"):
                iface = path[len("/network/wifi/"):-len("/connect")]
                ssid = body.get("ssid", "")
                password = body.get("password")
                hidden = bool(body.get("hidden", False))
                try:
                    nm.wifi_connect(iface, ssid, password=password, hidden=hidden)
                    logging.info("WiFi 已连接: iface=%s ssid=%s", iface, ssid)
                    self._send_json(200, {"ok": True})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === WiFi 断开 ===
            elif path.startswith("/network/wifi/") and path.endswith("/disconnect"):
                iface = path[len("/network/wifi/"):-len("/disconnect")]
                try:
                    nm.wifi_disconnect(iface)
                    logging.info("WiFi 已断开: iface=%s", iface)
                    self._send_json(200, {"ok": True})
                except nm.NMError as e:
                    self._send_json(400, {"ok": False, "error": str(e)})

            # === 远程协助：开关与连通性检测 ===
            elif path == "/remote-assist/enable":
                REMOTE_ASSIST.enable(body.get("actor"))
                logging.info("远程协助已开启")
                self._send_json(200, {"ok": True})
            elif path == "/remote-assist/disable":
                REMOTE_ASSIST.disable(body.get("actor"))
                logging.info("远程协助已关闭")
                self._send_json(200, {"ok": True})
            elif path == "/remote-assist/test":
                self._send_json(200, {"ok": True, **REMOTE_ASSIST.test()})

            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except remote_assist.RemoteAssistError as e:
            self._send_json(e.http, {"ok": False, "error": str(e)})
        except Exception as e:
            logging.exception("POST 处理异常: %s", self.path)
            self._send_json(500, {"ok": False, "error": "internal error"})
        finally:
            WRITE_SEMAPHORE.release()

    # ---- 辅助 ----
    def _read_json(self) -> dict | None:
        """读取并解析 JSON body。返回 None 表示已发送错误响应，调用方应直接返回。"""
        length_str = self.headers.get("Content-Length", "0")
        try:
            length = int(length_str)
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid content-length"})
            return None
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False, "error": "payload too large"})
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return None

    def _send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


# =========================== 启动 ===========================

def main() -> None:
    global license_client
    setup_logging()
    license_client = None  # authenticated recovery infrastructure remains available

    if not TOKEN:
        logging.error("未设置 OS_HELPER_TOKEN，拒绝启动")
        sys.exit(1)

    def monitor_remote_assist() -> None:
        while True:
            try:
                REMOTE_ASSIST.monitor_tick()
            except Exception:  # noqa: BLE001 - 记录失败不影响网络管理
                logging.exception("远程协助会话监测失败")
            time.sleep(15)

    threading.Thread(target=monitor_remote_assist, name="remote-assist-monitor", daemon=True).start()
    logging.info("os-helper 启动: 端口=%d", PORT)
    server = http.server.ThreadingHTTPServer((os.environ.get("OS_HELPER_BIND_HOST", "127.0.0.1"), PORT), OSHelperHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("os-helper 停止")
        server.shutdown()


if __name__ == "__main__":
    main()
