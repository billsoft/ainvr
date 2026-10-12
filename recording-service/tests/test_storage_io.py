"""IsolatedIO：线程隔离 + 超时熔断 + 换代（2026-09 NAS 冻死事故核心防线）。"""
import asyncio
import time

import pytest

from recorder.storage_io import (CircuitOpenError, IsolatedIO,
                                 StorageIOError)


def test_run_normal_result_and_exception_passthrough():
    io = IsolatedIO()
    try:
        async def main():
            assert await io.run(lambda x: x * 2, 21, timeout=2) == 42
            with pytest.raises(ValueError):
                await io.run(_raise_value, timeout=2)

        asyncio.run(main())
        assert io.tripped is False  # 业务异常不算存储卡死
    finally:
        io.shutdown()


def _raise_value():
    raise ValueError("业务异常")


def test_timeout_trips_opens_and_reset_recovers():
    trips: list[tuple[str, str]] = []
    io = IsolatedIO(on_trip=lambda op, msg: trips.append((op, msg)))
    try:
        async def main():
            t0 = time.monotonic()
            with pytest.raises(StorageIOError):
                await io.run(time.sleep, 0.5, timeout=0.1, op="unlink")
            assert time.monotonic() - t0 < 0.35
            # 跳闸：on_trip 被调、状态 OPEN、诊断字段就位
            assert io.tripped is True
            assert trips and trips[0][0] == "unlink"
            snap = io.snapshot()
            assert snap["blockedOp"] == "unlink"
            assert snap["stuckSeconds"] is not None
            gen_after_trip = io.generation

            # OPEN 期间新调用必须立即拒绝，绝不能排队再等一个超时
            t0 = time.monotonic()
            with pytest.raises(CircuitOpenError):
                await io.run(time.sleep, 10, timeout=5, op="later")
            assert time.monotonic() - t0 < 0.05

            # reset（重挂恢复）→ CLOSED，换代，调用恢复
            io.reset("测试恢复")
            assert io.tripped is False
            assert io.generation > gen_after_trip
            assert await io.run(lambda: "ok", timeout=2) == "ok"

        asyncio.run(main())
    finally:
        io.shutdown()


def test_concurrent_timeouts_trip_only_once():
    """多路调用同时超时：CAS 保证 on_trip 只触发一次。"""
    trips = []
    io = IsolatedIO(on_trip=lambda op, msg: trips.append(1))
    try:
        async def main():
            # 单工作线程：第一个 sleep 占住线程，其余排队；0.1s 后 4 个
            # wait_for 几乎同时超时
            tasks = [
                asyncio.create_task(
                    io.run(time.sleep, 1.0, timeout=0.1, op=f"op{i}"))
                for i in range(4)
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            assert len(results) == 4
            assert all(isinstance(r, StorageIOError) for r in results)
            assert len(trips) == 1

        asyncio.run(main())
    finally:
        io.shutdown()


def test_queued_job_cancelled_on_trip():
    """跳闸换代时，排在卡死任务后面的任务必须被取消而不是恢复后补跑。"""
    ran = []
    io = IsolatedIO()
    try:
        async def main():
            t1 = asyncio.create_task(
                io.run(time.sleep, 1.0, timeout=0.1, op="stuck"))
            await asyncio.sleep(0.03)  # 确保占住工作线程
            t2 = asyncio.create_task(
                io.run(ran.append, "should-never-run", timeout=2, op="queued"))
            await asyncio.gather(t1, t2, return_exceptions=True)
            await asyncio.sleep(0.05)
            assert ran == []  # cancel_futures 让排队任务从未执行

        asyncio.run(main())
    finally:
        io.shutdown()


def test_trip_is_idempotent_and_reset_while_closed_is_safe():
    io = IsolatedIO()
    try:
        io.trip("a", "first")
        g = io.generation
        io.trip("b", "second")  # OPEN 中再次跳闸：忽略，不换代
        assert io.generation == g
        assert io.snapshot()["blockedOp"] == "a"
        io.reset()
        assert io.tripped is False
        io.reset()  # CLOSED 下 reset 也安全
        assert io.tripped is False
    finally:
        io.shutdown()
