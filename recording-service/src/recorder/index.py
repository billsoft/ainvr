"""SQLite 段索引：WAL，运行时通过独立串行线程访问，告警读内存缓存。"""
from __future__ import annotations

import os
import json
import sqlite3
import threading
import time
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  codec TEXT NOT NULL,
  width INTEGER, height INTEGER, fps REAL,
  has_audio INTEGER NOT NULL DEFAULT 0,
  sei_present INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL,
  storage_id TEXT NOT NULL DEFAULT '',
  rel_path TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_seg_ch_start ON segments(channel_id, start_ts);
CREATE INDEX IF NOT EXISTS ix_seg_start ON segments(start_ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- 存储写入不足时按完整 GOP 丢弃的区间（内容墙钟时间），时间轴与告警用
CREATE TABLE IF NOT EXISTS drop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  dropped_ms INTEGER NOT NULL,
  gops INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drop_ch_start ON drop_events(channel_id, start_ts);
"""


# 停止录制时顺手丢掉的画面组上限：8K 相机的画面组一般 1–2 秒，留到 3 秒。
STOP_DROP_NOISE_MS = 3000


class SegmentIndex:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        if 'storage_id' not in {r[1] for r in self.conn.execute('PRAGMA table_info(segments)')}:
            # Preserve the original index before the additive migration. Legacy
            # rows remain unbound until a real file is probed in its current root.
            backup = sqlite3.connect(path + '.before-storage-identity.bak')
            self.conn.backup(backup)
            backup.close()
            self.conn.execute("ALTER TABLE segments ADD COLUMN storage_id TEXT NOT NULL DEFAULT ''")
        self.active_storage_id = ''
        if 'sei_ranges' not in {r[1] for r in self.conn.execute('PRAGMA table_info(segments)')}:
            backup = sqlite3.connect(path + '.before-sei-ranges.bak')
            self.conn.backup(backup)
            backup.close()
            self.conn.execute('ALTER TABLE segments ADD COLUMN sei_ranges TEXT')
        # 记录"这一段的识别信息为什么是空的"：'source' = 当时判断它是普通源所以没扫（可能判错，
        # 例如新建的 AI 输出通道先出现在通道列表里、AI 目录 30 秒后才刷新）；NULL = 真的扫描过。
        # 持久化在库里，录像服务重启后仍能据此纠正。
        if 'sei_reason' not in {r[1] for r in self.conn.execute('PRAGMA table_info(segments)')}:
            self.conn.execute('ALTER TABLE segments ADD COLUMN sei_reason TEXT')
        # Derived SEI metadata is versioned independently from recording files.
        version = self.conn.execute("SELECT value FROM meta WHERE key='sei_index_version'").fetchone()
        # v2: 只有非空检测结果才生成识别区间，旧 det: [] 不再标红。
        # v3: 通道类型未确认时曾把 AI 输出的录像误标为"无识别信息"，全部重新索引一次。
        # v4: 增加 sei_reason，旧版本（没有跳过原因）标空的录像无法区分是扫的还是跳过的，再重新索引一次。
        if version is None or version[0] != '4':
            self.conn.execute('UPDATE segments SET sei_ranges=NULL,sei_present=0,sei_reason=NULL')
            self.conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('sei_index_version','4')")
        self.conn.execute('CREATE TEMP VIEW active_segments AS SELECT * FROM segments')
        self.conn.commit()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='recorder-index')
        self._slots = asyncio.Semaphore(32)
        self._pending = 0
        self._operation = None
        self._operation_since = 0.0
        self._pending_lock = threading.Lock()
        self._recent_lock = threading.Lock()
        self._recent = [dict(r) for r in self.conn.execute(
            'SELECT end_ts,channel_id,dropped_ms,reason FROM drop_events WHERE end_ts>=?',
            (int(time.time()*1000)-3_600_000,))]

    def _execute(self, fn, args, kwargs, queued):
        started = time.monotonic()
        self._operation = getattr(fn, '__name__', 'call')
        self._operation_since = started
        try:
            return fn(*args, **kwargs)
        finally:
            elapsed = time.monotonic()-started
            if elapsed > 1 or started-queued > 1:
                logging.getLogger(__name__).warning(
                    'index_slow operation=%s queue_ms=%.0f work_ms=%.0f pending=%d',
                    getattr(fn, '__name__', 'call'), (started-queued)*1000,
                    elapsed*1000, self._pending)
            self._operation = None

    def io_snapshot(self):
        return {'operation': self._operation,
                'operationSeconds': round(time.monotonic()-self._operation_since, 3) if self._operation else 0,
                'pendingDropEvents': self._pending}

    async def run(self, fn, *args, **kwargs):
        """One serial database lane; cancelled callers cannot reorder in-flight writes."""
        await self._slots.acquire()
        loop = asyncio.get_running_loop()
        try:
            future = self._worker.submit(self._execute, fn, args, kwargs, time.monotonic())
        except BaseException:
            self._slots.release()
            raise
        def finished(f):
            # Cancellation releases the caller, not the disk operation or its slot.
            try:
                loop.call_soon_threadsafe(self._slots.release)
            except RuntimeError:
                pass  # application loop already closed
        future.add_done_callback(finished)
        wrapped = asyncio.wrap_future(future)
        wrapped.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        return await asyncio.shield(wrapped)

    def _remember_drop(self, event):
        now = int(time.time()*1000)
        with self._recent_lock:
            self._recent = [r for r in self._recent if r['end_ts'] >= now-3_600_000]
            self._recent.append(dict(end_ts=event['endTs'], channel_id=event['channelId'],
                                     dropped_ms=event.get('droppedMs', 0), reason=event.get('reason', '')))

    def recent_drops(self, since_ts):
        """HTTP/live recording status never waits for the SQLite lock."""
        result = {}
        with self._recent_lock:
            for row in self._recent:
                if row['end_ts'] < since_ts or (row['reason']=='stopped' and row['dropped_ms'] < STOP_DROP_NOISE_MS):
                    continue
                key = row['channel_id']
                result[key] = result.get(key, 0) + row['dropped_ms']
        return result

    def record_drop(self, event):
        """Record promptly in memory, persist off the reader's event loop."""
        if event.get('startTs') is None or event.get('endTs') is None:
            return
        event = dict(event)
        self._remember_drop(event)
        with self._pending_lock:
            if self._pending >= 1024:
                # Bounded during a permanently stuck disk. The full event remains
                # in the journal for recovery instead of growing tasks forever.
                logging.getLogger(__name__).error('drop_persistence_overflow event=%s', event)
                return
            self._pending += 1
        future = self._worker.submit(self._execute, self._persist_drop, (event,), {}, time.monotonic())
        def done(f):
            with self._pending_lock:
                self._pending -= 1
            if f.exception() is not None:
                logging.getLogger(__name__).error('drop_persistence_failed event=%s error=%s', event, f.exception())
        future.add_done_callback(done)

    def activate_storage(self, storage_id: str) -> None:
        assert storage_id and all(c in '0123456789abcdef' for c in storage_id)
        with self._lock:
            self.active_storage_id = storage_id
            self.conn.execute('DROP VIEW active_segments')
            self.conn.execute(f"CREATE TEMP VIEW active_segments AS SELECT * FROM segments WHERE storage_id='{storage_id}'")

    def close(self) -> None:
        self._worker.shutdown(wait=True)
        with self._lock:
            self.conn.close()

    def upsert_segment(self, row: dict[str, Any], *, require_existing_id: str | None = None) -> None:
        cols = [
            "id", "channel_id", "channel_name", "stream_name", "start_ts", "end_ts",
            "duration_ms", "size_bytes", "codec", "width", "height", "fps",
            "has_audio", "sei_present", "storage", "rel_path", "complete", "created_at", "storage_id",
            "sei_ranges",
        ]
        placeholders = ",".join("?" for _ in cols)
        updates = ",".join(f"{c}=excluded.{c}" for c in cols if c != "id")
        values = [
            row["id"], row["channelId"], row["channelName"], row["streamName"],
            row["startTs"], row["endTs"], row["durationMs"], row["sizeBytes"],
            row["codec"], row.get("width"), row.get("height"), row.get("fps"),
            1 if row.get("hasAudio") else 0, 1 if row.get("seiPresent") else 0,
            row["storage"], row["relPath"], 1 if row.get("complete") else 0,
            int(time.time()),
            row.get('storageId', self.active_storage_id),
            json.dumps(row['seiRanges']) if row.get('seiRanges') is not None else None,
        ]
        with self._lock, self.conn:
            # Scanner probes can finish after quota has removed the old row.
            # Check and update together in this lane, never resurrect that row.
            if require_existing_id is not None and self.conn.execute(
                    'SELECT 1 FROM segments WHERE id=?', (require_existing_id,)).fetchone() is None:
                return
            # 同一存储相对路径只对应一个文件。纠正旧的临时通道 ID 时原子替换，
            # 不留两个逻辑段重复占用配额/展示同一个物理 MP4。
            self.conn.execute(
                "DELETE FROM segments WHERE storage=? AND rel_path=? AND id<>? AND storage_id IN ('',?)",
                (row["storage"], row["relPath"], row["id"], row.get('storageId', self.active_storage_id)))
            self.conn.execute(
                f"INSERT INTO segments ({','.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                values,
            )
            self.conn.commit()

    def get(self, segment_id: str) -> dict[str, Any] | None:
        with self._lock:
            cur = self.conn.execute("SELECT * FROM segments WHERE id=?", (segment_id,))
            r = cur.fetchone()
        return self._to_dict(r) if r else None

    def query(self, channel_id: str, from_ts: int, to_ts: int) -> list[dict[str, Any]]:
        with self._lock:
            cur = self.conn.execute(
                "SELECT * FROM active_segments WHERE channel_id=? AND complete=1 "
                "AND start_ts < ? AND end_ts > ? ORDER BY start_ts",
                (channel_id, to_ts, from_ts),
            )
            rows = cur.fetchall()
        return [self._to_dict(r) for r in rows]

    @staticmethod
    def _to_dict(r: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": r["id"],
            "channelId": r["channel_id"],
            "channelName": r["channel_name"],
            "streamName": r["stream_name"],
            "startTs": r["start_ts"],
            "endTs": r["end_ts"],
            "durationMs": r["duration_ms"],
            "sizeBytes": r["size_bytes"],
            "codec": r["codec"],
            "width": r["width"],
            "height": r["height"],
            "fps": r["fps"],
            "hasAudio": bool(r["has_audio"]),
            "seiPresent": bool(json.loads(r['sei_ranges'])) if r['sei_ranges'] else False,
            "seiRanges": json.loads(r['sei_ranges']) if r['sei_ranges'] else None,
            "storage": r["storage"],
            "storageId": r["storage_id"],
            "relPath": r["rel_path"],
            "complete": bool(r["complete"]),
        }

    # ---------- 统计 ----------

    def pending_sei(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute('SELECT * FROM active_segments WHERE complete=1 AND sei_ranges IS NULL ORDER BY start_ts DESC LIMIT 200').fetchall()
        return [self._to_dict(row) for row in rows]

    def reset_sei_ranges(self, channel_id: str) -> None:
        """该通道已完成的录像重新排队做识别信息索引（通道类型被修正时用）。"""
        with self._lock, self.conn:
            self.conn.execute('UPDATE segments SET sei_ranges=NULL,sei_present=0,sei_reason=NULL WHERE channel_id=? AND storage_id=? AND complete=1',
                              (channel_id, self.active_storage_id))

    def channels_skipped_as_source(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self.conn.execute("SELECT DISTINCT channel_id FROM active_segments WHERE sei_reason='source'")]

    def skip_sei_as_source(self, row: dict) -> None:
        """这一段因通道被判为普通源而不扫描：标成"无识别信息"，并记下原因，判错了以后能纠正。"""
        with self._lock, self.conn:
            self.conn.execute("UPDATE segments SET sei_ranges='[]',sei_present=0,sei_reason='source' WHERE id=? AND size_bytes=? AND storage_id=? AND complete=1",
                              (row['id'], row['sizeBytes'], row['storageId']))

    def reset_sei_skipped_as_source(self, channel_id: str) -> int:
        """该通道现在确认是 AI 输出：把之前因"普通源"判断而跳过的录像重新排队（真正扫描过的不动）。"""
        with self._lock, self.conn:
            cur = self.conn.execute("UPDATE segments SET sei_ranges=NULL,sei_present=0,sei_reason=NULL WHERE channel_id=? AND storage_id=? AND sei_reason='source'",
                                    (channel_id, self.active_storage_id))
            return cur.rowcount

    def set_sei_ranges(self, row: dict, ranges: list) -> None:
        with self._lock, self.conn:
            self.conn.execute('UPDATE segments SET sei_ranges=?,sei_present=?,sei_reason=NULL WHERE id=? AND size_bytes=? AND storage_id=? AND complete=1',
                              (json.dumps(ranges), bool(ranges), row['id'], row['sizeBytes'], row['storageId']))

    def today_aggregate(self, day_start_ms: int) -> tuple[int, int]:
        with self._lock:
            cur = self.conn.execute(
                "SELECT COALESCE(SUM(duration_ms),0) d, COALESCE(SUM(size_bytes),0) b "
                "FROM active_segments WHERE complete=1 AND start_ts >= ?",
                (day_start_ms,),
            )
            r = cur.fetchone()
        return int(r["d"]), int(r["b"])

    def channel_today(self, channel_id: str, day_start_ms: int) -> tuple[int, int]:
        with self._lock:
            cur = self.conn.execute(
                "SELECT COALESCE(SUM(duration_ms),0) d, COALESCE(SUM(size_bytes),0) b "
                "FROM active_segments WHERE complete=1 AND channel_id=? AND start_ts >= ?",
                (channel_id, day_start_ms),
            )
            r = cur.fetchone()
        return int(r["d"]), int(r["b"])

    def oldest_ts(self, channel_id: str | None = None) -> int | None:
        with self._lock:
            if channel_id:
                cur = self.conn.execute(
                    "SELECT MIN(start_ts) m FROM active_segments WHERE complete=1 AND channel_id=?",
                    (channel_id,))
            else:
                cur = self.conn.execute(
                    "SELECT MIN(start_ts) m FROM active_segments WHERE complete=1")
            r = cur.fetchone()
        return r["m"] if r and r["m"] is not None else None

    def used_bytes(self, storage: str) -> int:
        with self._lock:
            cur = self.conn.execute(
                "SELECT COALESCE(SUM(size_bytes),0) b FROM active_segments WHERE storage=?",
                (storage,))
            return int(cur.fetchone()["b"])

    def oldest_segments(self, limit: int, min_age_ms: int, now_ms: int,
                        storage: str | None = None) -> list[dict[str, Any]]:
        """LRU 候选：最旧的完整段，且老于保留期（min_age_ms=0 不限制）。"""
        with self._lock:
            cur = self.conn.execute(
                "SELECT * FROM active_segments WHERE complete=1 AND start_ts <= ? "
                "AND (? IS NULL OR storage=?) ORDER BY start_ts ASC LIMIT ?",
                (now_ms - min_age_ms, storage, storage, limit))
            rows = cur.fetchall()
        return [self._to_dict(r) for r in rows]

    def delete(self, segment_id: str) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM segments WHERE id=?", (segment_id,))
            self.conn.commit()

    # ---------- 扫描器支持 ----------

    def all_segments(self) -> list[dict[str, Any]]:
        with self._lock:
            cur = self.conn.execute("SELECT * FROM segments")
            rows = cur.fetchall()
        return [self._to_dict(r) for r in rows]

    def set_complete(self, segment_id: str, end_ts: int, duration_ms: int, size_bytes: int) -> None:
        with self._lock:
            self.conn.execute(
                "UPDATE segments SET complete=1,end_ts=?,duration_ms=?,size_bytes=? WHERE id=?",
                (end_ts, duration_ms, size_bytes, segment_id))
            self.conn.commit()

    # ---------- 写入不足丢弃事件 ----------

    def add_drop_event(self, event: dict[str, Any]) -> None:
        self._persist_drop(event)
        if event.get('startTs') is not None and event.get('endTs') is not None:
            self._remember_drop(event)

    def _persist_drop(self, event: dict[str, Any]) -> None:
        start, end = event.get("startTs"), event.get("endTs")
        if start is None or end is None:
            return
        with self._lock, self.conn:
            self.conn.execute(
                "INSERT INTO drop_events(channel_id,start_ts,end_ts,dropped_ms,gops,bytes,reason,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (event["channelId"], int(start), int(max(end, start)), int(event.get("droppedMs", 0)),
                 int(event.get("gops", 0)), int(event.get("bytes", 0)), event.get("reason", ""),
                 int(time.time())))

    def drop_events(self, channel_id: str, from_ts: int, to_ts: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT start_ts,end_ts,dropped_ms,reason FROM drop_events "
                "WHERE channel_id=? AND start_ts < ? AND end_ts > ? ORDER BY start_ts",
                (channel_id, to_ts, from_ts)).fetchall()
        return [{"startTs": r["start_ts"], "endTs": r["end_ts"],
                 "droppedMs": r["dropped_ms"], "reason": r["reason"]} for r in rows]

    def dropped_ms_since(self, since_ts: int) -> dict[str, int]:
        """→ {channelId: 丢弃毫秒}，只统计 since_ts 之后结束的"写入不足"事件。

        停止录制（相机重新推流、换存储）时缓冲里没写完的那一个画面组也会记成 reason='stopped'，
        这不是写入慢：几秒以内的 stopped 不计入。停止时丢了几十秒则是积压，仍然计入。
        时间轴上的丢弃记录（drop_events()）不受影响，每一条都保留。"""
        with self._lock:
            rows = self.conn.execute(
                "SELECT channel_id, SUM(dropped_ms) ms FROM drop_events WHERE end_ts >= ? "
                "AND NOT (reason='stopped' AND dropped_ms < ?) "
                "GROUP BY channel_id", (since_ts, STOP_DROP_NOISE_MS)).fetchall()
        return {r["channel_id"]: int(r["ms"] or 0) for r in rows}

    def prune_drop_events(self) -> int:
        """Keep the last hour even when quota rollover has removed its recordings."""
        with self._lock, self.conn:
            cur = self.conn.execute(
                "DELETE FROM drop_events WHERE end_ts < ? AND end_ts < COALESCE("
                "(SELECT MIN(start_ts) FROM segments s WHERE s.channel_id=drop_events.channel_id), "
                "?)", (int(time.time()*1000)-3_600_000, int(time.time() * 1000) - 90 * 86_400_000,))
            return cur.rowcount

    def meta_get(self, key: str, default: int = 0) -> int:
        with self._lock:
            cur = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,))
            r = cur.fetchone()
        try:
            return int(r["value"]) if r else default
        except (TypeError, ValueError):
            return default

    def meta_incr(self, key: str, by: int = 1) -> int:
        val = self.meta_get(key) + by
        with self._lock:
            self.conn.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) "
                "DO UPDATE SET value=excluded.value", (key, str(val)))
            self.conn.commit()
        return val
