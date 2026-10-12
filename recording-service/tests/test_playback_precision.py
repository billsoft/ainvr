import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from recorder.naming import segment_filename, parse_segment_filename
from recorder.channels import ChannelManager


def test_filename_retains_milliseconds_and_reads_legacy():
    stamp = datetime(2026, 10, 5, 15, 12, 25, 334000)
    assert parse_segment_filename(segment_filename("camera", "", stamp)) == ("camera", stamp)
    assert parse_segment_filename("camera_20261005_151225.mp4")[1].microsecond == 0


@pytest.mark.asyncio
async def test_catalog_publishes_only_complete_snapshot():
    entered, release = asyncio.Event(), asyncio.Event()
    class Index:
        channel_today = None
        oldest_ts = None
        async def run(self, fn, *args):
            entered.set()
            await release.wait()
            return (0, 0) if len(args) == 2 else None
    cfg = SimpleNamespace(channel_schedules={}, enabled_channel_ids=[])
    manager = ChannelManager(SimpleNamespace(get=lambda: cfg), Index())
    manager._fetch_srs_streams = lambda: {}
    manager._fetch_ai_outputs = lambda: set()
    manager._fetch_bff_channels = lambda: [dict(id=x, name=x, app="live", streamName=x) for x in ["a", "b"]]
    refresh = asyncio.create_task(manager.refresh_once())
    await entered.wait()
    try:
        assert manager.to_api() == []
    finally:
        release.set()
        await refresh
    assert len(manager.to_api()) == 2
