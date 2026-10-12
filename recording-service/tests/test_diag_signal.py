"""SIGUSR1 现场转储（替代 py-spy）：收信号后输出 asyncio 任务栈、原生
线程栈与熔断器快照，且诊断代码自身不崩溃。"""
import asyncio
import io
import logging
import os
import signal
import sys

from recorder.diag import install_dump_signal


def test_sigusr1_dump_outputs_task_and_thread_stacks():
    records: list[str] = []
    holder = logging.Handler()
    holder.emit = lambda r: records.append(r.getMessage())  # type: ignore[assignment]
    logging.getLogger("recorder.diag").addHandler(holder)
    old_err = sys.stderr
    sys.stderr = io.StringIO()  # 诊断不得依赖 stderr 是真 fd
    try:
        loop = asyncio.new_event_loop()

        async def scenario():
            install_dump_signal(
                loop,
                extra_snapshot=lambda: {"tripped": False, "generation": 1})

            async def waiter():
                await asyncio.sleep(10)  # 制造一个 pending 任务供转储

            task = asyncio.create_task(waiter(), name="sentinel-task")
            os.kill(os.getpid(), signal.SIGUSR1)
            await asyncio.sleep(0.3)  # 让自管道回调执行
            task.cancel()

        loop.run_until_complete(scenario())
        loop.close()
    finally:
        sys.stderr = old_err
        logging.getLogger("recorder.diag").removeHandler(holder)

    text = "\n".join(records)
    assert "SIGUSR1 现场快照开始" in text
    assert "asyncio 任务总数" in text
    assert "sentinel-task" in text  # pending 协程被列出
    assert "{'tripped': False, 'generation': 1}" in text
    assert "原生线程栈" in text  # sys._current_frames 全部线程栈
    assert "SIGUSR1 现场快照结束" in text
