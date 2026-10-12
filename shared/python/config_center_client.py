"""
配置中心客户端（AI 微服务 / 录像微服务共享的唯一真源）

历史（2026-09-16 评审收口）：本模块此前在
- ai-service/src/ai_service/config_center_client.py
- recording-service/src/recorder/config_center_client.py
各有一份手工同步的完整拷贝。现统一为本文件，服务侧只保留一个自举垫片
（把本目录加进 sys.path 后转出 ConfigCenterClient / client_from_env），
各服务原有的包内 import 路径与测试均不变。

设计原则：
- BFF/配置中心是唯一配置写入口（管理员通过 Web UI 改 + 发布）
- 服务只读配置、验证应用、上报状态
- 启动时优先从配置中心拉取，本地文件仅作启动兜底
- 后台轮询 desired_version，发现新版本即验证+应用+上报

通信：HTTP 调 BFF 的 /api/v1/config/* 端点
鉴权：X-Service-Token（服务间独立令牌，与控制台密码解耦）
      令牌环境变量与 BFF backend/src/services/serviceTokens.ts 的
      ENV_BY_SERVICE 对齐：CONFIG_SERVICE_TOKEN_<SERVICE>（服务名大写、
      短横线转下划线，如 ai-service → CONFIG_SERVICE_TOKEN_AI_SERVICE），
      旧共享变量 CONFIG_SERVICE_TOKEN 仅作一个发布周期的回退。
失败重试：指数退避（同版本失败后 5s/10s/20s/40s... 封顶 5min），不永久放弃
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

logger = logging.getLogger(__name__)

RETRY_BASE_SECONDS = 5.0
RETRY_MAX_SECONDS = 300.0

# on_apply 回调返回值：纯 bool（ok，向后兼容——recorder 自己内部靠
# supervisor.request_restart() 热重启录制子进程，永远不需要重启整个
# 服务进程，用不上第二个值）或 (ok, restart_required) 元组——只有
# ai-service 用得到后者：ChannelWorker 的 Mongo 连接只在构造时读一次，
# 落盘 overlay 不会自己重连，改了 mongo_uri/db_name 之后必须真的重启
# 进程才生效（见 ai-service 的 config_center_apply.snapshot_store_restart_required）。
ApplyResult = bool | tuple[bool, bool]


class ConfigCenterClient:
    """配置中心客户端：轮询 + 验证应用 + 状态上报（指数退避重试）。"""

    def __init__(
        self,
        base_url: str,
        service_name: str,
        service_token: str = "",
        on_apply: Callable[[dict[str, Any]], ApplyResult] | None = None,
        poll_interval_seconds: int = 10,
    ):
        """
        Args:
            base_url: BFF 地址，如 http://127.0.0.1:3001
            service_name: 本服务在配置中心注册的名字，如 recorder
            service_token: 服务间令牌（X-Service-Token），空则不带
            on_apply: 应用回调（同步）。传入新配置 dict，返回 True／(True, restart_required)
                      表示应用并落盘成功（后者用于告知这次改动是否需要重启进程才
                      真正生效）；抛异常或返回 False／(False, ...) 视为失败，
                      会指数退避重试。
            poll_interval_seconds: 轮询间隔（秒）
        """
        self.base_url = base_url.rstrip("/")
        self.service_name = service_name
        self.service_token = service_token
        self.on_apply = on_apply
        self.poll_interval = poll_interval_seconds

        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._applied_version: int | None = None
        self._retry_delay = RETRY_BASE_SECONDS

    # ---------- 公共 API ----------

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run_loop,
            name=f"config-center-{self.service_name}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    @property
    def applied_version(self) -> int | None:
        return self._applied_version

    # ---------- HTTP ----------

    def _request(self, path: str, method: str = "GET", body: dict | None = None) -> dict | None:
        url = f"{self.base_url}/api/v1/config{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.service_token:
            headers["X-Service-Token"] = self.service_token

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") == 0:
                    return result.get("data")
                logger.warning("[config-center] 返回非 0: %s", result.get("error"))
                return None
        except urllib.error.HTTPError as e:
            logger.warning("[config-center] HTTP %s: %s %s", e.code, method, path)
            return None
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            logger.debug("[config-center] 不可达: %s", e)
            return None

    # ---------- 核心循环 ----------

    def _run_loop(self) -> None:
        logger.info(
            "[config-center] 启动：service=%s base=%s poll=%ss",
            self.service_name, self.base_url, self.poll_interval,
        )
        self._try_update()  # 启动先试一次

        while not self._stop_event.is_set():
            # 失败退避期间用更短的检查步长
            wait = self._retry_delay if self._retry_pending else self.poll_interval
            step = 0.5
            waited = 0.0
            while waited < wait and not self._stop_event.is_set():
                time.sleep(step)
                waited += step
            if self._stop_event.is_set():
                return
            self._try_update()

    @property
    def _retry_pending(self) -> bool:
        return self._retry_delay > RETRY_BASE_SECONDS

    def _try_update(self) -> None:
        try:
            self._do_update()
        except Exception as e:
            logger.warning("[config-center] 更新异常: %s", e)
            self._bump_retry()

    def _bump_retry(self) -> None:
        self._retry_delay = min(self._retry_delay * 2, RETRY_MAX_SECONDS)
        logger.info("[config-center] 下次重试 %.0fs 后", self._retry_delay)

    def _reset_retry(self) -> None:
        self._retry_delay = RETRY_BASE_SECONDS

    def _do_update(self) -> None:
        # 1. 查服务状态拿 desired_version
        state = self._request(f"/service-states/{self.service_name}")
        if state is None:
            return  # 配置中心不可达/未注册，静默等待下轮（按 poll_interval，不退避）
        desired = state.get("desiredVersion") or state.get("desired_version")
        if desired is None or desired == self._applied_version:
            self._reset_retry()
            return

        logger.info("[config-center] 发现目标版本 v%s（当前 applied=%s）",
                    desired, self._applied_version)

        # 2. 拉版本快照（?service= 服务视图：BFF 只返回本服务文档，并解析
        #    本服务前缀的 ${secret:key} 占位符——按服务过滤后才解密，
        #    拿不到别的服务的明文；需要本服务的 CONFIG_SERVICE_TOKEN_<SVC>
        #    与 BFF 同值）
        snapshot = self._request(
            f"/versions/{desired}/snapshot?service={self.service_name}"
        )
        if snapshot is None:
            self._fail(desired, error="版本快照拉取失败")
            return

        config = self._merge_documents(snapshot)
        if config is None:
            # 区分「尚未配置」（此前从未发布过本服务配置）与「发布后丢失」
            if self._applied_version is None and not self._ever_had_config():
                logger.info("[config-center] v%s 无本服务配置，继续用本地兜底", desired)
                # 上报成功才标记看过该版本；失败则下轮重试同一版本
                if self._report(desired, "applied"):
                    self._applied_version = desired
                    self._reset_retry()
                else:
                    self._bump_retry()
            else:
                self._fail(desired, error="快照缺少本服务配置")
            return

        # 3. 验证 + 应用（同步回调内完成；失败抛异常/返回 False）
        try:
            result = self.on_apply(config) if self.on_apply else True
        except Exception as e:
            logger.exception("[config-center] 应用异常 v%s: %s", desired, e)
            self._fail(desired, error=str(e))
            return

        # on_apply 可以只返回 bool（recorder：自己内部热重启，永远不需要
        # 重启整个进程），也可以返回 (ok, restart_required) 元组（ai-service：
        # 部分字段落盘后仍要重启进程才生效，见模块头注释）。
        ok, restart_required = result if isinstance(result, tuple) else (result, False)

        if not ok:
            self._fail(desired, error="校验失败或被拒")
            return

        logger.info("[config-center] 应用成功 v%s%s", desired,
                    "（需要重启进程才完全生效）" if restart_required else "")
        # 上报成功才推进 applied_version：否则下一轮 desired != applied
        # 会重新走一遍（apply 幂等，重复落盘无害）并重试上报，避免
        # 「服务已生效但控制台永远停在 pending」的状态不一致。
        if self._report(desired, "applied", restart_required=restart_required):
            self._applied_version = desired
            self._reset_retry()
        else:
            logger.warning("[config-center] v%s 状态上报失败，下轮重试", desired)
            self._bump_retry()

    def _fail(self, version: int, error: str) -> None:
        """记录失败并安排退避重试（上报失败不影响退避节奏）。"""
        self._report(version, "failed", error=error)
        self._bump_retry()

    def _ever_had_config(self) -> bool:
        """当前（未发布快照）文档里是否存在本服务配置——用于区分从未配置 vs 丢失。"""
        docs = self._request("/documents?service=" + self.service_name)
        if not docs:
            return False
        return any(
            d.get("group") == "system" and d.get("name") == "settings" for d in docs
        )

    def _merge_documents(self, docs: list[dict]) -> dict | None:
        """本服务的 <service>/system/settings 文档 → 服务级配置 dict。

        服务名/文档名是配置中心的通用约定：system/settings = 该服务的服务级
        配置，内容由各服务的 apply 层按自身 schema 校验（AI 侧见
        config_center_apply.apply_config_center_patch；录像侧见
        recorder.app.apply_centered 等回调）。
        """
        for doc in docs:
            if doc.get("service") != self.service_name:
                continue
            if doc.get("group") == "system" and doc.get("name") == "settings":
                return doc.get("config") or {}
        return None

    def _report(self, version: int, status: str,
                restart_required: bool = False, error: str | None = None) -> bool:
        """上报状态；返回是否成功（调用方据此决定是否推进 applied_version）。

        2026-09-16 修复：appliedVersion 字段此前恒用 self._applied_version
        （更新前的旧值）——调用方总是先 _report() 再推进 self._applied_version
        = version（见上面两处调用点的注释），导致 status="applied" 时上报的
        版本号永远比这次真正应用成功的 version 落后一拍：首次应用上报
        appliedVersion=None 却 status=applied，此后每次都少一拍、永远追不上
        desiredVersion，BFF 的 detectDrift() 因此把本服务永久判定为漂移，
        即便它其实已经完全同步。status="failed" 时语义不同：这次没应用
        成功，"当前仍然生效的版本"就是 self._applied_version，这条分支本来
        是对的，不能一起改成 version（那样失败也会谎报成功应用了新版本）。"""
        body: dict[str, Any] = {
            "appliedVersion": version if status == "applied" else self._applied_version,
            "status": status,
            "restartRequired": restart_required,
        }
        # 成功时显式清空历史错误（后端 ON CONFLICT 保留未传字段）；
        # 失败时写入本次错误信息。
        body["errorMessage"] = error or ""
        return self._request(
            f"/service-states/{self.service_name}", method="POST", body=body
        ) is not None


def service_token_env_name(service_name: str) -> str:
    """分服务令牌环境变量名（与 BFF serviceTokens.ts 的映射同规则）。"""
    return "CONFIG_SERVICE_TOKEN_" + service_name.upper().replace("-", "_")


def client_from_env(service_name: str, on_apply: Callable[[dict[str, Any]], ApplyResult],
                    poll_interval_seconds: int = 10) -> ConfigCenterClient | None:
    """从环境变量构建客户端；未配置 CONFIG_CENTER_URL 时返回 None（禁用接入）。

    环境变量：
      CONFIG_CENTER_URL              BFF 地址，如 http://127.0.0.1:3001
      CONFIG_SERVICE_TOKEN_<SERVICE>  本分服务令牌（优先，与 BFF 分服务令牌对齐）
      CONFIG_SERVICE_TOKEN           旧共享令牌（回退，一个发布周期后移除）
      CONFIG_CENTER_POLL             轮询秒数（可选，默认 10）
    """
    base = os.environ.get("CONFIG_CENTER_URL", "").strip()
    if not base:
        return None
    # 分服务变量优先；旧共享变量仅回退（BFF 半边部署期间两套名字曾并存）
    token = (
        os.environ.get(service_token_env_name(service_name), "").strip()
        or os.environ.get("CONFIG_SERVICE_TOKEN", "").strip()
    )
    poll = int(os.environ.get("CONFIG_CENTER_POLL", str(poll_interval_seconds)))
    return ConfigCenterClient(
        base_url=base,
        service_name=service_name,
        service_token=token,
        on_apply=on_apply,
        poll_interval_seconds=poll,
    )
