"""录像文件扫描器：发现文件 → ffprobe 元数据 → 完成判定 → 入索引。

2026-09 加固：listdir/isdir/stat/getsize 全部在单个隔离工作线程任务中完成
（经 StorageManager.io 熔断执行器）——这些调用在卡死的 CIFS 挂载上都会进
D 状态，此前直接跑在事件循环上，是服务冻死的第二类阻塞点。ffprobe 使用
异步子进程、有界回收与孤儿进程上限，不占串行数据车道或默认线程池。
"""
from __future__ import annotations

from .writer_protection import is_writing

import asyncio
import json
import os
import stat
import time
from datetime import datetime

from .index import SegmentIndex
from .logging_setup import get_logger
from .naming import file_key, parse_segment_filename
from .storage import StorageError, StorageManager
from .storage_io import StorageIOError

log = get_logger("recorder.scanner")

DAY_DIR_RE = __import__("re").compile(r"^\d{8}$")


_probe_orphans: set[asyncio.subprocess.Process] = set()


async def ffprobe(path: str) -> dict | None:
    """A killed CIFS reader may never exit. Never wait unboundedly for it.

    Keep a small, process-wide budget across storage generations/restarted scan
    tasks. This allows recovery after a remount without accumulating processes.
    """
    _probe_orphans.difference_update(p for p in list(_probe_orphans) if p.returncode is not None)
    if len(_probe_orphans) >= 4:
        raise StorageIOError("录像探测挂起进程已达上限，等待内核回收")
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), 20)
        if proc.returncode != 0:
            return None
        return json.loads(output)
    except (json.JSONDecodeError, OSError):
        return None
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        # Cancellation and timeout both go through this bounded cleanup.
        try:
            await asyncio.wait_for(proc.communicate(), 0.5)
        except asyncio.TimeoutError:
            if proc.returncode is None:
                _probe_orphans.add(proc)
        except asyncio.CancelledError:
            if proc.returncode is None:
                _probe_orphans.add(proc)
            raise


def parse_probe(data: dict) -> dict:
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps = None
    if v and v.get("r_frame_rate") and "/" in v["r_frame_rate"]:
        num, den = v["r_frame_rate"].split("/")
        try:
            fps = round(int(num) / int(den), 2) if int(den) else None
        except ValueError:
            fps = None
    codec_raw = (v or {}).get("codec_name", "h264").lower()
    codec = "h265" if codec_raw in ("hevc", "h265") else "h264"
    return {
        "codec": codec,
        "width": (v or {}).get("width"),
        "height": (v or {}).get("height"),
        "fps": fps,
        "hasAudio": a is not None,
        "durationMs": int(float(data.get("format", {}).get("duration", 0) or 0) * 1000),
    }


def _collect_files(root: str) -> list[tuple[str, str, float, int]]:
    """单趟遍历录像根目录：listdir/isdir/stat/getsize 一次拿全。

    纯同步、可能整体 D 在卡死的 CIFS 挂载上，必须由熔断执行器在隔离
    工作线程调用，禁止在事件循环上直跑。返回 (abs_path, rel_path,
    mtime, size) 列表。
    """
    out: list[tuple[str, str, float, int]] = []
    for day in sorted(os.listdir(root)):
        if not DAY_DIR_RE.match(day):
            continue
        d = os.path.join(root, day)
        # 不使用 isdir：它会吞掉 EACCES/EIO，导致不完整扫描被误判为文件已删。
        if not stat.S_ISDIR(os.stat(d).st_mode):
            continue
        for name in os.listdir(d):
            if not name.endswith(".mp4"):
                continue
            abs_path = os.path.join(d, name)
            # 包括扫描途中删除的 ENOENT：本轮放弃清理，下轮完整扫描再确认。
            st = os.stat(abs_path)
            if not stat.S_ISREG(st.st_mode):
                continue
            out.append((abs_path, os.path.join(day, name), st.st_mtime, st.st_size))
    return out


class CatalogResolver:
    """streamName/file-key → 通道信息。由 channels 管理器注入最新目录。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        # streamName -> {id,name,kind}
        self._by_stream: dict[str, dict] = {}
        # file key -> {id,name,kind}
        self._by_key: dict[str, dict] = {}

    async def update(self, channels: list[dict]) -> None:
        by_stream: dict[str, dict] = {}
        by_key: dict[str, dict] = {}
        for ch in channels:
            sn = ch.get("streamName")
            if not sn:
                continue
            info = {"id": ch["id"], "name": ch["name"], "kind": ch.get("kind", "source"),
                    "streamName": sn}
            by_stream[sn] = info
            by_key[file_key(ch["id"], ch["name"])] = info
        async with self._lock:
            self._by_stream = by_stream
            self._by_key = by_key

    def resolve(self, key: str) -> dict | None:
        if key in self._by_key:
            return self._by_key[key]
        # 兜底：通道改名后历史文件前缀是旧的 <id>_<旧名>
        for info in self._by_key.values():
            if key.startswith(info["id"] + "_"):
                return info
        return None


class Scanner:
    def __init__(self, index: SegmentIndex, storage_mgr: StorageManager,
                 resolver: CatalogResolver, segment_seconds: int):
        self.index = index
        self.storage = storage_mgr
        self.resolver = resolver
        self.segment_seconds = segment_seconds
        self._missing: set[str] = set()
        self._scan_scope: tuple[str, str, int] | None = None

    def _root(self) -> tuple[str, str]:
        status = self.storage.current_status()
        if not status.healthy:
            raise StorageError("存储不健康，不能用不完整目录清理索引")
        # 配额停录仍须对账：用户删文件后才能释放 used_bytes 并恢复录制。
        return self.storage.media_root(), status.kind

    async def scan_once(self) -> int:
        try:
            root, kind = self._root()
        except StorageError:
            self._missing.clear()
            return 0
        generation = self.storage.io.generation
        storage_id = self.storage.current_status().storage_id
        scope = (root, kind, generation)
        if self._scan_scope != scope:
            self._missing.clear()
            self._scan_scope = scope
        # 只清理扫描开始前已存在的行，不碰扫描期间其它任务新增的索引。
        before = [r for r in (await self.index.run(self.index.all_segments, ))
                  if r["storage"] == kind and r.get('storageId', '') == storage_id]
        # 全部 listdir/isdir/stat/getsize 作为一个任务在隔离工作线程执行：
        # 本机慢维护不改变录制状态；NAS 超时仍熔断，事件循环不会堵塞。
        try:
            collected = await self.storage.maintenance_io.run(
                _collect_files, root, timeout=120, op="scan")
        except (StorageIOError, OSError) as e:
            self._missing.clear()
            log.warning("扫描录像根目录失败/超时（存储卡死？）：%s", e)
            return 0

        try:
            if self._root() != (root, kind) or self.storage.io.generation != generation:
                self._missing.clear()
                return 0
        except StorageError:
            self._missing.clear()
            return 0
        present = {rel for _, rel, _, _ in collected}
        missing = {r["id"] for r in before if r["relPath"] not in present}
        confirmed = missing & self._missing
        for segment_id in confirmed:
            (await self.index.run(self.index.delete, segment_id))
        if confirmed:
            log.info("目录对账：清理 %d 条已连续两轮确认文件不存在的 %s 录像索引（不删除文件）",
                     len(confirmed), kind)
        self._missing = missing - confirmed
        existing = {r["relPath"]: r for r in before if r["id"] not in confirmed}
        path_counts: dict[str, int] = {}
        for row in before:
            path_counts[row["relPath"]] = path_counts.get(row["relPath"], 0) + 1
        now = time.time()
        # 完成判定依据：该通道出现更新的文件
        newest_by_channel: dict[str, float] = {}
        metas: list[tuple[str, str, datetime, float, int]] = []
        for abs_path, rel, mtime, size in collected:
            parsed = parse_segment_filename(os.path.basename(abs_path))
            if not parsed:
                continue
            key, ts = parsed
            info = self.resolver.resolve(key)
            cid = info["id"] if info else key
            # NAS mtime uses the server clock (observed almost one day ahead),
            # while a still-open CIFS file may expose the client's cached time.
            # Only the recorder-generated filename establishes segment order.
            newest_by_channel[cid] = max(newest_by_channel.get(cid, 0.0), ts.timestamp())
            metas.append((abs_path, rel, ts, mtime, size))

        changed = 0
        for abs_path, rel, ts, mtime, size in metas:
            row = existing.get(rel)
            key = parse_segment_filename(os.path.basename(abs_path))[0]
            info = self.resolver.resolve(key)
            if info is None and row is None:
                # 启动时 catalog 与 scanner 并行；未拿到通道身份就等下一轮，
                # 不能把 <id>_<name> 文件前缀当作新的 channelId。
                continue
            cid = info["id"] if info else row["channelId"]
            cname = info["name"] if info else row["channelName"]
            kind_ai = bool(info and info.get("kind") == "ai")
            complete = not is_writing(abs_path) and (
                newest_by_channel.get(cid, 0.0) > ts.timestamp()
                or now - mtime > self.segment_seconds * 1.5
                or (row is not None and row["sizeBytes"] == size
                    and now - ts.timestamp() > self.segment_seconds * 1.5)
            )
            start_ms = int(ts.timestamp() * 1000)
            segment_id = f"{cid}-{start_ms}" + (f"-{storage_id}" if storage_id else '')
            if row is not None and row["complete"] == complete and row["sizeBytes"] == size:
                if info is not None and (row["id"] != segment_id or row["channelName"] != cname
                                         or path_counts.get(rel, 0) > 1):
                    (await self.index.run(self.index.upsert_segment, {**row, "id": segment_id, "channelId": cid,
                                               "channelName": cname, "streamName": info["streamName"],
                                               "seiPresent": kind_ai}, require_existing_id=row['id']))
                    changed += 1
                continue
            try:
                probe = await ffprobe(abs_path)
            except (asyncio.TimeoutError, StorageIOError) as error:
                if kind == "smb" and self.storage.io.generation == generation:
                    self.storage.io.trip("scan-probe", str(error) or "录像元数据读取超过 20s")
                else:
                    log.warning("录像元数据读取超时：%s；本轮扫描结束，未改变录制状态", abs_path)
                return changed
            if self.storage.io.generation != generation:
                return changed  # 切换存储后旧路径的探测结果不能写入新索引视图
            if probe is None:
                continue  # 暂时不可探（正在写/网络抖动），下轮再来
            meta = parse_probe(probe)
            duration_ms = max(1, meta["durationMs"])
            (await self.index.run(self.index.upsert_segment, {
                "id": segment_id,
                "channelId": cid,
                "channelName": cname,
                "streamName": info["streamName"] if info else "",
                "startTs": start_ms,
                "endTs": start_ms + duration_ms,
                "durationMs": duration_ms,
                "sizeBytes": size,
                "codec": meta["codec"],
                "width": meta["width"],
                "height": meta["height"],
                "fps": meta["fps"],
                "hasAudio": meta["hasAudio"],
                "seiPresent": kind_ai,
                "storage": kind,
                "storageId": storage_id,
                "relPath": rel,
                "complete": complete,
            }, require_existing_id=row['id'] if row is not None else None))
            changed += 1
        return changed

    async def run_forever(self) -> None:
        while True:
            try:
                await self.scan_once()
            except Exception as e:  # noqa: BLE001
                log.warning("扫描轮异常：%s", e)
            await asyncio.sleep(10)
