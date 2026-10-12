import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from recorder import writer_protection
from recorder.recording_pipeline import RecordingPipeline
from recorder.quota import QuotaEnforcer


@pytest.mark.asyncio
async def test_rotated_writer_stays_protected_until_process_exits(tmp_path):
    path = str(tmp_path / "segment.mp4")
    pipeline = RecordingPipeline(channel_id="test", rtmp_url="unused", root=str(tmp_path),
                                 segment_seconds=60, io=None, soft_cap=1024, hard_cap=2048)
    finished = asyncio.Event()

    class Writer:
        stdin = SimpleNamespace(close=lambda: None, wait_closed=AsyncMock())

        async def wait(self):
            await finished.wait()
            return 0

    writer = Writer()
    pipeline._writer = writer
    pipeline._writer_leases[writer] = (path, writer_protection.acquire(path))
    pipeline._close_writer()
    await asyncio.sleep(0)
    assert writer_protection.is_writing(path)
    assert pipeline._writer is None
    finished.set()
    await asyncio.gather(*pipeline._reap_tasks)
    assert not writer_protection.is_writing(path)


def test_releasing_one_owner_does_not_release_other_writer(tmp_path):
    path = str(tmp_path / "segment.mp4")
    first = writer_protection.acquire(path)
    second = writer_protection.acquire(path)
    writer_protection.release(path, first)
    assert writer_protection.is_writing(path)
    writer_protection.release(path, second)
    assert not writer_protection.is_writing(path)


@pytest.mark.asyncio
async def test_quota_skips_old_complete_segment_until_writer_exits(tmp_path):
    path = tmp_path / "old.mp4"
    path.write_bytes(b"unfinished")
    seg = {"id": "old", "startTs": int(time.time() * 1000) - 120000,
           "relPath": path.name, "sizeBytes": 2 * 1024**3, "complete": True}

    async def run(fn, *args, **kwargs):
        kwargs.pop("timeout", None)
        kwargs.pop("op", None)
        return fn(*args, **kwargs)

    index = SimpleNamespace(run=run, used_bytes=lambda _: 2 * 1024**3,
                            oldest_segments=lambda **_: [seg], delete=lambda _: None,
                            meta_incr=lambda _: None)
    status = SimpleNamespace(root=str(tmp_path), quota_stopped=False)
    storage = SimpleNamespace(current_status=lambda: status, io=SimpleNamespace(generation=0),
                              maintenance_io=SimpleNamespace(run=run))
    quota = SimpleNamespace(mode="gb", gb=1, onFull="overwrite", minRetentionDays=0)
    config = SimpleNamespace(get=lambda: SimpleNamespace(recording=SimpleNamespace(quota=quota)))
    enforcer = QuotaEnforcer(config, index, storage)
    token = writer_protection.acquire(str(path))
    try:
        assert await enforcer.enforce("local") == 0
        assert path.exists()
    finally:
        writer_protection.release(str(path), token)
    assert await enforcer.enforce("local") == 1
    assert not path.exists()
