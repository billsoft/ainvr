"""重启助手（2026-09-18）——配置中心"自动重启+进度条"功能唯一的特权组件。

背景：backend 跑在 docker 容器里，容器本身既没挂 docker.sock，也够不着
宿主机的 systemd/D-Bus——它没有任何办法重启 ai-service/ainvr-recorder
这两个跑在宿主机上的原生 systemd 服务。这个脚本就是补上这条路径的唯一
入口：一个极小的 HTTP 服务，backend 通过 host.docker.internal 打过来
（跟 AI_SERVICE_BASE_URL 走的是同一条既有 docker 网络路径，不需要新开
端口映射/挂载）。

⚠️ 2026-09-18 部署时踩过一次坑：一开始监听绑的是 127.0.0.1，结果
docker 容器经 host.docker.internal（实际落在 docker0 网桥网关，比如
172.17.0.1）发来的连接会被内核直接拒绝——"只监听 127.0.0.1"防的是局域网
其它机器，却顺带连自己的 docker 容器都连不上（ai-service 的 8000 端口
能被容器连通是因为它绑的是 0.0.0.0，不是同款限制）。现在改成绑
0.0.0.0，但在应用层用 SOURCE_POLICY 把来源 IP 收窄到"本机
回环 + docker 默认 bridge 网段"，局域网其它设备发来的请求会在鉴权之前
就被源 IP 拒绝——网络层面仍然不是"随便一台内网设备就能打"，只是判断点
从内核 bind 挪到了应用层。

信任边界故意收得很窄，抄的是这个仓库已有的先例（/etc/sudoers.d 里
ainvr 已经有 mount/umount/findmnt 的 NOPASSWD 窄授权）：
- 本进程以 ainvr（非 root）运行，不是 root 权限的常驻进程。
- 来源 IP 限于 loopback + 部署时登记的 Docker 子网，
  局域网其它设备的请求直接拒绝，判断在鉴权之前做（省一次哈希比较）。
- 真正执行重启靠 `sudo -n systemctl restart <unit>`——sudoers 规则只放行
  这两条精确命令（不是通配符），改不了别的任何东西。
- 允许重启的目标写死在 ALLOWED_TARGETS 里，不接受任意 unit 名。
- 鉴权用固定 token（本机生成，存 /etc/ainvr-ai/restart-helper.env，
  chmod 600），backend 侧同一份 token 存自己的 .env——跟
  CONFIG_SERVICE_TOKEN_* 的既有模式一致。
- 动作端点仅允许重启上述两个服务；observe 接口提供固定服务的只读指标、
  有界日志查询及归档策略，不接受任意命令、容器名或文件路径。

当前只收 ai-service 和 recorder 两个目标：backend 自己的配置永远是热
生效（BackendConfigAdapter.apply() 恒 applyVia='hot'），srs 唯一能改的
字段 rtcCandidateIp 也是 inotify 热重载（SrsConfigAdapter），两者都不
需要重启——写死更宽的允许列表只会扩大攻击面却用不上。
"""
from __future__ import annotations

import hmac
import http.server
import json
import logging
import threading
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from observability import Observer, deployment_units

# Recovery operations remain available under the existing authentication and target allowlist.
observer = None
observer_requests = threading.BoundedSemaphore(4)
license_client = None


def license_action_blocked(client) -> tuple[bool, str]:
    return False, "" if client is None else "management_exempt"


# 本机回环 + docker 默认 bridge 网段——局域网其它设备的真实网卡 IP
# （比如宿主机自己的 192.168.x.x）不在这两个范围内，会被拒绝。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from internal_network import NetworkPolicy
SOURCE_POLICY = NetworkPolicy()


def source_ip_allowed(addr: str) -> bool:
    return SOURCE_POLICY.allows(addr)

# 目标名 → systemd unit：唯一允许重启的两个服务。新增目标必须先确认
# 「除了重启没有别的生效路径」，不能图方便往这里塞。
AI_UNIT = deployment_units()['ai-service']
ALLOWED_TARGETS: dict[str, str] = {
    "ai-service": AI_UNIT,
    "recorder": "ainvr-recorder.service",
}

# systemctl restart 本身只等到 Type=simple 单元被 spawn（不等应用就绪），
# 正常几秒内返回；给个宽松上限防止 sudo/systemctl 本身卡死时把 HTTP 请求
# 也一起拖死。
RESTART_TIMEOUT_SECONDS = 30

# ===== 安全关机序列 =====
# 顺序：先停录像和 AI，再请求系统关机；基础设施由系统关机流程统一停止。
# 准备阶段保留授权与管理服务，避免提前切断管理入口。
# 每步串行执行，失败即终止并返回错误，绝不走到 poweroff。
# 不主动 docker stop，避免 unless-stopped 容器在下次开机时保持停止。
SHUTDOWN_SEQUENCE: list[dict] = [
    {
        "name": "停止录像服务",
        "service": "录像服务",
        "unit": "ainvr-recorder.service",
        "cmd": ["sudo", "-n", "/usr/bin/systemctl", "stop", "ainvr-recorder.service"],
        "restore": ["sudo", "-n", "/usr/bin/systemctl", "restart", "ainvr-recorder.service"],
        # 不短于单元自身 TimeoutStopSec=30（重连交接时同通道两代管线收尾），否则
        # 正常的慢停止会被误判失败
        "timeout": 35,
    },
    {
        "name": "停止 AI 识别服务",
        "service": "AI 识别服务",
        "unit": AI_UNIT,
        "cmd": ["sudo", "-n", "/usr/bin/systemctl", "stop", AI_UNIT],
        "restore": ["sudo", "-n", "/usr/bin/systemctl", "restart", AI_UNIT],
        # 单元未设 TimeoutStopSec，按 systemd 默认 90s
        "timeout": 95,
    },
    {
        "name": "系统关机",
        "cmd": ["sudo", "-n", "/usr/bin/systemctl", "poweroff"],
        "timeout": 5,
    },
]
# 注意：为什么不显式 docker stop 容器？
# 因为所有容器都是 unless-stopped 策略——如果我们手动 docker stop，
# Docker 会把它记成"管理员主动停止"，下次开机就不自动起来了。
# 正确做法是让 systemd 正常关机流程停掉 docker.service，
# daemon 会给所有容器发 SIGTERM 优雅退出（10s 宽限后 SIGKILL），
# 但不算"用户手动 stop"，下次开机 unless-stopped 会自动拉起。
# 数据库（PG/Mongo）收到 SIGTERM 会刷盘，数据安全不受影响。

# 关机组内幂等锁：避免双标签页/多客户端同时触发
_shutdown_lock = threading.Lock()

# 中途失败时把已停服务拉回来：restart 会排在仍未结束的 stop 之后，给足时间
RESTORE_TIMEOUT_SECONDS = 100

# 最近一次关机序列的结果，供页面查询（关机请求本身是 202 立即返回，失败只能事后查）
_status_lock = threading.Lock()
_shutdown_status: dict = {}


def _reset_shutdown_status() -> None:
    with _status_lock:
        _shutdown_status.clear()
        _shutdown_status.update({"state": "idle", "error": "", "restored": [], "restoreFailed": []})


def _set_shutdown_status(**fields) -> None:
    with _status_lock:
        _shutdown_status.update(fields)


def shutdown_status() -> dict:
    """state: idle / running / failed / poweringOff"""
    with _status_lock:
        return {**_shutdown_status, "restored": list(_shutdown_status["restored"]),
                "restoreFailed": list(_shutdown_status["restoreFailed"])}


_reset_shutdown_status()


RUNNING_STATES = {"active", "activating", "reloading"}


def _unit_running(unit: str) -> bool:
    """关机前服务是否在运行（含崩溃后等待自动重启）。查不到按运行中处理：宁可多恢复。"""
    try:
        proc = subprocess.run(["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", unit],
                              capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return True
    if proc.returncode != 0:
        return True
    return (proc.stdout or "").strip() in RUNNING_STATES


def _unit_missing(unit: str) -> bool:
    """Only an explicit systemd not-found permits skipping an optional service."""
    try:
        result = subprocess.run(["/usr/bin/systemctl", "show", "-p", "LoadState", "--value", unit],
                                capture_output=True, text=True, timeout=5)
        return (result.stdout or "").strip() == "not-found"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _restore_after_failure(failed_index: int, was_running: dict[str, bool]) -> tuple[list[str], list[str]]:
    """把失败步及之前已执行的停服务步骤反序恢复。失败/超时的那一步也恢复：
    stop 超时后 systemd 仍会把服务停掉。关机前就没在运行的（调试/维护时被人
    主动停掉）不恢复，restart 会把它拉起来。"""
    restored, failed = [], []
    for step in reversed(SHUTDOWN_SEQUENCE[:failed_index + 1]):
        cmd = step.get("restore")
        if not cmd or not was_running.get(step["unit"], True):
            continue
        name = step["service"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=RESTORE_TIMEOUT_SECONDS)
            ok = proc.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
        (restored if ok else failed).append(name)
        if ok:
            logging.info("[shutdown] 关机未完成，已恢复%s", name)
        else:
            logging.error("[shutdown] 关机未完成，恢复%s失败", name)
    return restored, failed


def try_begin_shutdown() -> bool:
    """非阻塞抢关机互斥锁。抢到返回 True，已在进行中返回 False。
    调用方抢到后负责最终释放（一般在后台 worker 的 finally 里）。"""
    return _shutdown_lock.acquire(blocking=False)


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


def token_is_valid(provided: str | None, expected: str) -> bool:
    """常数时间比较，防时序侧信道；空 token（未配置）恒拒绝，不当成"不鉴权"。"""
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


def resolve_unit(target: str) -> str | None:
    """target 不在允许列表时返回 None——调用方据此拒绝，不做任何猜测/模糊匹配。"""
    return ALLOWED_TARGETS.get(target)


def build_restart_command(unit: str) -> list[str]:
    """给定已解析的 unit 名，拼出要执行的命令。unit 必须先过 resolve_unit
    的白名单校验——这个函数本身不做校验，不能直接拿用户输入调用。"""
    return ["sudo", "-n", "systemctl", "restart", unit]


def run_restart(unit: str) -> tuple[bool, str]:
    """实际执行重启命令。返回 (成功与否, 附加信息/错误文本)。"""
    cmd = build_restart_command(unit)
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=RESTART_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        return False, f"重启命令超时（>{RESTART_TIMEOUT_SECONDS}s）"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or f"退出码 {proc.returncode}").strip()
    return True, ""


def run_shutdown() -> tuple[bool, str, int]:
    """执行安全关机序列（会自行抢锁 + 释放，单步调用入口）。
    返回 (成功与否, 错误文本, 完成到第几步)。
    注意：HTTP handler 不要直接调这个——它是同步阻塞的，
    关机序列第 4 步会停掉后端/前端容器，调用方永远收不到响应。
    HTTP 层应该用 try_begin_shutdown() + 后台线程的模式。"""
    acquired = _shutdown_lock.acquire(blocking=False)
    if not acquired:
        return False, "关机已在进行中，请勿重复操作", 0
    try:
        return _run_shutdown_locked()
    finally:
        # 注意：最后一步 poweroff 成功后进程会立刻结束，这里的释放可能来不及执行
        # 但没关系——系统都关了，也不会有新请求进来
        _shutdown_lock.release()


def _run_shutdown_locked() -> tuple[bool, str, int]:
    """实际跑关机序列。调用前必须已经持有 _shutdown_lock。
    返回 (成功与否, 错误文本, 完成到第几步)。不会自己释放锁。
    任何一步失败都不再往下走，并把已停的服务恢复——绝不留下"没断电、也没在
    录像"的设备。"""
    _set_shutdown_status(state="running", error="", restored=[], restoreFailed=[])
    was_running = {s["unit"]: _unit_running(s["unit"]) for s in SHUTDOWN_SEQUENCE if s.get("restore")}
    for i, step in enumerate(SHUTDOWN_SEQUENCE):
        if step.get("unit") == AI_UNIT and _unit_missing(step["unit"]):
            was_running[step["unit"]] = False
            logging.info("[shutdown] Optional AI service is not installed; skipping")
            continue
        name = step["name"]
        cmd = step["cmd"]
        timeout = step.get("timeout", 30)
        logging.info("[shutdown] 第 %d 步：%s", i + 1, name)
        err = ""
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout
            )
            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or f"退出码 {proc.returncode}").strip()
                err = f"第 {i+1} 步「{name}」失败：{detail}"
        except subprocess.TimeoutExpired:
            err = f"第 {i+1} 步「{name}」超时（>{timeout}s）"
        if err:
            restored, failed = _restore_after_failure(i, was_running)
            if failed:
                err += f"；关机已中止，恢复失败：{'、'.join(failed)}，请手动重启设备"
            elif restored:
                err += f"；关机已中止，已恢复：{'、'.join(restored)}"
            else:
                err += "；关机已中止"
            _set_shutdown_status(state="failed", error=err, restored=restored, restoreFailed=failed)
            return False, err, i
    _set_shutdown_status(state="poweringOff")
    return True, "", len(SHUTDOWN_SEQUENCE)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "AINVRRestartHelper/1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Polling is not an operational event. Failures are returned to BFF and archived there.
        return

    def authorized(self):
        if not source_ip_allowed(self.client_address[0]):
            self._send_json(403, {'ok':False,'error':'forbidden'}); return False
        token = self.headers.get('Authorization','').removeprefix('Bearer ')
        if not token_is_valid(token, os.environ.get('RESTART_HELPER_TOKEN','')):
            self._send_json(401, {'ok':False,'error':'unauthorized'}); return False
        return True

    def do_GET(self):
        if not self.authorized(): return
        if urlsplit(self.path).path == '/shutdown/status':
            self._send_json(200, {'ok': True, 'status': shutdown_status()})
            return
        if not observer_requests.acquire(blocking=False):
            self._send_json(429, {'error':'busy'}); return
        try:
            route=urlsplit(self.path); query=parse_qs(route.query)
            get=lambda k,d='': query.get(k,[d])[0]
            if route.path=='/observe/summary':
                self._send_json(200, {'snapshot':observer.snapshot,'settings':observer.config,
                                     'sources':__import__('observability').SOURCES})
            elif route.path=='/observe/history':
                hours=int(get('hours','1'))
                if not 1<=hours<=168: raise ValueError('hours')
                self._send_json(200, {'items':observer.history(hours)})
            elif route.path=='/observe/logs':
                limit=int(get('limit','200'))
                if not 1<=limit<=500 or len(get('q'))>200: raise ValueError('query')
                self._send_json(200, observer.logs(get('source'),get('level'),get('q'),int(get('start','0')),int(get('end','0')),limit,get('cursor')))
            else: self._send_json(404, {'error':'not found'})
        except (ValueError,TypeError): self._send_json(400, {'error':'invalid query'})
        except Exception: self._send_json(503, {'error':'collector unavailable'})
        finally: observer_requests.release()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        # 授权门（接线后）：任何写/动作类请求在鉴权之后、路由之前统一拒绝。
        # 失权期间不能借重启助手停启服务绕过管控（设计 §16 执行矩阵）。
        blocked, phase = license_action_blocked(license_client)
        if blocked:
            self._send_json(403, {
                "ok": False,
                "code": "LICENSE_REQUIRED",
                "error": "license required",
                "phase": phase,
            })
            return
        if self.path=='/observe/settings':
            if not self.authorized(): return
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=4096: raise ValueError('body')
                self.connection.settimeout(3)
                settings=observer.configure(json.loads(self.rfile.read(length)))
                observer.append('helper','INFO','日志归档策略已应用','settings','audit')
                self._send_json(200, {'ok':True,'settings':settings})
            except (ValueError,TypeError): self._send_json(400, {'error':'invalid settings'})
            except Exception: self._send_json(503, {'error':'settings unavailable'})
            return
        source_ip = self.client_address[0]
        if not source_ip_allowed(source_ip):
            logging.warning("[source] 拒绝：来源 IP 不在允许网段 ip=%s", source_ip)
            self._send_json(403, {"ok": False, "error": "forbidden"})
            return

        expected_token = os.environ.get("RESTART_HELPER_TOKEN", "")
        provided = self.headers.get("Authorization", "")
        if provided.startswith("Bearer "):
            provided = provided[len("Bearer "):]
        if not token_is_valid(provided, expected_token):
            logging.warning("[auth] 拒绝：token 无效或缺失（path=%s）", self.path)
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        parts = self.path.strip("/").split("/")

        # ===== 安全关机 =====
        if len(parts) == 1 and parts[0] == "shutdown":
            logging.info("[shutdown] 收到安全关机请求")
            # 先抢锁再回包：并发请求只能有一个拿到"已受理"
            if not try_begin_shutdown():
                logging.warning("[shutdown] 重复触发，拒绝")
                self._send_json(409, {"ok": False, "error": "关机已在进行中，请勿重复操作"})
                return
            # 回包前就标记为执行中：页面随后查状态不会读到上一次的失败结果
            _set_shutdown_status(state="running", error="", restored=[], restoreFailed=[])
            # 立即回 202 已受理，然后后台线程跑序列。
            # 不能等序列跑完再回——第 4 步会停掉后端/前端容器，
            # 调用方（浏览器→nginx→BFF）的连接到那时早就断了，
            # 200/500 都送不到，用户反而看到假失败。
            self._send_json(202, {"ok": True, "accepted": True, "stepsPlanned": len(SHUTDOWN_SEQUENCE)})
            self.wfile.flush()

            def _worker() -> None:
                try:
                    ok, error, step = _run_shutdown_locked()
                    if ok:
                        logging.info("[shutdown] 关机序列执行完成，系统即将断电")
                    else:
                        # 执行结果无法回传给前端（step4 之后 Web 链路已断），
                        # 只能落日志；排查请开机后查 journalctl -u ainvr-restart-helper
                        logging.error("[shutdown] 关机失败 step=%d error=%s", step, error)
                finally:
                    _shutdown_lock.release()

            threading.Thread(target=_worker, name="shutdown-sequence", daemon=True).start()
            return

        if len(parts) != 2 or parts[0] != "restart":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        target = parts[1]
        unit = resolve_unit(target)
        if unit is None:
            logging.warning("[restart] 拒绝：目标不在允许列表 target=%s", target)
            self._send_json(400, {"ok": False, "error": f"target 不在允许列表: {target}"})
            return

        logging.info("[restart] 开始重启 target=%s unit=%s", target, unit)
        ok, error = run_restart(unit)
        if ok:
            logging.info("[restart] 重启命令已成功执行 target=%s", target)
            self._send_json(200, {"ok": True})
        else:
            logging.error("[restart] 重启失败 target=%s error=%s", target, error)
            self._send_json(500, {"ok": False, "error": error})


def main() -> None:
    global observer, license_client
    setup_logging()
    license_client = None  # authenticated recovery infrastructure remains available
    # 必须绑 0.0.0.0——docker 容器经 host.docker.internal 发来的连接落在
    # docker0 网桥网关（如 172.17.0.1），不是真正的 127.0.0.1，绑
    # 127.0.0.1 会被内核直接拒绝（2026-09-18 部署时的真实教训）。
    # 网络层面的收窄改在应用层做，见 source_ip_allowed()。
    host = os.environ.get("RESTART_HELPER_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("RESTART_HELPER_PORT", "8199"))
    if not os.environ.get("RESTART_HELPER_TOKEN"):
        logging.error("RESTART_HELPER_TOKEN 未设置，拒绝启动（不允许无鉴权监听）")
        sys.exit(1)
    try:
        observer = Observer()
    except Exception:
        # A full/broken archive disk must not disable configuration service restarts.
        logging.exception('采集初始化失败；保留重启接口，采集接口返回不可用')
    server = http.server.ThreadingHTTPServer((host, port), Handler)
    logging.info("[start] 重启助手已启动 %s:%s（允许目标：%s；来源限 %s）",
                 host, port, ", ".join(ALLOWED_TARGETS),
                 str(SOURCE_POLICY.path))
    server.serve_forever()


if __name__ == "__main__":
    main()
