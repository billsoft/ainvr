"""通道目录：BFF /api/channels 为事实源，SRS /streams 补在线/编码实况。"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlsplit, unquote
from datetime import datetime

from .config import ConfigStore
from .index import SegmentIndex
from .logging_setup import get_logger
from .auth import service_token

log = get_logger("recorder.channels")

VIDEO_PROGRESS_TTL_SEC = 15.0


@dataclass(frozen=True)
class VideoProgress:
    publisher_id: object
    frames: object
    observed_at: float
    changed_at: float
    advanced_at: float | None


def _http_get_json(url: str, token: str = "", timeout: float = 5.0):
    req = urllib.request.Request(url)
    if token:
        req.add_header("X-Service-Token", token)
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (内网固定地址)
        return json.loads(resp.read().decode("utf-8"))


class ChannelManager:
    def __init__(self, store: ConfigStore, index: SegmentIndex):
        self.store = store
        self.index = index
        # 最新通道视图（对前端/监督器暴露）
        self.channels: list[dict] = []
        # streamName → SRS 实时流信息
        self.live: dict[str, dict] = {}
        self.last_bff_ok_ts: float = 0.0
        # None = AI 目录还没成功读到过：此时通道类型是"未知"，不能当"普通源"。
        # 否则 AI 输出的录像会被误判为不带识别信息（见 confirmed_kind）。
        self._ai_outputs: set[tuple[str, str]] | None = None
        self._processor_outputs: dict[str, tuple[str, str]] = {}
        self._ai_refresh_at = 0.0
        self._video_progress: dict[tuple[str, str], VideoProgress] = {}

    def get(self, channel_id: str) -> dict | None:
        return next((c for c in self.channels if c["id"] == channel_id), None)

    def recording_channel_for_processor(self, processor_id: str) -> str | None:
        target = self._processor_outputs.get(processor_id)
        matches = [c['id'] for c in self.channels if
                   (c.get('app', 'live'), c.get('streamName')) == target]
        return matches[0] if len(matches) == 1 else None

    def reader_watchdog_source(self, channel: dict) -> dict | None:
        """看门狗只用近期、同会话帧数增长的证据，不采用页面的在线缓存。"""
        progress = self._video_progress.get(
            (channel.get("app", "live"), channel.get("streamName", "")))
        if progress is None or progress.advanced_at is None:
            return None
        now = time.monotonic()
        sample_age = now - progress.observed_at
        progress_age = now - progress.advanced_at
        if not (0 <= sample_age <= VIDEO_PROGRESS_TTL_SEC and
                0 <= progress_age <= VIDEO_PROGRESS_TTL_SEC):
            return None
        return {"publisherId": progress.publisher_id, "frames": progress.frames,
                "sampleAgeSec": round(sample_age, 3),
                "progressAgeSec": round(progress_age, 3)}

    def confirmed_kind(self, channel_id: str) -> str | None:
        """'ai' / 'source'；AI 目录没读到过、或通道不存在时返回 None（未确认）。"""
        c = self.get(channel_id)
        return c["kind"] if c is not None and c.get("kindConfirmed") else None

    def _fetch_bff_channels(self) -> list[dict]:
        cfg = self.store.get()
        url = cfg.console.base_url.rstrip("/") + "/api/channels"
        token = service_token()
        if not token:
            raise RuntimeError("recorder service credential missing")
        payload = _http_get_json(url, token)
        # BFF 信封 {code,data:[...]}
        raw = payload.get("data", payload) if isinstance(payload, dict) else payload
        out = []
        for c in raw or []:
            sn = c.get("streamName")
            if not sn:
                continue
            push = (c.get("urls") or {}).get("push") or {}
            out.append({
                "id": c["id"],
                "name": c.get("name", sn),
                "streamName": sn,
                "app": c.get("app", "live"),
                "rtmpUrl": push.get("rtmp") or f"rtmp://127.0.0.1:1935/{c.get('app', 'live')}/{sn}",
                "bffOnline": bool((c.get("status") or {}).get("online")),
                "bffCodec": (c.get("status") or {}).get("videoCodec"),
            })
        return out

    def _fetch_ai_outputs(self) -> set[tuple[str, str]]:
        """Use the AI service's explicit publish targets through the BFF.

        Credentials remain in the BFF; the recorder never reads AI secrets.
        App + stream distinguishes identically named streams in different apps.
        """
        cfg = self.store.get()
        token = service_token()
        if not token:
            raise RuntimeError("recorder service credential missing")
        payload = _http_get_json(cfg.console.base_url.rstrip("/") + "/api/ai/channels", token)
        data = payload.get("data", payload) if isinstance(payload, dict) else payload
        rows = data.get("channels") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise ValueError("AI 通道目录响应格式无效")
        outputs = set()
        processor_outputs = {}
        for channel in rows:
            publish = (channel.get("config") or {}).get("publish") or {}
            target = publish.get("effective_target_url") or publish.get("target_url")
            if not target:
                continue
            parts = unquote(urlsplit(target).path).strip("/").rsplit("/", 1)
            if len(parts) == 2:
                outputs.add(tuple(parts))
                if isinstance(channel.get("id"), str):
                    processor_outputs[channel["id"]] = tuple(parts)
        self._processor_outputs = processor_outputs
        return outputs

    def _fetch_srs_streams(self) -> dict[str, dict]:
        cfg = self.store.get()
        data = _http_get_json(cfg.srs_api_url.rstrip("/") + "/api/v1/streams/")
        out = {}
        progress_snapshot = {}
        for s in data.get("streams", []):
            v = s.get("video") or {}
            pub = s.get("publish") or {}
            if not pub.get("active"):
                # 只有观看方的流（相机已停推，录像/AI 仍在尝试拉流时流媒体服务会保留它）
                # 不算在线，否则录像会反复拉起读不到数据的读端
                continue
            frames = s.get("frames")
            if isinstance(frames, (int, float)) and frames <= 0:
                continue
            if not v.get("codec"):
                continue
            key = (s.get("app", "live"), s.get("name", ""))
            prior = self._video_progress.get(key)
            now = time.monotonic()
            publisher = pub.get("cid")
            same_session = prior is not None and prior.publisher_id == publisher
            changed_at = prior.changed_at if same_session and prior.frames == frames else now
            advanced_at = None
            # 首次采样、计数回退、会话切换或采样中断都只建基线；下一次递增才确认。
            # 只接受接口规范中的整数帧计数，避免缺字段等情况误当成增长。
            if (same_session and isinstance(publisher, str) and publisher and
                    type(frames) is int and frames > 0 and type(prior.frames) is int and
                    0 <= now - prior.observed_at <= VIDEO_PROGRESS_TTL_SEC):
                if frames > prior.frames:
                    advanced_at = now
                elif frames == prior.frames:
                    advanced_at = prior.advanced_at
            progress_snapshot[key] = VideoProgress(
                publisher, frames, now, changed_at, advanced_at)
            if same_session and prior.frames == frames:
                if isinstance(frames, (int, float)) and now - changed_at > VIDEO_PROGRESS_TTL_SEC:
                    continue
            out[s.get("name")] = {
                "online": True,
                "codec": (v.get("codec") or "").lower(),
                "width": v.get("width"),
                "height": v.get("height"),
                "hasAudio": bool(s.get("audio")),
                "fps": None,
                "recvKbps": (s.get("kbps") or {}).get("recv_30s", 0),
                # 本次推流会话：相机断开重推即换新值（录像据此换读端，见 supervisor）
                "publisherId": pub.get("cid") if pub.get("active") else None,
            }
        # 整份成功采样一次发布，消失的流自动失效，不暴露半更新状态。
        self._video_progress = progress_snapshot
        return out

    async def refresh_once(self) -> None:
        # SRS 实况（5s 级，失败不致命）
        try:
            self.live = await asyncio.to_thread(self._fetch_srs_streams)
        except Exception as e:  # noqa: BLE001
            log.debug("SRS streams 获取失败：%s", e)
            self.live = {}
            self._video_progress = {}

        # BFF 目录（失败时沿用上次缓存）
        try:
            bff = await asyncio.to_thread(self._fetch_bff_channels)
            self.last_bff_ok_ts = time.time()
        except Exception as e:  # noqa: BLE001
            log.warning("BFF 通道目录同步失败，沿用缓存：%s", e)
            bff = None

        if time.monotonic() >= self._ai_refresh_at:
            self._ai_refresh_at = time.monotonic() + 30
            try:
                self._ai_outputs = await asyncio.to_thread(self._fetch_ai_outputs)
            except Exception as e:  # noqa: BLE001
                # An AI outage must not erase a previously verified mapping.
                log.warning("AI 发布目标同步失败，沿用缓存：%s", type(e).__name__)

        if bff is not None:
            merged = []
            old = {c["streamName"]: c for c in self.channels}
            for c in bff:
                live = self.live.get(c["streamName"])
                prev = old.get(c["streamName"], {})
                codec_raw = (live or {}).get("codec") or (c.get("bffCodec") or "").lower()
                codec = "h265" if codec_raw in ("hevc", "h265") else ("h264" if "264" in codec_raw else None)
                merged.append({
                    **c,
                    "kind": "ai" if (c["app"], c["streamName"]) in (self._ai_outputs or ()) else "source",
                    "kindConfirmed": self._ai_outputs is not None,
                    "online": bool(live) or c.get("bffOnline", False),
                    "codec": codec or prev.get("codec"),
                    "width": (live or {}).get("width") or prev.get("width"),
                    "height": (live or {}).get("height") or prev.get("height"),
                    "hasAudio": (live or {}).get("hasAudio") if live else prev.get("hasAudio"),
                    "fps": (live or {}).get("fps") or prev.get("fps"),
                    "recvKbps": (live or {}).get("recvKbps") or prev.get("recvKbps", 0),
                    "publisherId": (live or {}).get("publisherId"),
                })
            await self._annotate_recording_state(merged)
        else:
            await self._annotate_recording_state()

    async def _annotate_recording_state(self, candidates: list[dict] | None = None) -> None:
        # Build privately across index awaits; API/supervisor see only complete snapshots.
        candidates = [dict(c) for c in (self.channels if candidates is None else candidates)]
        cfg = self.store.get()
        day_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        day_ms = int(day_start.timestamp() * 1000)
        hour = datetime.now().hour
        for c in candidates:
            schedule = cfg.channel_schedules.get(c["id"])
            if schedule is not None:
                # 计划（唯一规范）：recording = 计划内且当前小时在时间表
                c["recording"] = schedule.is_recording_at(hour)
                c["scheduleEnabled"] = schedule.enabled
                c["scheduleHours"] = schedule.hours
            else:
                # 旧配置兼容：recording = 勾选启用；计划默认全天录
                c["recording"] = c["id"] in cfg.enabled_channel_ids
                c["scheduleEnabled"] = c["recording"]
                c["scheduleHours"] = list(range(24))
            today_ms, today_bytes = (await self.index.run(self.index.channel_today, c["id"], day_ms))
            c["todayDurationMs"] = today_ms
            c["todayBytes"] = today_bytes
            c["oldestSegmentTs"] = (await self.index.run(self.index.oldest_ts, c["id"]))

        self.channels = candidates

    def to_api(self) -> list[dict]:
        out = []
        for c in self.channels:
            out.append({
                "id": c["id"],
                "name": c["name"],
                "kind": c["kind"],
                # SEI coverage comes from recorded frames, not the channel kind.
                "streamName": c.get("streamName"),
                "recording": c["recording"],
                # 录像计划（通道选择对话框渲染 24 格时间表用）
                "scheduleEnabled": c.get("scheduleEnabled", c["recording"]),
                "scheduleHours": c.get("scheduleHours", list(range(24))),
                "sourceOnline": c["online"],
                "codec": c.get("codec"),
                "width": c.get("width"),
                "height": c.get("height"),
                "fps": c.get("fps"),
                "hasAudio": c.get("hasAudio"),
                "todayDurationMs": c.get("todayDurationMs", 0),
                "todayBytes": c.get("todayBytes", 0),
                "oldestSegmentTs": c.get("oldestSegmentTs"),
            })
        return out

    async def run_forever(self) -> None:
        while True:
            try:
                await self.refresh_once()
            except Exception as e:  # noqa: BLE001
                log.warning("通道刷新轮异常：%s", e)
            await asyncio.sleep(5)
