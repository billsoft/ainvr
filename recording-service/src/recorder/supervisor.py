"""每通道监督器：配置开关 × 流在线 × 存储健康 → 录像管线生命周期。

状态机（对前端 health 暴露）：
  disabled      未勾选录制
  waiting_source 已勾选但流不在线（含 backoff）
  recording     管线在跑（写入状态另见 write_status：ok / degraded / stalled）
  storage_error NAS/存储故障，全部停止（绝不降级本机）
  license_error 授权未生效/失效，全部停止，恢复 valid 后自动续录
  codec_error   H.265 通道缺少读端组件（FFmpeg 8.1.2），不启动
  stopped       整体停止
重启 backoff：2→4→8→16→30s 封顶；连续 5 次失败才记 error 指标。
跨天：分段与日目录由管线按内容时间决定，不重启任何进程。
"""
from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

from . import ffmpeg_recorder
from .channels import ChannelManager
from .config import ConfigStore
from .index import SegmentIndex
from .logging_setup import get_logger
from .recording_pipeline import RecordingPipeline
from .storage import StorageError, StorageManager
from .storage_io import StorageIOError

log = get_logger("recorder.supervisor")

MAX_BACKOFF = 30
BACKOFF_STEPS = (2, 4, 8, 16, 30)
# 管线持续运行这么久才算恢复正常、失败计数清零；拉起后很快又失败的按次数逐级退避
STABLE_RUN_SEC = 60
FAIL_LIMIT = 5
# 每路内存 GOP 缓冲：全局预算按在录通道均分，单路封顶/保底。4K≈21Mbps 时
# 100Mbps 时 384MiB 软阈值约容纳 30s；实际内存按需使用，全局仍封顶 1.5GiB。
GLOBAL_BUFFER_BYTES = 1536 << 20
CHANNEL_BUFFER_MAX = 512 << 20
CHANNEL_BUFFER_MIN = 32 << 20
SOFT_CAP_RATIO = 0.75
HOUR_MS = 3_600_000
# H.265 超过这么久没见 IDR：闸门无法开新文件，报 no_idr（设计 §2）
NO_IDR_WARN_SEC = 10.0
KNOWN_CODECS = ("h264", "h265")
# 源已在线但 SRS 还没报出编码（刚开始推流、视频信息尚未解析）时最多等这么久再按默认读端
# 兜底：等是为了不按 264 猜着拉起（实际是 265 就要白录一段再杀掉重启）；有上限是为了
# SRS 接口不可达时也绝不无限停录。
CODEC_WAIT_SEC = 15
RECONNECT_DRAIN_SEC = 45.0
# 读端零输出：独立采样确认源帧数仍在增长，读端却这么久
# 没解析出任何画面单元 → 读端卡死（如会话中途 FLV 解析错位，进程存活但零输出）。
# 推流会话不变不会触发"源重新推流"，写入卡死只看待写数据，都兜不住这种情况。
READER_IDLE_SEC = 20.0


@dataclass
class RetiringPipeline:
    pipeline: RecordingPipeline
    task: asyncio.Task
    reason: str


@dataclass
class ChannelState:
    channel_id: str
    state: str = "disabled"
    detail: str = ""
    proc: RecordingPipeline | None = None
    failures: int = 0
    next_attempt_ts: float = 0.0
    last_start_ts: float = 0.0
    last_exit_code: int | None = None
    started_at: float = 0.0
    # 本次在线、编码仍未知的起始时刻（None = 未在等）；源掉线即清零
    codec_wait_since: float | None = None
    codec_fallback_logged: bool = False
    # 读端连上的推流会话（None = 起录时未知，首次得知只补记）
    publisher_id: str | None = None


class Supervisor:
    def __init__(self, store: ConfigStore, channels: ChannelManager,
                 storage_mgr: StorageManager, index: SegmentIndex,
                 license_gate: Callable[[], tuple[bool, str]] | None = None):
        self.store = store
        self.channels = channels
        self.storage = storage_mgr
        self.index = index
        # 授权门：() → (是否允许录像, 相位)。None = 未接线（默认），恒允许。
        # 门控同步只读客户端内存，绝不在 tick 关键路径上等网络。
        self._license_gate = license_gate
        self.states: dict[str, ChannelState] = {}
        # SIGKILL 后仍有进程未退出（D 状态，读端或任一写端）的管线：只观察
        # exited 收尸，不再发信号、不再 await，并阻止同通道重启（spawn 围栏，防双写）。
        self.orphans: dict[str, RecordingPipeline] = {}
        self.retiring: dict[str, RetiringPipeline] = {}
        self._stop_evt = asyncio.Event()
        self._tick_lock = asyncio.Lock()

    @asynccontextmanager
    async def configuration_change(self, stop_recorders: bool = False):
        """Serialize storage changes/recovery with ffmpeg creation and shutdown."""
        async with self._tick_lock:
            if stop_recorders:
                await asyncio.gather(*(self._stop(st, "存储或分段配置更新")
                                       for st in [self.state_of(cid) for cid in
                                                  set(self.states) | set(self.retiring)]))
            yield

    def state_of(self, channel_id: str) -> ChannelState:
        return self.states.setdefault(channel_id, ChannelState(channel_id))

    def recording_status(self, channel_id: str) -> dict:
        """One runtime truth for channel badges and aggregate recording counts."""
        st = self.states.get(channel_id)
        status = self.storage.current_status()
        if not self._wanted(self.store.get(), channel_id):
            state, detail = "disabled", "未启用录像或当前不在录像计划内"
        elif not status.healthy or status.quota_stopped or status.space_low:
            state, detail = "storage_error", status.message or "存储不可用或配额已停录"
        elif st and st.state == "recording" and st.proc and st.proc.returncode is None:
            state, detail = "recording", "正在录制"
        elif st and st.state != "recording":
            state, detail = st.state, st.detail or "等待录制启动"
        else:
            state, detail = "waiting_source", "等待源流或录制进程恢复"
        result = {"recording": state == "recording", "recordingState": state,
                  "recordingDetail": detail}
        result.update(self.write_status(channel_id))
        result["drainingPrevious"] = channel_id in self.retiring
        warning = None
        if state == "recording" and result.get("codec") == "h265":
            if result.get("noIdrSec", 0) > NO_IDR_WARN_SEC:
                warning = "no_idr"
            elif result.get("openGopAus", 0) > 0:
                warning = "open_gop"
        result["codecWarning"] = warning
        if warning == "no_idr":
            result["recordingDetail"] = (
                f"H.265 源已 {int(result['noIdrSec'])} 秒没有 IDR 关键帧，无法开始新录像文件，"
                "请把相机设为闭合 GOP、周期 IDR")
        elif state == "recording" and result["writeState"] == "degraded":
            result["recordingDetail"] = (
                ("正在录制，当前写入积压；" if result["writeBacklogActive"] else "正在录制，当前无写入积压；") +
                f"近 1 小时有未保存录像约 "
                f"{round(result['droppedMsLastHour'] / 1000)} 秒")
        elif warning == "open_gop":
            result["recordingDetail"] = "正在录制（H.265 源为开放 GOP，只在 IDR 处分段，建议相机设为闭合 GOP）"
        if state == "recording" and result.get("waitingPreviousWriter"):
            result["recordingDetail"] = "已接入新视频，正在缓冲并等待上一段录像保存完成"
        return result

    def write_status(self, channel_id: str, dropped: dict[str, int] | None = None,
                     now_ms: int | None = None) -> dict:
        """写入状态：ok / degraded（写得慢，按 GOP 丢弃中或近 1 小时丢过）/ stalled。"""
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        if dropped is None:
            dropped = self.index.recent_drops(now_ms - HOUR_MS)
        st = self.states.get(channel_id)
        p = st.proc if st else None
        stats = p.stats() if p is not None and p.returncode is None else {}
        ms = dropped.get(channel_id, 0)
        if stats.get("dropping") and stats.get("dropStartTs"):
            ms += max(0, now_ms - stats["dropStartTs"])  # 进行中的丢弃段
        if stats.get("stalled"):
            state = "stalled"
        elif stats.get("dropping") or stats.get("waitingPreviousWriter") or ms > 0:
            state = "degraded"
        else:
            state = "ok"
        return {"writeState": state, "droppedMsLastHour": ms,
                "writeBacklogActive": bool(stats.get("dropping") or stats.get("stalled") or
                                           stats.get("waitingPreviousWriter")),
                "waitingPreviousWriter": bool(stats.get("waitingPreviousWriter")),
                "bufferSec": stats.get("bufferSec", 0.0),
                "codec": stats.get("codec"),
                "noIdrSec": stats.get("noIdrSec", 0.0),
                "openGopAus": stats.get("openGopAus", 0)}

    def write_summary(self) -> dict:
        now_ms = int(time.time() * 1000)
        dropped = self.index.recent_drops(now_ms - HOUR_MS)
        ids = {ch["id"] for ch in self.channels.channels} | set(dropped)
        rows = {cid: self.write_status(cid, dropped, now_ms) for cid in ids}
        return {
            "droppedMsLastHour": sum(r["droppedMsLastHour"] for r in rows.values()),
            "writeDegradedChannels": sum(1 for r in rows.values() if r["writeState"] != "ok"),
        }

    def _record_drop(self, event: dict) -> None:
        self.index.record_drop(event)

    def _buffer_caps(self, cfg, channel_id=None) -> tuple[int, int]:
        budget = max(0, GLOBAL_BUFFER_BYTES - self._retiring_bytes())
        wanted = [ch for ch in self.channels.channels if self._wanted(cfg, ch["id"])]
        if channel_id is None or not wanted:
            cap = min(CHANNEL_BUFFER_MAX, budget // max(1, len(wanted)))
            return int(cap * SOFT_CAP_RATIO), cap
        # Distribute the remaining budget by measured ingress, with a floor
        # for new streams and a cap per channel. Redistribute capped shares.
        caps = {ch['id']: min(CHANNEL_BUFFER_MIN, budget // len(wanted)) for ch in wanted}
        weights = {ch['id']: max(1000, float(ch.get('recvKbps') or 20000)) for ch in wanted}
        remaining = budget - sum(caps.values())
        active = set(caps)
        while remaining > 0 and active:
            total = sum(weights[cid] for cid in active)
            allocated = 0
            for cid in sorted(active):
                take = min(CHANNEL_BUFFER_MAX - caps[cid], int(remaining * weights[cid] / total))
                caps[cid] += take
                allocated += take
            remaining -= allocated
            active = {cid for cid in active if caps[cid] < CHANNEL_BUFFER_MAX}
            if allocated == 0:
                break
        cap = caps.get(channel_id, CHANNEL_BUFFER_MIN)
        return int(cap * SOFT_CAP_RATIO), cap

    def _retiring_bytes(self) -> int:
        reserved = 0
        for pipeline in [r.pipeline for r in self.retiring.values()] + list(self.orphans.values()):
            gate = getattr(pipeline, 'gate', None)
            if gate is not None:
                reserved += max(gate.hard_cap, gate.queued_bytes)
        return reserved

    def _buffer_available(self, requested: int) -> bool:
        if requested <= 0:
            return False
        reserved = self._retiring_bytes()
        for state in self.states.values():
            gate = getattr(state.proc, 'gate', None)
            if gate is not None:
                reserved += max(gate.hard_cap, gate.queued_bytes)
        return reserved + requested <= GLOBAL_BUFFER_BYTES

    def _wanted(self, cfg, channel_id: str, now_hour: int | None = None) -> bool:
        """该通道当前是否应该在录：channelSchedules（唯一规范）优先，
        缺失时回退旧 enabled_channel_ids（只读兼容）。计划判定用本地
        时区当前小时——supervisor 每 3s tick 自然覆盖跨小时边界。"""
        schedule = cfg.channel_schedules.get(channel_id)
        if schedule is not None:
            hour = datetime.now().hour if now_hour is None else now_hour
            return schedule.is_recording_at(hour)
        return channel_id in set(cfg.enabled_channel_ids)

    async def _spawn(self, ch: dict, st: ChannelState, root: str, segment_seconds: int,
                     caps: tuple[int, int]) -> None:
        if self._license_gate is not None and not self._license_gate()[0]:
            st.state = "license_error"
            return
        # 日目录创建与写端启动都在管线内按分段进行（建目录经熔断执行器）
        pipeline = RecordingPipeline(
            channel_id=ch["id"], rtmp_url=ch["rtmpUrl"], root=root,
            segment_seconds=segment_seconds, io=self.storage.io,
            soft_cap=caps[0], hard_cap=caps[1], on_event=self._record_drop,
            codec=ch.get("codec"),
            writer_ready=(lambda old=self.retiring[ch['id']].pipeline: old.exited)
                         if ch['id'] in self.retiring else None)
        await pipeline.start()
        st.proc = pipeline
        st.publisher_id = ch.get("publisherId")
        if self._license_gate is not None and not self._license_gate()[0]:
            await self._stop(st, "授权租约已失效")
            st.state = "license_error"
            return
        st.state = "recording"
        st.detail = ""
        st.started_at = time.time()
        st.last_start_ts = st.started_at
        log.info("开始录制 %s (%s) pid=%s → %s（GOP 缓冲 %dMB）", ch["name"], ch["streamName"],
                 pipeline.pid, root, caps[1] >> 20)

    async def _stop(self, st: ChannelState, reason: str, *, wait: bool = True,
                    drain_seconds: float = 5.0) -> None:
        """Keep at most one retiring generation; tick never waits for disk drain."""
        previous = self.retiring.get(st.channel_id)
        if previous is not None:
            if st.proc is not None and hasattr(st.proc, 'stop_input'):
                st.proc.stop_input()
            if wait:
                if hasattr(previous.pipeline, 'expedite_stop'):
                    previous.pipeline.expedite_stop()
                await asyncio.shield(previous.task)
                self._reap_retiring()
            else:
                # Repeated republishes cannot create an unbounded drain chain.
                return
        if st.proc is not None:
            log.info("停止录制 %s：%s", st.channel_id, reason)
            pipeline = st.proc
            if hasattr(pipeline, 'stop_input'):
                pipeline.stop_input()
            st.proc = None
            task = asyncio.create_task(pipeline.stop(term_timeout=drain_seconds))
            self.retiring[st.channel_id] = RetiringPipeline(pipeline, task, reason)
            if wait:
                await asyncio.shield(task)
                self._reap_retiring()
        if st.state == "recording":
            st.state = "disabled"
            st.detail = reason

    def _reap_retiring(self) -> None:
        for cid, retired in list(self.retiring.items()):
            if not retired.task.done():
                continue
            try:
                gone = retired.task.result()
            except Exception:
                log.exception('recording_drain_failed channel=%s reason=%s', cid, retired.reason)
                gone = retired.pipeline.exited
            if not gone:
                # Preserve every orphan even if a successor reader also gets stuck.
                self._add_orphan(cid, retired.pipeline)
            log.info('recording_drain_complete channel=%s exited=%s reason=%s',
                     cid, gone, retired.reason)
            del self.retiring[cid]

    def _add_orphan(self, cid: str, pipeline: RecordingPipeline) -> None:
        """同一通道可能先后卡死多代管线：每代都要留在围栏里，不能互相覆盖。"""
        key = cid if cid not in self.orphans else f'{cid}#{id(pipeline)}'
        self.orphans[key] = pipeline

    def _reap_orphans(self) -> None:
        """回收已真正退出的 orphan（asyncio child watcher 自动 waitpid，
        returncode 一旦被设置即说明僵尸已收）。纯内存检查，不阻塞。"""
        for cid in list(self.orphans.keys()):
            rp = self.orphans[cid]
            if rp.exited:
                log.info("orphan 录像管线 pid=%s（通道 %s）已全部退出并回收", rp.pid, cid)
                del self.orphans[cid]

    async def run_forever(self) -> None:
        while not self._stop_evt.is_set():
            try:
                await self._tick()
            except Exception as e:  # noqa: BLE001
                log.exception("监督轮异常：%s", e)
            try:
                await asyncio.wait_for(self._stop_evt.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass

    def stop_all(self) -> None:
        self._stop_evt.set()

    async def shutdown(self) -> None:
        self.stop_all()
        for retired in self.retiring.values():
            if hasattr(retired.pipeline, 'expedite_stop'):
                retired.pipeline.expedite_stop()

        # 各通道并行停止；交接中的通道至多收尾两代管线，不能先丢掉后继的所有权。
        # 每代都有有界排空/终止等待；杀不掉的 D 状态进程由 cgroup 统一收尾。
        ids = set(self.states) | set(self.retiring)
        await asyncio.gather(*(self._stop(self.state_of(cid), "服务关闭", drain_seconds=2)
                               for cid in ids))

    async def _tick(self) -> None:
        async with self._tick_lock:
            await self._tick_unlocked()
            # Start scheduled stops without serially waiting for their completion.
            await asyncio.sleep(0)
            self._reap_retiring()

    async def _tick_unlocked(self) -> None:
        cfg = self.store.get()
        segment_seconds = cfg.recording.files.segmentSeconds

        self._reap_orphans()
        self._reap_retiring()

        active_ids = {ch["id"] for ch in self.channels.channels}
        for cid, st in list(self.states.items()):
            if cid not in active_ids:
                await self._stop(st, "通道已删除", wait=False)
                # During handover _stop may only stop successor input while the
                # predecessor drains. Keep ownership until both are retired.
                if st.proc is None:
                    del self.states[cid]

        # 授权大前提（设计 §16）：非 valid 相位不启动任何新录像；在录管线走
        # 既有有界 _stop 收尾（fMP4 正常封段）。恢复 valid 后本 tick 自然续录。
        if self._license_gate is not None:
            allowed, phase = self._license_gate()
            if not allowed:
                phase_text = {"starting": "等待授权服务", "invalid": "设备未授权",
                              "dormant": "授权信号中断"}.get(phase, "设备未授权")
                for ch in self.channels.channels:
                    st = self.state_of(ch["id"])
                    if st.proc is not None or st.state != "license_error":
                        await self._stop(st, f"{phase_text}（{phase}），暂停录像", wait=False)
                    if self._wanted(cfg, ch["id"]):
                        st.state = "license_error"
                        st.detail = f"{phase_text}，授权恢复后自动续录"
                return

        # 存储大前提：不健康、配额停录或卷空间不足 → storage_error，全停（不降级本机）
        status = self.storage.current_status()
        storage_ok = status.healthy and not status.quota_stopped and not status.space_low
        if not storage_ok:
            reason = status.message or "存储不可用"
            for ch in self.channels.channels:
                st = self.state_of(ch["id"])
                await self._stop(st, "storage", wait=False)
                if self._wanted(cfg, ch["id"]):
                    st.state = "storage_error"
                    st.detail = reason
                else:
                    st.state = "disabled"
                    st.detail = "当前计划未启用"
            return

        root = status.root
        now = time.time()
        # Rebalance existing pipelines too: adding channels must not leave older
        # channels reserving the former, larger per-channel share indefinitely.
        for cid, existing in self.states.items():
            gate = getattr(existing.proc, 'gate', None)
            if gate is not None:
                caps = self._buffer_caps(cfg, cid)
                gate.soft_cap, gate.hard_cap = caps
                gate.low = int(caps[0] * 0.5)

        for ch in self.channels.channels:
            caps = self._buffer_caps(cfg, ch['id'])
            st = self.state_of(ch["id"])
            wanted = self._wanted(cfg, ch["id"])

            if not wanted:
                if st.state != "disabled" or st.proc is not None:
                    await self._stop(st, "通道未勾选或当前时段不在录像计划内", wait=False)
                    st.state = "disabled"
                continue

            # 在录：检查存活、编码变化、写入卡死
            if st.proc is not None:
                codec = ch.get("codec")
                running = getattr(st.proc, "codec", codec)
                if codec in KNOWN_CODECS and running is None and                         ffmpeg_recorder.reader_binary(codec) == ffmpeg_recorder.reader_binary(None):
                    # 启动时编码尚未拿到、用了默认读端，现在得知就是默认读端能读的编码（h264）：
                    # 读端本来就对，只补记编码，不重启（否则每次服务重启都白断录 1~2 秒）
                    st.proc.codec = codec
                elif codec in KNOWN_CODECS and running != codec:
                    # 相机换了编码并重推（或起步未知、实际是 265）：旧读端（如 4.4 读 265）
                    # 不会退出而是静默出无视频的流，必须主动停掉，下一轮按新编码拉起、
                    # 不走退避（设计 §5.2 E2）
                    await self._stop(st, "源编码变化", wait=False, drain_seconds=RECONNECT_DRAIN_SEC)
                    st.state = "waiting_source"
                    st.detail = f"源编码变化（{running or '未知'} → {codec}），正在按新编码重启录制"
                    st.next_attempt_ts = 0.0
                    log.info("通道 %s 源编码变化 %s → %s，重启录制", ch["name"], running, codec)
                    continue
                # 相机断开重推（如 8K 改 4K）：流媒体服务不断开已连着的读端，读端会
                # 一直沿用首次连上时的参数集插在每个关键帧前，新画面配旧参数集，录像
                # 全部黑屏。推流会话一换就重启读端，按新序列头录。
                publisher = ch.get("publisherId")
                if publisher is not None:
                    if st.publisher_id is None:
                        st.publisher_id = publisher
                    elif publisher != st.publisher_id:
                        await self._stop(st, "源重新推流", wait=False, drain_seconds=RECONNECT_DRAIN_SEC)
                        st.state = "waiting_source"
                        st.detail = "源重新推流，正在按新的视频参数重启录制"
                        st.next_attempt_ts = 0.0
                        log.info("通道 %s 源重新推流（会话 %s → %s），重启录制",
                                 ch["name"], st.publisher_id, publisher)
                        continue
                rc = st.proc.returncode
                if rc is not None:
                    # 管线结束（源断开 / 写入报错）：按退避重启；仍有进程卡在
                    # D 状态则转 orphan，spawn 围栏防双写
                    ended, st.proc = st.proc, None
                    if not ended.exited:
                        self._add_orphan(ch["id"], ended)
                    st.last_exit_code = rc
                    if getattr(ended, "input_stopped", False):
                        # 交接期间再次重推/停用时只停了后继的输入，它把积压写完后
                        # 结束是预期行为：不计失败、不退避，下一轮按当前状态重新拉起
                        st.state = "waiting_source"
                        st.detail = "上一段录制已按要求结束，正在重新拉起"
                        st.next_attempt_ts = 0.0
                        log.info("录制管线按要求结束 %s（code=%s）", ch["name"], rc)
                        continue
                    st.failures += 1
                    if st.failures >= FAIL_LIMIT:
                        (await self.index.run(self.index.meta_incr, "errorSegments"))
                    backoff = BACKOFF_STEPS[min(st.failures - 1, len(BACKOFF_STEPS) - 1)]
                    st.next_attempt_ts = now + backoff
                    st.state = "waiting_source"
                    reason = ended.error or f"录制进程退出 code={rc}"
                    st.detail = f"{reason}，{backoff}s 后重试"
                    log.warning("录制管线结束 %s：%s（第 %d 次）", ch["name"], reason, st.failures)
                    continue
                if st.failures and now - st.started_at >= STABLE_RUN_SEC:
                    st.failures = 0
                idle = getattr(st.proc, "input_idle_seconds", None)
                idle_sec = idle() if idle is not None else 0.0
                source_progress = self.channels.reader_watchdog_source(ch) if idle_sec >= READER_IDLE_SEC else None
                if source_progress is not None:
                    # 计失败、逐级退避：读端每次拉起都很快卡死时不会空转重启；
                    # 积压照常在后台交给写端写完
                    await self._stop(st, "读流长时间无画面", wait=False,
                                     drain_seconds=RECONNECT_DRAIN_SEC)
                    st.failures += 1
                    backoff = BACKOFF_STEPS[min(st.failures - 1, len(BACKOFF_STEPS) - 1)]
                    st.next_attempt_ts = now + backoff
                    st.state = "waiting_source"
                    st.detail = f"读流 {idle_sec:.0f}s 未取得画面而源仍在推流，{backoff}s 后重启录制"
                    log.warning("recording_reader_idle channel=%s name=%s idle_sec=%.1f "
                                "failures=%d backoff=%ds source=%s", ch["id"], ch["name"], idle_sec,
                                st.failures, backoff, source_progress)
                    continue
                # 写入卡死：有数据待写但字节级长时间无进展（与 I 帧间隔、分段
                # 时长无关）。写得慢不在此列——那是按 GOP 丢弃的降级态。
                if st.proc.stalled():
                    log.error("通道 %s 录像写入卡死：长时间无任何写入进展，"
                              "判定存储卡死并触发熔断重挂", ch["name"])
                    self.storage.trip(
                        "record-write-stall",
                        f"通道 {ch['name']} 录像写入长时间无进展，存储类型={self.storage.status.kind}")
                    await self._stop(st, "录制写入卡死（存储卡死）", wait=False)
                    st.state = "storage_error"
                    st.detail = "录像写入长时间无进展，疑似存储卡死，等待重挂恢复"
                continue

            # 未在录：判定能否拉起
            #
            # spawn 围栏：该通道上一个 ffmpeg 仍在 orphan 集合（SIGKILL
            # 未带走的 D 状态进程）时绝不拉起新进程——否则 lazy umount 后
            # 旧进程还握着旧 SMB 会话写同名分段，两个写者会写坏文件。
            orphan = next((p for key, p in self.orphans.items()
                           if key.split('#', 1)[0] == ch['id'] and not p.exited), None)
            if orphan is not None and not orphan.exited:
                st.state = "storage_error"
                st.detail = (f"旧录制进程 pid={orphan.pid} 卡死未退出，"
                             "暂停重启以防双写，等待其被内核回收")
                continue
            if not ch.get("online"):
                st.state = "waiting_source"
                st.detail = "源流不在线"
                st.codec_wait_since = None
                st.codec_fallback_logged = False
                continue
            if ch.get("codec") not in KNOWN_CODECS:
                if st.codec_wait_since is None:
                    st.codec_wait_since = now
                if now - st.codec_wait_since < CODEC_WAIT_SEC:
                    st.state = "waiting_source"
                    st.detail = "源已上线，正在识别视频编码"
                    continue
                if not st.codec_fallback_logged:
                    st.codec_fallback_logged = True  # 同一次在线内只告警一次
                    log.warning("通道 %s 上线 %ds 仍拿不到视频编码，按默认读端录制（若实为 H.265 会自动换读端重启）",
                                ch["name"], CODEC_WAIT_SEC)
            else:
                st.codec_wait_since = None
                st.codec_fallback_logged = False
            if now < st.next_attempt_ts:
                st.state = "waiting_source"
                st.detail = f"退避中（{int(st.next_attempt_ts - now) + 1}s）"
                continue
            if ch.get("codec") == "h265" and not os.access(ffmpeg_recorder.FFMPEG8, os.X_OK):
                # 界面文字不暴露组件名与路径（路径进日志，只在首次进入该状态时记一次）；
                # 给出可执行的补装命令
                if st.state != "codec_error":
                    log.error("通道 %s 是 H.265，但读端组件缺失：%s", ch["name"], ffmpeg_recorder.FFMPEG8)
                st.state = "codec_error"
                st.detail = ("缺少 H.265 录像组件，请在设备上执行 sudo ./install.sh --only python 补装")
                continue
            if not self._buffer_available(caps[1]):
                st.state = "waiting_source"
                st.detail = "等待录像缓冲释放后启动"
                continue
            try:
                # 拉起成功不清零失败计数：持续运行 STABLE_RUN_SEC 后才清（见在录分支）
                await self._spawn(ch, st, root, segment_seconds, caps)
            except (StorageError, StorageIOError, OSError) as e:
                st.failures += 1
                backoff = BACKOFF_STEPS[min(st.failures - 1, len(BACKOFF_STEPS) - 1)]
                st.next_attempt_ts = now + backoff
                st.state = "waiting_source"
                st.detail = f"启动失败：{e}"
                log.error("拉起录像管线失败 %s：%s", ch["name"], e)
