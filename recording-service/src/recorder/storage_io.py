"""存储 IO 隔离执行器 + 熔断器。

为什么需要它
------------
SMB/CIFS 挂载点在 NAS 异常时，unlink/stat/listdir/statvfs 等系统调用可能
进入**不可中断睡眠**（D 状态）。2026-09 现场抓到的内核栈：

    cifs_wake_up_task ← SMB2_lease_break ← smb2_unlink ← cifs_unlink
                       ← vfs_unlink ← unlinkat

这种挂死有两个致命特性：
1. 系统调用不返回，``except OSError`` 永远接不到（soft 挂载选项在 lease
   break 等待路径上也不保证唤醒）；
2. 调用发生在哪个线程，哪个线程就冻死。此前配额清理直接跑在 asyncio 主
   事件循环上，一次卡死 = 整个 HTTP 服务（播放列表/健康检查）全部无响应。

两道防线
--------
1. **线程隔离**：所有可能阻塞在存储上的同步调用都经 :meth:`IsolatedIO.run`
   提交到专用工作线程，事件循环只 ``await``（run_in_executor + wait_for），
   自身永不被堵。
2. **熔断 + 换代**：调用超时即判定存储卡死，立即 OPEN：

   - 内存标志同步生效（on_trip 回调立刻把存储置 unhealthy，下一个
     supervisor tick ≤3s 内停光录制，不等 30s 探活）；
   - **废弃当前工作线程**：D 状态线程杀不掉，让它随旧挂载泄漏；
     ``shutdown(cancel_futures=True)`` 取消队列里还没开跑的任务；
   - 后续调用立刻抛 :class:`CircuitOpenError`，不排队、不造新线程；
   - 恢复只能走"停 ffmpeg → 懒卸载旧 sb → 重新挂载 → 新 sb 写探测"
     （见 storage.py 的 recover），成功后 :meth:`reset` 换新一代线程池。
   绝不能等旧工作线程"自己回来"——它可能永远不回来。

铁律：async 代码只能 ``await io.run(...)``。严禁在协程里直接调
``concurrent.futures.Future.result(timeout)``——那本身就是阻塞调用，
会把这个模块修好的问题原样复活。
"""
from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable

from .logging_setup import get_logger

log = get_logger("recorder.storage_io")


class StorageIOError(Exception):
    """存储操作超时/失败（区别于业务层 StorageError）。"""


class CircuitOpenError(StorageIOError):
    """熔断器已 OPEN：存储正在卡死/恢复中，调用未执行。"""


class MaintenanceBusy(StorageIOError):
    """维护调用未提交：上一项还没返回，不能视作当前文件失败。"""


class MaintenanceIO:
    """本机维护单独车道，超时后保留一个在途任务，不停录也不叠加线程。

    调用方用存储 generation 丢弃切换前的结果；任务只持有原绝对路径。
    """

    def __init__(self):
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="storage-maintenance")
        self._pending = None
        self._op = None
        self._started = 0.0

    def snapshot(self):
        pending = self._pending is not None and not self._pending.done()
        return {"pending": pending, "activeOp": self._op if pending else None,
                "activeSeconds": round(time.monotonic() - self._started, 3) if pending else 0}

    async def run(self, fn, *args, timeout, op="maintenance", **kwargs):
        deadline = time.monotonic() + timeout
        # A short scan must not repeatedly starve quota cleanup on aligned ticks.
        # Wait in the coroutine, never submit a second syscall behind a stuck one.
        while self._pending is not None and not self._pending.done():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MaintenanceBusy(f"本机维护 {self._op} 仍在执行，跳过 {op}，录制继续")
            previous = asyncio.wrap_future(self._pending)
            previous.add_done_callback(lambda f: None if f.cancelled() else f.exception())
            try:
                await asyncio.wait_for(asyncio.shield(previous), remaining)
            except asyncio.TimeoutError:
                if not previous.done():
                    raise MaintenanceBusy(f"本机维护 {self._op} 仍在执行，跳过 {op}，录制继续") from None
            except Exception:
                pass  # The prior caller owns its error; this task has not run.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MaintenanceBusy(f"等待维护车道 {op} 超时，任务未提交")
        self._op, self._started = op, time.monotonic()
        started = self._started

        def execute():
            try:
                return fn(*args, **kwargs)
            finally:
                elapsed = time.monotonic() - started
                if elapsed >= 1:
                    log.warning("storage_maintenance_slow op=%s work_ms=%.1f", op, elapsed * 1000)

        self._pending = self._pool.submit(execute)
        wrapped = asyncio.wrap_future(self._pending)
        wrapped.add_done_callback(lambda f: None if f.cancelled() else f.exception())
        try:
            return await asyncio.wait_for(asyncio.shield(wrapped), remaining)
        except asyncio.TimeoutError:
            log.warning("storage_maintenance_timeout op=%s timeout_s=%.1f recording_unchanged=true", op, timeout)
            raise StorageIOError(f"本机维护 {op} 超过 {timeout}s，结果待对账，录制继续") from None

    def shutdown(self):
        self._pool.shutdown(wait=False, cancel_futures=True)


class IsolatedIO:
    """单工作线程串行执行存储同步调用 + 三态熔断（CLOSED/OPEN→reset CLOSED）。

    串行是刻意的：NAS 卡死时多个并发 syscall 只会在客户端 cifs 层堆出一串
    D 状态线程；单线程 + 熔断把泄漏线程数硬限制为"每代至多 1 个"。
    """

    def __init__(self, on_trip: Callable[[str, str], None] | None = None) -> None:
        self._cond = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="storage-io")
        self._generation = 0
        self._open = False
        self.on_trip = on_trip
        # 诊断信息（/health 暴露），纯内存读
        self.stuck_op: str | None = None
        self.stuck_since: float = 0.0
        self.last_error: str = ""
        self._active_op = None
        self._active_started = 0.0

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def tripped(self) -> bool:
        """熔断是否 OPEN（纯内存读，可在任意线程/协程安全调用）。"""
        return self._open

    def snapshot(self) -> dict[str, Any]:
        stuck_for = None
        if self._open and self.stuck_since:
            stuck_for = round(time.monotonic() - self.stuck_since, 1)
        return {
            "tripped": self._open,
            "blockedOp": self.stuck_op,
            "stuckSeconds": stuck_for,
            "generation": self._generation,
            "lastError": self.last_error or None,
            "activeOp": self._active_op,
            "activeSeconds": round(time.monotonic() - self._active_started, 3) if self._active_op else 0,
        }

    async def run(self, fn: Callable[..., Any], *args: Any,
                  timeout: float, op: str = "io", **kwargs: Any) -> Any:
        """在专用工作线程执行同步存储调用，带超时与熔断。

        - CLOSED：提交执行，正常返回/透传异常；
        - OPEN：立即抛 :class:`CircuitOpenError`，不提交；
        - 超时：跳闸（generation+1、弃线程）并抛 :class:`StorageIOError`。

        调用方注意：超时只代表"结果未知"，不代表操作没发生（例如 unlink
        可能在几秒后真正成功）。超时路径上不得做"假定成功/失败"的状态
        修改，留给下一轮扫描对账。
        """
        if self._open:
            raise CircuitOpenError(
                f"存储熔断中（{self.stuck_op} 已卡 "
                f"{round(time.monotonic() - self.stuck_since, 1) if self.stuck_since else '?'}s）"
                f"，已拒绝执行：{op}")
        pool = self._pool  # 跳闸会整体替换池；await 期间提交关系不变
        generation = self._generation
        queued_at = time.monotonic()
        started_at = None

        def execute():
            nonlocal started_at
            started_at = time.monotonic()
            self._active_op, self._active_started = op, started_at
            try:
                return fn(*args, **kwargs)
            finally:
                work_ms = (time.monotonic() - started_at) * 1000
                queue_ms = (started_at - queued_at) * 1000
                if work_ms > 1000 or queue_ms > 1000:
                    log.warning("storage_io_slow op=%s generation=%d queue_ms=%.1f work_ms=%.1f", op, generation, queue_ms, work_ms)
                if generation == self._generation:
                    self._active_op = None

        worker = pool.submit(execute)
        # shutdown(cancel_futures=True) 取消排队工作不等于取消调用协程。
        # 转为业务异常，否则后台循环会误认为收到正常关服取消并永久退出。
        result = Future()
        result.set_running_or_notify_cancel()

        def completed(future):
            if future.cancelled():
                result.set_exception(CircuitOpenError("存储工作池已换代，排队操作作废"))
            else:
                error = future.exception()
                if error is not None:
                    result.set_exception(error)
                else:
                    result.set_result(future.result())

        worker.add_done_callback(completed)
        fut = asyncio.wrap_future(result)
        try:
            value = await asyncio.wait_for(fut, timeout=timeout)
            if generation != self._generation:
                raise CircuitOpenError("存储已换代，忽略旧操作结果")
            return value
        except asyncio.TimeoutError:
            # D 状态线程杀不掉：跳闸弃线程，由恢复流程换新挂载/新池。
            if generation == self._generation:
                now = time.monotonic()
                detail = (f"等待超过 {timeout}s，queue_ms={((started_at or now) - queued_at) * 1000:.1f} "
                          f"work_ms={(now - started_at) * 1000 if started_at else 0:.1f} "
                          f"active_op={self._active_op}")
                self._trip(op, detail)
            raise StorageIOError(
                f"存储操作 {op} 超过 {timeout}s 无响应，已熔断停录") from None
        except Exception:
            if generation != self._generation:
                raise CircuitOpenError("存储已换代，忽略旧操作异常") from None
            raise

    def trip(self, op: str, message: str) -> None:
        """外部强信号（如 ffmpeg 写 NAS 长时间不出段）主动跳闸。"""
        self._trip(op, message)

    def _trip(self, op: str, message: str) -> None:
        """CAS 跳闸：多方同时超时只跳一次，且全程纯内存、无 syscall。"""
        with self._cond:
            if self._open:
                return
            self._open = True
            self.stuck_op = op
            self.stuck_since = time.monotonic()
            self.last_error = message
            old_pool = self._pool
            self._generation += 1
            self._pool = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix=f"storage-io-g{self._generation}")
        # 池替换移出锁：shutdown 不应挡住其他协程读快照
        # wait=False：不等卡死线程；cancel_futures：队列里没开跑的任务全部取消
        old_pool.shutdown(wait=False, cancel_futures=True)
        log.error("存储熔断 OPEN：%s（%s），旧工作线程已废弃，generation=%d",
                  op, message, self._generation)
        if self.on_trip is not None:
            try:
                self.on_trip(op, message)
            except Exception:  # noqa: BLE001 - 回调故障不能反噬跳闸
                log.exception("存储熔断 on_trip 回调异常")

    def reset(self, reason: str = "") -> None:
        """存储恢复（重挂 + 新 sb 写探测成功）后关熔断、换新线程池。"""
        with self._cond:
            old_pool = self._pool
            was_open = self._open
            self._open = False
            self.stuck_op = None
            self.stuck_since = 0.0
            self.last_error = ""
            self._generation += 1
            self._pool = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix=f"storage-io-g{self._generation}")
        old_pool.shutdown(wait=False, cancel_futures=True)
        if was_open:
            log.info("存储熔断恢复 CLOSED（%s），generation=%d",
                     reason or "存储已恢复", self._generation)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
