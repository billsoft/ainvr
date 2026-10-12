"""单通道录像管线：读端 ffmpeg → GopGate（内存 GOP 缓冲）→ 每分段一个写端 ffmpeg。

三态（设计：docs/recording-write-backpressure-design-2026-09-24.md）：
- 写得慢：读端照常读，闸门按完整 GOP 丢弃并记账（on_event），继续录；
- 写卡死：有数据在写但超过 stall_sec 没有任何字节进展（或已关闭的写端迟迟
  不退出）→ stalled()，由监督器走存储熔断停录；
- 写报错：写端非预期退出 → 管线结束，error 带原因，监督器退避重启。

分段边界、文件命名、跨天全部由闸门按 PTS 决定：文件名 = 首个 GOP 的内容时间
（PTS 映射墙钟），不受写入积压或读端重连突发影响；跨天不再重启任何进程。
"""
from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from datetime import datetime
from typing import Callable

from .ffmpeg_recorder import (build_reader_command, build_writer_command,
                              drain_stderr, stop_processes)
from .logging_setup import get_logger
from .naming import day_dir, segment_filename
from .storage_io import IsolatedIO
from .ts_gate import GopGate, TimeMapper, TsParser
from . import writer_protection

log = get_logger("recorder.pipeline")

READ_SIZE = 1 << 20
STALL_SEC = 60.0
# 读端连上后先等锚点稳定（SRS gop_cache 突发送完）再给首个文件定名
SETTLE_SEC = 2.0
REAP_TIMEOUT = 30.0


class RecordingPipeline:
    def __init__(self, *, channel_id: str, rtmp_url: str, root: str,
                 segment_seconds: float, io: IsolatedIO, soft_cap: int, hard_cap: int,
                 on_event: Callable[[dict], None] | None = None,
                 codec: str | None = None,
                 reader_cmd: list[str] | None = None,
                 writer_cmd: Callable[..., list[str]] = build_writer_command,
                 stall_sec: float = STALL_SEC, settle_sec: float = SETTLE_SEC,
                 clock: Callable[[], float] = time.time,
                 writer_ready: Callable[[], bool] | None = None,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        self.channel_id = channel_id
        self.root = root
        self.io = io
        # 启动时按 SRS 报告的编码选读端（265 用 FFmpeg 8.1.2）；监督器发现编码与此
        # 不符（相机换了编码）会停掉重启本管线（设计 §5.2 E2）
        self.codec = codec
        self._reader_argv = reader_cmd or build_reader_command(rtmp_url, codec)
        self._writer_cmd = writer_cmd
        self._stall_sec = stall_sec
        self._settle_sec = settle_sec
        self._clock = clock
        self._on_event = on_event
        self._writer_ready = writer_ready
        self._mono = monotonic
        # 最近一次从读端解析出画面单元的时刻（None = 读端未启动）。只有解析出的
        # 访问单元才算进展：读端 FLV 解析错位时进程存活、可能吐出少量乱码却没有
        # 任何画面，监督器据此识别"读端零输出"（见 supervisor.READER_IDLE_SEC）
        self._last_input_mono: float | None = None
        self._expedite_stop = asyncio.Event()
        self._inflight_bytes = 0
        self.parser = TsParser()
        self.mapper = TimeMapper()
        self.gate = GopGate(segment_seconds, soft_cap, hard_cap, on_event=self._gate_event)
        self.error: str | None = None
        # 最近写过的文件（诊断/测试用）；管线可连续运行数周，必须有界
        self.files: deque[str] = deque(maxlen=64)
        self.started_ts = 0.0
        self._reader = None
        self._writer = None
        self._writer_leases: dict[object, tuple[str, object]] = {}
        self._closing: list[tuple[object, float]] = []
        # 每分段一个写端：其收尸/日志任务结束即移出，集合不随运行时长增长
        self._reap_tasks: set[asyncio.Task] = set()
        self._writer_logs: set[asyncio.Task] = set()
        self._tasks: list[asyncio.Task] = []
        self._done: asyncio.Task | None = None
        self._data = asyncio.Event()
        self._input_done = False
        self._inflight_since: float | None = None
        self._started_mono = 0.0
        self._made_dirs: set[str] = set()
        self._last_name_ms = 0
        self._rc: int | None = None
        self._stopping = False

    # ---------- 对监督器的接口 ----------

    @property
    def pid(self) -> int | None:
        return self._reader.pid if self._reader else None

    @property
    def returncode(self) -> int | None:
        """管线结束（读端结束且积压写完、写端已收尸）后的退出码；运行中为 None。"""
        return self._rc

    @property
    def exited(self) -> bool:
        """所有子进程都已退出（orphan 围栏据此解除）。"""
        procs = [self._reader, self._writer, *(w for w, _ in self._closing)]
        return all(p is None or p.returncode is not None for p in procs)

    def input_idle_seconds(self) -> float:
        """读端多久没有解析出画面单元（未启动为 0）。"""
        if self._last_input_mono is None:
            return 0.0
        return max(0.0, self._mono() - self._last_input_mono)

    def stalled(self) -> bool:
        now = time.monotonic()
        if self._inflight_since is not None and now - self._inflight_since > self._stall_sec:
            return True
        return any(w.returncode is None and now - since > self._stall_sec
                   for w, since in self._closing)

    def stats(self) -> dict:
        ep = self.gate.episode()
        hevc = self.parser.video_codec == "h265"
        return {
            "stalled": self.stalled(),
            "dropping": ep is not None,
            "dropStartTs": ep["startTs"] if ep else None,
            "bufferBytes": self.gate.queued_bytes,
            "inflightBytes": self._inflight_bytes,
            "waitingPreviousWriter": bool(self._writer_ready and not self._writer_ready()),
            "softCapBytes": self.gate.soft_cap,
            "hardCapBytes": self.gate.hard_cap,
            "writerWaitSec": round(time.monotonic()-self._inflight_since, 3) if self._inflight_since is not None else 0,
            "bufferSec": round(self.gate.backlog_seconds(), 1),
            "codec": self.parser.video_codec,
            # H.265 运行时准入检查（设计 §2）：多久没见 IDR、开放 GOP 帧数
            "noIdrSec": round(self.gate.seconds_since_key(), 1) if hevc else 0.0,
            "openGopAus": self.parser.open_gop_aus,
        }

    async def start(self) -> None:
        self._started_mono = time.monotonic()
        self._last_input_mono = self._mono()
        self.started_ts = self._clock()
        self._reader = await asyncio.create_subprocess_exec(
            *self._reader_argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        label = f"{self.channel_id[:8]}/读"
        self._tasks = [
            asyncio.create_task(drain_stderr(self._reader.stderr, label)),
            asyncio.create_task(self._read_loop()),
            asyncio.create_task(self._write_loop()),
        ]
        self._done = asyncio.create_task(self._run())

    @property
    def input_stopped(self) -> bool:
        """已被主动停止输入（重推交接/停用/关闭），此后管线结束是预期的，不是故障。"""
        return self._stopping

    def stop_input(self) -> None:
        """Stop accepting live input immediately; leave queued data to the writer."""
        if self._stopping:
            return
        self._stopping = True
        if self._reader is not None and self._reader.returncode is None:
            try:
                self._reader.terminate()
            except ProcessLookupError:
                pass

    def expedite_stop(self) -> None:
        """Shutdown/configuration changes may shorten a background reconnect drain."""
        self.stop_input()
        self._expedite_stop.set()

    async def _finish_input(self) -> None:
        """A blocked network reader must not consume the writer's drain budget."""
        reader = self._reader
        if reader is None or reader.returncode is not None:
            return
        try:
            await asyncio.wait_for(reader.wait(), 2.0)
        except asyncio.TimeoutError:
            log.warning('recording_reader_stop_timeout channel=%s reader_pid=%s '
                        'action=kill_reader_preserve_writer', self.channel_id, reader.pid)
            try:
                reader.kill()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(reader.wait(), 1.0)
            except asyncio.TimeoutError:
                log.error('recording_reader_unreaped channel=%s reader_pid=%s',
                          self.channel_id, reader.pid)

    async def stop(self, term_timeout: float = 5.0, kill_timeout: float = 3.0) -> bool:
        """有界停止：先停读端并给写端 term_timeout 写完积压，超时则丢弃积压
        （记账）并终止全部进程。返回 False = 有进程卡在 D 状态，转 orphan。"""
        self.stop_input()
        input_reaper = asyncio.create_task(self._finish_input())
        if self._done is not None and not self._done.done():
            expedited = asyncio.create_task(self._expedite_stop.wait())
            try:
                await asyncio.wait((self._done, expedited), timeout=term_timeout,
                                   return_when=asyncio.FIRST_COMPLETED)
            finally:
                expedited.cancel()
                await asyncio.gather(expedited, return_exceptions=True)
                await input_reaper
        else:
            await input_reaper
        if self._done is not None and not self._done.done():
            log.warning('recording_drain_timeout channel=%s budget_sec=%.1f '
                        'queued_bytes=%s inflight_bytes=%s open_writers=%s '
                        'finalization_unconfirmed=true', self.channel_id, term_timeout,
                        self.gate.queued_bytes, self._inflight_bytes,
                        len(self._closing) + int(self._writer is not None))
            for t in (*self._tasks, *self._writer_logs):
                t.cancel()
            self._done.cancel()
            # Read-loop finally flushes parser data. Finish cancellation before
            # accounting the remaining queue, or its final bytes escape the ledger.
            await asyncio.gather(*self._tasks, self._done, *self._writer_logs,
                                 return_exceptions=True)
            self.gate.discard_queue(self.mapper)
            self._close_writer()
        procs = [self._reader, self._writer, *(w for w, _ in self._closing)]
        unfinished_writers = [w for w in [self._writer, *(w for w, _ in self._closing)]
                              if w is not None and w.returncode is None]
        if unfinished_writers:
            # Pipe drain acknowledges a userspace transfer, not durable media.
            # Even an empty gate must not be reported as confirmed loss-free.
            log.warning('recording_finalize_unconfirmed channel=%s writer_pids=%s '
                        'inflight_bytes=%s files=%s', self.channel_id,
                        [w.pid for w in unfinished_writers], self._inflight_bytes,
                        list(self.files)[-3:])
        gone = await stop_processes(procs, term_timeout=min(term_timeout, 2.0),
                                    kill_timeout=kill_timeout)
        if self._reap_tasks:  # 进程已退出则收尸瞬间完成；卡死的不等（有界）
            await asyncio.wait(list(self._reap_tasks), timeout=1.0)
        if gone:
            # Process exit is not the same as pipe EOF consumption. A failed
            # writer can leave unread stdout/stderr transports alive at shutdown.
            readers = [t for t in (*self._tasks, *self._writer_logs) if not t.done()]
            for task in readers:
                task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            unique = {id(p): p for p in procs if p is not None}
            try:
                await asyncio.wait_for(asyncio.gather(
                    *(p.communicate() for p in unique.values()), return_exceptions=True), 1.0)
            except asyncio.TimeoutError:
                # A descendant may retain a pipe even after our child exited.
                # asyncio.Process has no public close() on Python 3.10.
                for process in unique.values():
                    transport = getattr(process, '_transport', None)
                    if transport is not None:
                        transport.close()
                await asyncio.sleep(0)
        if self._rc is None:
            self._rc = 1 if self.error else 0
        return gone

    # ---------- 读 ----------

    async def _read_loop(self) -> None:
        try:
            while True:
                chunk = await self._reader.stdout.read(READ_SIZE)
                if not chunk:
                    break
                now = self._clock()
                block, starts = self.parser.feed(chunk)
                if starts:
                    self._last_input_mono = self._mono()
                for s in starts:
                    if s.pts is not None:
                        self.mapper.observe(self.mapper.unwrap(s.pts), now)
                self.gate.push(block, starts, self.mapper)
                self._data.set()
        finally:
            # 读端 EOF（源断开或我们 SIGTERM，ffmpeg 都会写完当前包）：解析器里
            # 为 H.265 帧分类暂留的字节先交出，最后一帧已完整，交给写端；进行中的
            # 丢弃段收口记账
            block, starts = self.parser.flush()
            if block:
                for s in starts:
                    if s.pts is not None:
                        self.mapper.observe(self.mapper.unwrap(s.pts), self._clock())
                self.gate.push(block, starts, self.mapper)
            self.gate.finish(self.mapper)
            self._input_done = True
            self._data.set()

    # ---------- 写 ----------

    async def _write_loop(self) -> None:
        try:
            # The successor can receive/buffer immediately, but never writes while
            # the previous generation (including a D-state orphan) owns files.
            while self._writer_ready is not None and not self._writer_ready():
                await asyncio.sleep(0.1)
            # 前代已交出文件所有权：立即放掉对前代的引用，否则每代引用上一代，
            # 重推多少次就留多少代管线对象无法回收
            self._writer_ready = None
            while self.error is None:
                self._data.clear()
                chunk = self.gate.pop()
                if chunk is None:
                    if self._input_done:
                        break
                    await self._data.wait()
                    continue
                if chunk.new_file:
                    await self._open_file(chunk.file_pts)
                if self._writer is None:
                    continue
                self._inflight_since = time.monotonic()
                self._inflight_bytes = len(chunk.data)
                self._writer.stdin.write(chunk.data)
                await self._writer.stdin.drain()
                elapsed = time.monotonic() - self._inflight_since
                if elapsed >= 3:
                    log.warning('writer_recovered channel=%s wait_sec=%.3f stats=%s',
                                self.channel_id, elapsed, self.stats())
                self._inflight_since = None
                self._inflight_bytes = 0
        except (BrokenPipeError, ConnectionResetError):
            self._fail("写入进程提前退出（存储写入报错）")
        except Exception as e:  # noqa: BLE001 - 建目录超时/存储熔断等
            self._fail(f"写入失败：{e}")
        finally:
            self._inflight_since = None
            self._close_writer()

    async def _open_file(self, file_pts: float) -> None:
        self._close_writer()
        remaining = self._settle_sec - (time.monotonic() - self._started_mono)
        if remaining > 0:
            await asyncio.sleep(remaining)
        name_ms = max(round(self.mapper.wall(file_pts) * 1000), self._last_name_ms + 1)
        while True:
            ts = datetime.fromtimestamp(name_ms / 1000)
            out_dir = os.path.join(self.root, day_dir(ts))
            if out_dir not in self._made_dirs:
                # 挂载点上的 mkdir 可能 D 住：经熔断执行器，超时即跳闸
                await self.io.run(os.makedirs, out_dir, exist_ok=True,
                                  timeout=15, op="mkdir-day")
                self._made_dirs.add(out_dir)
            path = os.path.join(out_dir, segment_filename(self.channel_id, "", ts))
            # 本管线内文件名严格递增，只有重启后的首个文件可能与上一条管线的
            # 文件撞名（gop_cache 突发内容重叠）。只查这一次：共享存储车道上
            # 每分段一次 stat，NAS 慢时排队超时会把"写得慢"误升级为全局熔断。
            if self._last_name_ms or not await self.io.run(
                    os.path.exists, path, timeout=15, op="segment-exists"):
                break
            name_ms += 1  # 避让，绝不覆盖（写端 -n 兜底）
        self._last_name_ms = name_ms
        lease = writer_protection.acquire(path)
        try:
            self._writer = await asyncio.create_subprocess_exec(
                *self._writer_cmd(path, self.parser.audio_adts, self.parser.video_codec),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE)
        except BaseException:
            writer_protection.release(path, lease)
            raise
        self._writer_leases[self._writer] = (path, lease)
        log_task = asyncio.create_task(
            drain_stderr(self._writer.stderr, f"{self.channel_id[:8]}/写"))
        self._writer_logs.add(log_task)
        log_task.add_done_callback(self._writer_logs.discard)
        self._writer.stdin.write(self.parser.psi_header)
        self.files.append(path)

    def _close_writer(self) -> None:
        w, self._writer = self._writer, None
        if w is None:
            return
        try:
            w.stdin.close()
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            pass
        self._closing.append((w, time.monotonic()))
        task = asyncio.create_task(self._reap(w))
        self._reap_tasks.add(task)
        task.add_done_callback(self._reap_tasks.discard)

    async def _reap(self, w) -> None:
        rc = await w.wait()
        owned = self._writer_leases.pop(w, None)
        if owned is not None:
            writer_protection.release(*owned)
        self._closing = [(p, s) for p, s in self._closing if p is not w]
        if rc != 0 and not self._stopping:  # 停止时由我们终止的写端不算写入报错
            self._fail(f"写入进程退出码 {rc}（存储写入报错）")
        try:
            # 取走管道关闭结果，避免"Future exception was never retrieved"
            await asyncio.wait_for(w.stdin.wait_closed(), 1.0)
        except (BrokenPipeError, ConnectionResetError, asyncio.TimeoutError):
            pass

    def _fail(self, message: str) -> None:
        if self.error is None:
            self.error = message
            log.error("通道 %s 录像写入失败：%s", self.channel_id, message)
        self._data.set()
        if self._reader is not None and self._reader.returncode is None:
            try:
                self._reader.terminate()
            except ProcessLookupError:
                pass

    def _gate_event(self, event: dict) -> None:
        event = {**event, "channelId": self.channel_id}
        log.warning("通道 %s 存储写入不足，按完整 GOP 丢弃 %.1fs（%s）",
                    self.channel_id, event["droppedMs"] / 1000, event["reason"])
        log.warning('recording_drop wall=%.3f monotonic=%.3f event=%s stats=%s',
                    self._clock(), time.monotonic(), event, self.stats())
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:  # noqa: BLE001 - 记账失败不能打断录制
                log.exception("丢弃事件记录失败")

    async def _run(self) -> None:
        await asyncio.gather(*self._tasks[1:3], return_exceptions=True)
        await self._reader.wait()
        # 已关闭的写端要写完 fMP4 尾部才算结束；卡在 D 状态的由 stalled() 暴露
        pending = [t for t in self._reap_tasks if not t.done()]
        if pending:
            await asyncio.wait(pending, timeout=REAP_TIMEOUT)
        self._rc = 1 if self.error else (self._reader.returncode or 0)
