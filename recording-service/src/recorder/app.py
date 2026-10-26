"""FastAPI 应用：8 个契约端点 + 后台任务编排。

响应一律原始 JSON（不包 code/data 信封），前端 request<T>() 直接消费。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from pydantic import BaseModel

from . import __version__
from .auth import require_console_or_local_probe, require_console_token, require_media_token
from .channels import ChannelManager
from .config import ChannelSchedule, ConfigStore, RecorderConfig
from .config_center_client import client_from_env
from .index import SegmentIndex
from .license_guard import build_guard
from .media import LimitedFileResponse, resolve_segment_file
from .quota import QuotaEnforcer
from .naming import segment_time_precision_ms
from .playback_protection import PlaybackProtection
from .playback_sei import PlaybackSeiReader
from .scanner import CatalogResolver, Scanner
from .sei_indexer import SeiIndexer
from .storage import StorageManager
from .storage_io import StorageIOError
from .supervisor import Supervisor
from .write_diagnostics import monitor as monitor_writes

log = logging.getLogger(__name__)

# 媒体发送并发上限：FileResponse 的 stat/sendfile 走 anyio 共享线程池，
# NAS 变慢时限流，防止慢播放占满共享池后饿死其它 to_thread 调用方。
MEDIA_CONCURRENCY = 4


async def stop_background_tasks(tasks):
    """Python 3.10 wait_for can race with cancellation; never await forever."""
    pending = set(tasks)
    for _ in range(3):
        for task in pending:
            task.cancel()
        if not pending:
            break
        done, pending = await asyncio.wait(pending, timeout=1)
        for task in done:
            if not task.cancelled():
                task.exception()
        if pending:
            log.warning('shutdown_pending tasks=%s', [t.get_name() for t in pending])
    if pending:
        raise RuntimeError('Background tasks ignored repeated cancellation: ' +
                           ','.join(t.get_name() for t in pending))


# ---------- 入参模型（与 SaveConfigInput 对齐） ----------

class SmbInput(BaseModel):
    host: str = ""
    share: str = ""
    path: str = ""
    username: str = ""
    password: str | None = None
    smbVersion: str = "auto"
    domain: str | None = None


class StorageInput(BaseModel):
    kind: str
    localPath: str | None = None
    smb: SmbInput | None = None


class QuotaInput(BaseModel):
    mode: str
    percent: int | None = None
    gb: int | None = None
    onFull: str
    minRetentionDays: int | None = None


class FilesInput(BaseModel):
    segmentSeconds: int


class SaveConfigBody(BaseModel):
    enabledChannelIds: list[str] | None = None
    storage: StorageInput | None = None
    quota: QuotaInput | None = None
    files: FilesInput | None = None


# ---------- 序列化 ----------

def _storage_public(cfg: RecorderConfig) -> dict:
    if cfg.storage.kind == "smb" and cfg.storage.smb is not None:
        smb = cfg.storage.smb.public()
    else:
        smb = None
    return {"kind": cfg.storage.kind, "localPath": cfg.storage.localPath, "smb": smb}


def config_public(cfg: RecorderConfig) -> dict:
    return {
        "storage": _storage_public(cfg),
        "quota": {
            "mode": cfg.quota.mode,
            "percent": cfg.quota.percent,
            "gb": cfg.quota.gb,
            "onFull": cfg.quota.onFull,
            "minRetentionDays": cfg.quota.minRetentionDays,
        },
        "files": {"segmentSeconds": cfg.files.segmentSeconds},
    }


def _write_warning(write: dict) -> str | None:
    if not write["writeDegradedChannels"]:
        return None
    return (f"近 1 小时存在未保存录像：{write['writeDegradedChannels']} 路共缺失约 "
            f"{round(write['droppedMsLastHour'] / 1000)} 秒（按完整画面组丢弃，已录画面可正常播放）")


def segment_public(seg: dict, playable: bool) -> dict:
    return {
        "id": seg["id"],
        "channelId": seg["channelId"],
        "startTs": seg["startTs"],
        "startPrecisionMs": segment_time_precision_ms(os.path.basename(seg.get("relPath", ""))),
        "endTs": seg["endTs"],
        "durationMs": seg["durationMs"],
        "sizeBytes": seg["sizeBytes"],
        "codec": seg["codec"],
        "width": seg["width"],
        "height": seg["height"],
        "fps": seg["fps"],
        "hasAudio": seg["hasAudio"],
        "seiPresent": seg["seiPresent"],
        "seiRanges": seg.get("seiRanges"),
        "storage": seg["storage"],
        "playable": playable,
    }


# ---------- 应用装配 ----------

def parse_channel_schedules(raw_schedules, enabled_ids):
    """从下发配置解析通道录像计划（唯一规范 channelId → ChannelSchedule）。

    返回 (schedules, error)：error 非空表示非法应拒绝；
    raw_schedules 与 enabled_ids 均缺失时返回 (None, "")——调用方保留既有计划。
    仅提供 enabledChannelIds（旧前端）时迁移为全天录计划（hours=0-23）。
    """
    if raw_schedules is None:
        if enabled_ids is None:
            return None, ""
        return {
            cid: ChannelSchedule(enabled=True) for cid in dict.fromkeys(enabled_ids)
        }, ""
    if not isinstance(raw_schedules, dict):
        return None, "channelSchedules 必须是对象"
    schedules: dict[str, ChannelSchedule] = {}
    for cid, spec in raw_schedules.items():
        if not isinstance(cid, str) or not isinstance(spec, dict):
            return None, f"channelSchedules 条目非法: {cid!r}"
        try:
            schedules[cid] = ChannelSchedule.model_validate(spec)
        except Exception as e:  # noqa: BLE001
            return None, f"通道 {cid} 计划非法: {e}"
    return schedules, ""

def create_app(store: ConfigStore, data_dir: str, guard_factory=build_guard) -> FastAPI:
    """guard_factory 只供测试注入授权状态；生产（main.py）一律用默认的 build_guard。"""
    from .storage_identity import storage_identity
    index = SegmentIndex(os.path.join(data_dir, "segments.db"))
    index.activate_storage(storage_identity(store.get().recording.storage))
    storage_mgr = StorageManager()
    channels = ChannelManager(store, index)
    resolver = CatalogResolver()
    scanner = Scanner(index, storage_mgr, resolver, store.get().recording.files.segmentSeconds)
    sei_indexer = SeiIndexer(index, storage_mgr,
                             channel_kind=channels.confirmed_kind)
    # Production requires licensing. Only explicit development settings bypass it.
    license_client, license_guard = guard_factory()
    supervisor = Supervisor(store, channels, storage_mgr, index,
                            license_gate=license_guard.licensed)
    playback_protection = PlaybackProtection()
    quota_enforcer = QuotaEnforcer(store, index, storage_mgr, playback_protection)
    media_sem = asyncio.Semaphore(MEDIA_CONCURRENCY)
    playback_sei = PlaybackSeiReader()

    # ---------- 配置中心接入（CONFIG_CENTER_URL 未设置时不启用） ----------
    #
    # 下发配置的应用流程（同步回调内完成，成功才返回 True）：
    #   1. pydantic 校验（RecorderConfig）——非法配置直接拒绝并上报 failed
    #   2. 存储变更先 apply_config 验证（挂载成功才落盘），失败回滚并拒绝
    #   3. 写入 ConfigStore 的 recording 子树 + channel_schedules 并落盘
    #      （本地 config.json 作为下次启动兜底，权威源仍是配置中心）
    #   4. 仅存储/分段等影响在录进程的参数变化时标记 supervisor 重启；
    #      仅录像计划（channelSchedules/enabledChannelIds）变化不重启——
    #      supervisor 每 3s 按新计划重算 wanted，到点自然停/启 ffmpeg，
    #      避免改个时间段把全部在录进程重启一遍造成分段中断。
    def apply_centered(raw: dict) -> bool:
        try:
            recording = RecorderConfig.model_validate(raw)
        except Exception as e:
            log.warning("[config-center] 配置校验失败，拒绝: %s", e)
            return False
        enabled_ids = raw.get("enabledChannelIds")
        if enabled_ids is not None and (
            not isinstance(enabled_ids, list) or not all(isinstance(x, str) for x in enabled_ids)
        ):
            log.warning("[config-center] enabledChannelIds 类型非法，拒绝")
            return False

        # channelSchedules 为唯一规范（channelId → {enabled, hours}）。
        # 缺失时（旧文档/旧前端）从 enabledChannelIds 只读派生兼容计划：
        # 勾选的通道全天录（hours=0-23），未勾选的不录。
        new_schedules, sched_err = parse_channel_schedules(
            raw.get("channelSchedules"), enabled_ids)
        if sched_err:
            log.warning("[config-center] 录像计划解析失败，拒绝: %s", sched_err)
            return False

        old_recording = store.get().recording
        old_storage = old_recording.storage
        restart_required = recording.files.segmentSeconds != old_recording.files.segmentSeconds
        new_storage = recording.storage

        # 敏感字段保护：PG 文档不存明文密码（下发配置里 smb.password 为空），
        # 应用时从本地 config.json（0600）保留已有密码自举，SMB 重挂载不失败。
        if new_storage.smb is not None and not new_storage.smb.password:
            if old_storage.smb is not None and old_storage.smb.password:
                new_storage.smb.password = old_storage.smb.password

        storage_changed = (
            new_storage.model_dump(exclude_none=True) != old_storage.model_dump(exclude_none=True)
        )

        async def _apply() -> bool:
            async with supervisor.configuration_change(storage_changed or restart_required):
                if storage_changed:
                    storage_mgr.trip("config-change", "正在切换存储，暂停录像和扫描")
                    try:
                        await storage_mgr.apply_config(new_storage, reconnect=True)
                    except Exception as e:
                        log.warning("[config-center] 存储应用失败，尝试恢复原配置: %s", e)
                        try:
                            await storage_mgr.apply_config(old_storage, reconnect=True)
                        except Exception:
                            storage_mgr.trip("config-rollback", "存储配置回滚未完成，停止录制等待恢复")
                        return False
                cfg = store.mutate()
                try:
                    cfg.recording = recording
                    if enabled_ids is not None:
                        cfg.enabled_channel_ids = list(dict.fromkeys(enabled_ids))
                    if new_schedules is not None:
                        cfg.channel_schedules = new_schedules
                        cfg.enabled_channel_ids = []
                finally:
                    store.commit()
                scanner.segment_seconds = recording.files.segmentSeconds
                (await index.run(index.activate_storage, storage_identity(recording.storage)))
                # Reconcile before acknowledging: disabled channels have stopped;
                # offline/faulted channels retain their explicit waiting/error state.
                await supervisor._tick_unlocked()
                return True

        async def _bounded_apply() -> bool:
            try:
                return await asyncio.wait_for(_apply(), timeout=420)
            except asyncio.TimeoutError:
                storage_mgr.trip("config-timeout", "配置应用超时，底层 I/O 结果未知")
                return False

        fut = asyncio.run_coroutine_threadsafe(_bounded_apply(), _loop_holder["loop"])
        try:
            return fut.result()
        except Exception as e:
            log.warning("[config-center] 配置应用失败: %s", e)
            return False

    # 主事件循环引用：客户端线程用 run_coroutine_threadsafe 桥接存储验证。
    # ⚠️ 必须在 lifespan（事件循环运行中）里取 get_running_loop()——create_app
    # 在 uvicorn.run() 之前执行，此时拿到的循环不是 uvicorn 实际运行的循环，
    # run_coroutine_threadsafe 到未运行的循环会永远挂起。
    _loop_holder: dict[str, asyncio.AbstractEventLoop] = {}

    config_center = client_from_env("recorder", apply_centered)

    async def catalog_loop() -> None:
        while True:
            try:
                await channels.refresh_once()
                await resolver.update(channels.channels)
            except Exception:  # noqa: BLE001
                await asyncio.sleep(1)
            await asyncio.sleep(5)

    async def storage_watchdog_loop() -> None:
        while True:
            await asyncio.sleep(30)
            try:
                ok = await storage_mgr.watchdog_check()
                if not ok:
                    # try_recover 内部单飞 + 懒卸载重挂；失败按指数退避
                    # （30s→15min），退避期内不停录重挂、不打日志。
                    # 每次真实尝试都留日志：2026-09-18 现场曾出现恢复循环静默
                    # 消失、熔断后无人重挂（健康检查一直 unhealthy），无日志
                    # 就无法区分"NAS 没恢复"还是"我们根本没去恢复"。
                    if not storage_mgr.recover_due():
                        continue
                    attempt = storage_mgr.recover_attempts + 1
                    action = "懒卸载+重挂" if storage_mgr.current_status().kind == "smb" else "重新检查本机存储"
                    if storage_mgr.io.tripped:
                        log.warning("存储熔断 OPEN 中，第 %d 次尝试自愈（%s）", attempt, action)
                    else:
                        log.warning("存储探活失败，第 %d 次尝试恢复（%s）", attempt, action)
                    async with supervisor.configuration_change(stop_recorders=True):
                        # Read only after acquiring the same lock as config apply.
                        if not storage_mgr.current_status().healthy:
                            await storage_mgr.try_recover(store.get().recording.storage)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("存储探活/恢复轮异常")

    async def quota_loop() -> None:
        while True:
            await asyncio.sleep(60)
            try:
                # enforce 内每个 os.unlink 单独走熔断执行器隔离车道（2026-09
                # 冻死事故主病灶），单文件超时即跳闸停录，绝不阻塞事件循环；
                # 超时轮未执行到的 index.delete 自然不发生，物理/索引一致性
                # 由 scanner 重扫对账（见 quota.py 注释）。
                async with supervisor.configuration_change():
                    await quota_enforcer.enforce(storage_mgr.current_status().kind)
                (await index.run(index.prune_drop_events, ))
            except StorageIOError as e:
                log.warning("配额轮存储无响应（熔断已动作，等待重挂恢复）：%s", e)
            except Exception:  # noqa: BLE001
                log.exception("配额轮异常")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 主事件循环引用（客户端线程桥接用）——此刻循环已在运行
        _main_loop = asyncio.get_running_loop()
        _loop_holder["loop"] = _main_loop
        # SIGUSR1 现场转储（kill -USR1 <pid> → journal 看全部任务/线程栈）
        from .diag import install_dump_signal
        install_dump_signal(_main_loop,
                            extra_snapshot=storage_mgr.io.snapshot)
        # 启动：恢复存储状态（失败不崩溃，转 storage_error 等重试）
        sc = store.get().recording.storage
        try:
            await storage_mgr.apply_config(sc)
        except Exception as e:  # noqa: BLE001
            st = storage_mgr.current_status()
            st.kind = sc.kind
            st.healthy = False
            st.root = sc.localPath if sc.kind == "local" else st.root
            st.message = f"启动时存储不可用：{e}"
        # 后台任务监督：任何任务意外退出（异常/CancelledError 以外的
        # BaseException、协程泄漏）都 3s 后自动拉起——2026-09-18 现场
        # storage-watch 曾静默消失，导致熔断后无人重挂、回放永久灰色。
        # ⚠️ factory() 正常返回（如 stop 信号触发的有序退出）必须结束任务，
        # 不能掉进循环重启——否则 cancel 后任务变成永不停歇的空转循环，
        # TestClient/lifespan shutdown 的 await t 会永久挂住（2026-09-18
        # 定位：supervisor 任务 cancel 后 wait_for 抛 TimeoutError 被吞，
        # factory 正常返回又被 supervised 重启，全量测试因此挂死）。
        async def supervised(name: str, factory):
            while True:
                try:
                    await factory()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001
                    log.exception("后台任务 %s 异常退出，3s 后自动重启", name)
                    await asyncio.sleep(3)
                    continue
                # 正常返回（有序停止）：结束监督，不再拉起
                log.info("后台任务 %s 已正常停止", name)
                return

        # 授权信号后台轮询线程（开关关时为 None）；先启动，supervisor 首个
        # tick 才有机会等到 valid（启动门由 supervisor 的 license_gate 裁决）
        if license_client is not None:
            license_client.start()

        loop_specs = [
            ("catalog", catalog_loop),
            ("scanner", scanner.run_forever),
            ("sei-index", sei_indexer.run_forever),
            ("supervisor", supervisor.run_forever),
            ("storage-watch", storage_watchdog_loop),
            ("quota", quota_loop),
            ("write-diagnostics", lambda: monitor_writes(supervisor, index)),
            ("license-interlock", license_guard.interlock_loop),
        ]
        tasks = [
            asyncio.create_task(supervised(name, factory), name=name)
            for name, factory in loop_specs
        ]
        if config_center is not None:
            config_center.start()
        yield
        if config_center is not None:
            config_center.stop()
        if license_client is not None:
            license_client.stop()
        await supervisor.shutdown()
        await stop_background_tasks(tasks)
        storage_mgr.shutdown()
        await asyncio.to_thread(index.close)

    app = FastAPI(title="ainvr-recorder", version=__version__, lifespan=lifespan)
    app.state.config_store = store
    app.state.index = index
    app.state.storage = storage_mgr
    app.state.channels = channels
    app.state.supervisor = supervisor

    # ---------- 控制面 ----------

    @app.get("/v1/recorder/health")
    async def health(_: None = Depends(require_console_or_local_probe)):
        st = storage_mgr.current_status()
        snap = storage_mgr.io.snapshot()
        write = supervisor.write_summary()
        warnings = [w for w in (st.warning, _write_warning(write)) if w]
        return {
            "ok": True,
            "version": __version__,
            "storageHealthy": st.healthy and not st.quota_stopped and not st.space_low,
            "storageKind": st.kind,
            "message": st.message or None,
            # 非致命告警：NAS 回收站占空间、存储写入速度不足按 GOP 丢弃等
            "warning": "；".join(warnings) or None,
            **write,
            "indexIO": index.io_snapshot(),
            "maintenanceIO": storage_mgr.maintenance_io.snapshot(),
            # 熔断诊断：存储卡死时告诉前端/运维卡在哪个操作、卡了多久
            "blockedOp": snap["blockedOp"],
            "stuckSeconds": snap["stuckSeconds"],
            # 授权相位（未接线时为 null；valid 才允许录像）
            "licensePhase": license_guard.licensed()[1] or None,
        }

    @app.get("/v1/recorder/stats")
    async def stats(_: None = Depends(require_console_token)):
        day_ms = int(datetime.now().replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        today_ms, today_bytes = (await index.run(index.today_aggregate, day_ms))
        status = storage_mgr.current_status()
        # 容量只读取探活刷新的缓存——本端点绝不能直连 statvfs（卡死 NAS 上
        # 会把整个 HTTP 工作线程 D 住）。缓存缺失时容量字段返回 0 并显式
        # capacityKnown=False，由前端提示"恢复中"。
        cap = storage_mgr.capacity_cached()
        pool_total, pool_avail = cap if cap is not None else (0, 0)
        try:
            pool_used = (await index.run(index.used_bytes, status.kind))
        except Exception:  # noqa: BLE001
            pool_used = 0
        recording_count = sum(supervisor.recording_status(c["id"])["recording"]
                              for c in channels.channels)
        return {
            "todayDurationMs": today_ms,
            "todayBytes": today_bytes,
            "poolUsedBytes": pool_used,
            "poolTotalBytes": pool_total,
            "poolAvailableBytes": pool_avail,
            "poolKind": status.kind,
            "capacityKnown": cap is not None,
            "overwrittenSegments": (await index.run(index.meta_get, "overwrittenSegments")),
            "recordingChannels": recording_count,
            "storageHealthy": status.healthy and not status.quota_stopped and not status.space_low,
            **supervisor.write_summary(),
        }

    @app.get("/v1/recorder/channels")
    async def list_channels(_: None = Depends(require_console_token)):
        return [{**channel, **supervisor.recording_status(channel["id"])}
                for channel in channels.to_api()]

    @app.get("/v1/recorder/config")
    async def get_config(_: None = Depends(require_console_token)):
        return config_public(store.get().recording)

    @app.put("/v1/recorder/config")
    async def save_config(body: SaveConfigBody,
                          _: None = Depends(require_console_token)):
        # 写入口已收敛到统一配置中心（BFF 把旧 PUT 转为配置中心文档更新，
        # 发布后由本服务轮询应用）。本地不再接受直接写，避免双源：
        # 配置中心下一轮拉取会把本地直接改的值覆盖掉，造成"看似保存成功
        # 实际被回滚"的静默失效。
        raise HTTPException(
            status_code=409,
            detail="配置修改请通过统一配置中心（Web 控制台 → 配置中心）修改并发布",
        )

    @app.post("/v1/recorder/storage/test")
    async def test_storage(body: StorageInput,
                           _: None = Depends(require_console_token)):
        # The old "test" actually changed the live mount outside configuration
        # ownership. Validation now belongs to the serialized save/apply path.
        raise HTTPException(status_code=409, detail="请在系统配置中保存，保存时会自动验证存储并应用")

    # ---------- 查询/媒体 ----------

    @app.get("/v1/recordings/drops")
    async def list_drops(
        channel: str = Query(...),
        start: int = Query(..., alias="from"),
        to: int = Query(...),
        _: None = Depends(require_console_token),
    ):
        """存储写入不足时按完整 GOP 丢弃的区间（时间轴琥珀色块）。"""
        return (await index.run(index.drop_events, channel, start, to))

    from .evidence_recovery import EvidenceRecovery, validate_request
    recovery = EvidenceRecovery()

    @app.post("/v1/recordings/recover-evidence")
    async def recover_evidence(body: dict, _: None = Depends(require_console_token)):
        if not license_guard.licensed()[0]:
            raise HTTPException(403, 'LICENSE_REQUIRED')
        try:
            at = validate_request(body)
        except (ValueError, TypeError, OverflowError):
            raise HTTPException(422, 'invalid_evidence_request') from None
        # Only current storage and completed segments; the SEI identity selects the AI output.
        output_id = channels.recording_channel_for_processor(body['channel_id'])
        candidates = await index.run(lambda: [dict(r) for r in index.conn.execute(
            "SELECT id,channel_id,width,height FROM active_segments WHERE complete=1 AND COALESCE(sei_reason,'') <> 'source' AND (? IS NULL OR channel_id=?) AND width=? AND height=? AND start_ts < ? AND end_ts > ? ORDER BY start_ts DESC LIMIT 9",
            (output_id, output_id, body['width'], body['height'], at + 120000, at - 120000)).fetchall()])
        if len(candidates) > 8:
            raise HTTPException(503, 'recovery_search_capacity')
        from contextlib import ExitStack
        generation = storage_mgr.io.generation
        with ExitStack() as readers:
            segments = []
            for candidate in candidates:
                if channels.confirmed_kind(candidate['channel_id']) == 'source':
                    continue
                readers.enter_context(playback_protection.reader(candidate['id']))
                seg, path = await resolve_segment_file(candidate['id'], index, storage_mgr, playback_protection)
                segments.append({**candidate, 'path': path})
            result = await recovery.recover(body, segments)
            if generation != storage_mgr.io.generation:
                raise HTTPException(409, 'storage_changed')
            return result

    @app.get("/v1/recordings/segments")
    async def list_segments(
        response: Response,
        channel: str = Query(...),
        start: int | None = Query(default=None, alias="from"),
        to: int | None = Query(default=None),
        _: None = Depends(require_console_token),
    ):
        now_ms = int(time.time() * 1000)
        response.headers['Cache-Control'] = 'no-store'
        start = start or 0
        to = to or now_ms
        rows = (await index.run(index.query, channel, start, to))
        status = storage_mgr.current_status()
        return [segment_public(r, playable=status.healthy and r["storage"] == status.kind)
                for r in rows]

    async def require_licensed_media(_: None = Depends(require_media_token)):
        if not license_guard.licensed()[0]:
            raise HTTPException(status_code=403, detail="LICENSE_REQUIRED")

    @app.get("/v1/recordings/{seg_id}/sei")
    async def recording_sei(seg_id: str, response: Response,
                            from_ms: int = Query(default=0, ge=0, le=86400000),
                            _: None = Depends(require_licensed_media)):
        response.headers['Cache-Control'] = 'no-store'
        start = (from_ms // 10000) * 10000
        generation = storage_mgr.io.generation
        with playback_protection.reader(seg_id):
            seg, path = await resolve_segment_file(seg_id, index, storage_mgr, playback_protection)
            frames = await playback_sei.read(path, (seg_id, generation, path), start)
            if generation != storage_mgr.io.generation:
                raise HTTPException(409, '存储已切换，请重新打开录像')
            if not license_guard.licensed()[0]:
                raise HTTPException(403, 'LICENSE_REQUIRED')
        return {'fromMs': start, 'toMs': start + 10000, 'frames': frames}

    @app.get("/v1/recordings/{seg_id}/availability")
    async def availability(seg_id: str, response: Response,
                           _: None = Depends(require_licensed_media)):
        response.headers['Cache-Control'] = 'no-store'
        await resolve_segment_file(seg_id, index, storage_mgr, playback_protection)
        return {"available": True}

    @app.get("/v1/recordings/{seg_id}/play")
    async def play(seg_id: str,
                   _: None = Depends(require_licensed_media)):
        # Actual reads run in bounded disposable processes, not shared threads.
        if media_sem.locked():
            raise HTTPException(
                status_code=503, detail="录像播放并发已满，请稍后再试")
        async with media_sem:
            seg, abs_path = await resolve_segment_file(
                seg_id, index, storage_mgr, playback_protection)
            return LimitedFileResponse(
                abs_path, semaphore=media_sem, media_type="video/mp4",
                license_check=lambda: license_guard.licensed()[0],
                protection=playback_protection, segment_id=seg_id,
                storage=storage_mgr, index=index,
                headers={
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "no-store",
                    "X-Segment-Id": seg["id"],
                },
            )

    @app.get("/v1/recordings/{seg_id}/download")
    async def download(seg_id: str,
                       _: None = Depends(require_licensed_media)):
        if media_sem.locked():
            raise HTTPException(
                status_code=503, detail="录像下载并发已满，请稍后再试")
        async with media_sem:
            seg, abs_path = await resolve_segment_file(
                seg_id, index, storage_mgr, playback_protection)
            fname = os.path.basename(abs_path)
            return LimitedFileResponse(
                abs_path, semaphore=media_sem, media_type="video/mp4", filename=fname,
                license_check=lambda: license_guard.licensed()[0],
                protection=playback_protection, segment_id=seg_id,
                storage=storage_mgr, index=index,
                headers={"Accept-Ranges": "bytes"},
            )

    return app
