"""stop_processes 有界停止：SIGKILL 后仍 D 状态的 ffmpeg（读端或任一写端）必须
报告未退出以转 orphan，不能让 await wait() 永久挂死监督器（2026-09 事故 P0 之一）。"""
import asyncio

from recorder.ffmpeg_recorder import stop_processes


class FakeProc:
    """模拟 asyncio 子进程：不理 SIGTERM；kill 后按 stuck 决定是否退出。"""

    def __init__(self, pid=4242, stuck=False):
        self.pid = pid
        self.returncode = None
        self.stuck = stuck
        self.terminated = False
        self.killed = False

    def terminate(self):
        self.terminated = True  # SIGTERM 被忽略（卡在 D 状态收不到/不处理）

    def kill(self):
        self.killed = True
        if not self.stuck:
            self.returncode = -9

    async def wait(self):
        while self.returncode is None:
            await asyncio.sleep(0.005)
        return self.returncode


def test_stop_succeeds_when_process_dies_after_sigkill():
    proc = FakeProc(stuck=False)
    ok = asyncio.run(stop_processes([proc], term_timeout=0.05, kill_timeout=0.2))
    assert ok is True
    assert proc.terminated and proc.killed


def test_stop_returns_false_when_any_process_stuck_in_d_state():
    reader, writer = FakeProc(1, stuck=False), FakeProc(2, stuck=True)

    async def run():
        t0 = asyncio.get_event_loop().time()
        ok = await stop_processes([reader, None, writer], term_timeout=0.05, kill_timeout=0.05)
        return ok, asyncio.get_event_loop().time() - t0

    ok, elapsed = asyncio.run(run())
    assert ok is False              # 调用方据此转 orphan + spawn 围栏
    assert elapsed < 0.5            # 必须有界快速返回，不能永久等
    assert reader.returncode == -9  # 能死的照常收掉
    assert writer.killed and writer.returncode is None  # D 状态：SIGKILL 也还没生效


def test_stop_is_bounded_even_called_repeatedly():
    """第二次 stop（幂等场景）同样快速返回，不挂死。"""
    proc = FakeProc(stuck=True)

    async def run():
        ok1 = await stop_processes([proc], term_timeout=0.05, kill_timeout=0.05)
        ok2 = await stop_processes([proc], term_timeout=0.05, kill_timeout=0.05)
        return ok1, ok2

    assert asyncio.run(run()) == (False, False)
