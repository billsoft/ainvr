"""现场诊断：SIGUSR1 一键转储全部 asyncio 任务栈 + 全部原生线程栈。

为什么不用 py-spy
----------------
py-spy 要额外装包、以 root 附加进程；本模块只用标准库（asyncio 自省 +
faulthandler），随服务常驻：

    sudo kill -USR1 $(pgrep -f 'python3 -m recorder.main')
    journalctl -u ainvr-recorder -n 200 --no-pager

输出包含：
1. 每个 asyncio 任务的名字/状态/当前协程栈（哪个 await 卡住一眼可见）；
2. 全部原生线程的 Python 栈（含卡在 D 状态 syscall 的存储工作线程）；
3. 熔断器快照（generation/blockedOp/stuckSeconds）。

信号经 asyncio 自管道在事件循环线程里处理，不是裸 C 信号处理器，可安全
遍历任务、写日志。
"""
from __future__ import annotations

import asyncio
import faulthandler
import io
import signal
import sys
import threading
import traceback

from .logging_setup import get_logger

log = get_logger("recorder.diag")


def _format_task_stack(task: asyncio.Task, loop: asyncio.AbstractEventLoop) -> str:
    buf = io.StringIO()
    current = task.get_loop() is loop and task is asyncio.current_task(loop)
    buf.write(f"任务 name={task.get_name()!r} state={_state_of(task)}"
              f" current={current}\n")
    for frame in task.get_stack(limit=25):
        traceback.print_stack(frame, file=buf)
    exc = task.exception() if task.done() and not task.cancelled() else None
    if exc is not None:
        buf.write(f"任务异常: {exc!r}\n")
    return buf.getvalue()


def _thread_name(tid: int) -> str:
    t = threading._active.get(tid)  # type: ignore[attr-defined]
    return t.name if t is not None else "?"


def _state_of(task: asyncio.Task) -> str:
    if task.cancelled():
        return "cancelled"
    if task.done():
        return "done"
    return "pending"


def install_dump_signal(loop: asyncio.AbstractEventLoop,
                        extra_snapshot=None) -> None:
    """注册 SIGUSR1：收到后把任务栈/线程栈/熔断器快照写进服务日志。

    extra_snapshot: 可选回调，返回 dict（如 IsolatedIO.snapshot()）一并输出。
    """

    def _handler() -> None:
        log.warning("========== SIGUSR1 现场快照开始 ==========")
        try:
            tasks = asyncio.all_tasks(loop)
            log.warning("asyncio 任务总数=%d（事件循环 %s）", len(tasks),
                        "运行中" if loop.is_running() else "未运行")
            for task in sorted(tasks, key=lambda t: t.get_name()):
                for line in _format_task_stack(task, loop).splitlines():
                    log.warning("[task] %s", line)
            # 原生线程：本处理器经自管道在正常 Python 上下文执行，用
            # sys._current_frames() 即可安全拿到全部线程栈（含 D 状态工作
            # 线程卡在哪个 syscall 包装函数里），不依赖 stderr 是真 fd。
            frames = sys._current_frames()
            log.warning("[thread] ---- 原生线程栈 共 %d 个 ----", len(frames))
            for tid, frame in frames.items():
                log.warning("[thread] 线程 tid=%s name=%s",
                            tid, _thread_name(tid))
                for line in traceback.format_stack(frame, limit=25):
                    for part in line.rstrip().splitlines():
                        log.warning("[thread] %s", part)
            if extra_snapshot is not None:
                try:
                    log.warning("[snapshot] %s", extra_snapshot())
                except Exception:  # noqa: BLE001
                    log.exception("快照回调异常")
        except Exception:  # noqa: BLE001 - 诊断代码绝不能反噬服务
            log.exception("SIGUSR1 转储失败")
        log.warning("========== SIGUSR1 现场快照结束 ==========")

    # add_signal_handler 依赖 set_wakeup_fd，只能在主线程调用；FastAPI
    # TestClient 的 anyio 门户线程里跑 lifespan 时会直接 RuntimeError，
    # 那种测试环境跳过即可（生产 systemd 是主线程）。
    if threading.current_thread() is not threading.main_thread():
        log.info("非主线程（%s），跳过 SIGUSR1 现场转储注册",
                 threading.current_thread().name)
        return
    loop.add_signal_handler(signal.SIGUSR1, _handler)
    # 致命信号（段错误等）也自动把全部线程栈留下。faulthandler 要求真 fd，
    # 个别环境 stderr 被替换时不应影响服务启动，失败就只保留 SIGUSR1。
    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
    except (io.UnsupportedOperation, OSError, ValueError):
        pass
    log.info("SIGUSR1 现场转储已注册：kill -USR1 <pid> 输出全部任务/线程栈")
