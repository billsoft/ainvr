import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from recorder.app import create_app
from recorder.config import ConfigStore
from recorder.media import LimitedFileResponse
from recorder.storage import StorageManager


def test_stalled_reader_returns_503_and_releases_permit(monkeypatch):
    async def run():
        async def blocked():
            await asyncio.Event().wait()
        proc = SimpleNamespace(returncode=None, stdout=SimpleNamespace(readline=blocked),
                               communicate=AsyncMock(return_value=(b'', b'')))
        proc.kill = lambda: setattr(proc, 'returncode', -9)
        monkeypatch.setattr('recorder.media.asyncio.create_subprocess_exec', AsyncMock(return_value=proc))
        storage = StorageManager()
        sem = asyncio.Semaphore(1)
        response = LimitedFileResponse('/unused', semaphore=sem, storage=storage)
        response.read_timeout = 0.02
        messages = []
        async def send(message): messages.append(message)
        async def receive(): await asyncio.Event().wait()
        try:
            await asyncio.wait_for(response({'type': 'http', 'method': 'GET'}, receive, send), 1)
            assert messages[0]['status'] == 503
            assert storage.io.tripped and not sem.locked()
            assert proc.returncode == -9
        finally:
            storage.shutdown()
    asyncio.run(run())


@pytest.mark.parametrize('seconds,restart', [(60, False), (120, True)])
def test_schedule_and_segment_apply(tmp_path, monkeypatch, seconds, restart):
    callbacks = []
    monkeypatch.setattr('recorder.app.client_from_env', lambda service, cb: callbacks.append(cb))
    store = ConfigStore(str(tmp_path / 'config.json'))
    store.cfg.enabled_channel_ids = ['removed']
    app = create_app(store, str(tmp_path))
    try:
        raw = store.get().recording.model_dump()
        raw.update(channelSchedules={})
        raw['files']['segmentSeconds'] = seconds
        with TestClient(app):
            assert callbacks[0](raw)
            assert store.get().recording.files.segmentSeconds == seconds
            assert store.get().enabled_channel_ids == []
    finally:
        app.state.storage.io.shutdown()
        app.state.index.close()


@pytest.mark.parametrize('deleted', [True, False])
def test_deleted_or_disabled_channel_stops_even_when_storage_down(tmp_path, monkeypatch, deleted):
    monkeypatch.setattr('recorder.app.client_from_env', lambda *args: None)
    app = create_app(ConfigStore(str(tmp_path / 'config.json')), str(tmp_path))
    sup = app.state.supervisor
    app.state.channels.channels = [] if deleted else [{'id': 'ch'}]
    app.state.storage.status.healthy = False
    proc = SimpleNamespace(stop=AsyncMock(return_value=True))
    state = sup.state_of('ch')
    state.proc = proc
    state.state = 'recording'
    try:
        asyncio.run(sup._tick())
        proc.stop.assert_awaited_once()
        assert state.proc is None
        assert state.state == 'disabled'
    finally:
        app.state.storage.io.shutdown()
        app.state.index.close()


def test_media_permit_covers_response_send(monkeypatch):
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        sem = asyncio.Semaphore(1)
        async def slow_send(self, scope, send):
            entered.set()
            await release.wait()
        monkeypatch.setattr(LimitedFileResponse, '_stream', slow_send)
        async def receive():
            await asyncio.Event().wait()
        first = asyncio.create_task(LimitedFileResponse('/unused', semaphore=sem)({}, receive, None))
        await asyncio.wait_for(entered.wait(), 1)
        messages = []
        async def send(message):
            messages.append(message)
        await LimitedFileResponse('/unused', semaphore=sem)({'type': 'http'}, None, send)
        assert messages[0]['status'] == 503
        release.set()
        await first
        assert not sem.locked()
    asyncio.run(run())


def test_client_disconnect_cancels_media_read_and_releases_permit(monkeypatch):
    async def run():
        entered, cancelled = asyncio.Event(), asyncio.Event()
        sem = asyncio.Semaphore(1)
        async def slow_send(self, scope, send):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        async def receive():
            await entered.wait()
            return {'type': 'http.disconnect'}
        monkeypatch.setattr(LimitedFileResponse, '_stream', slow_send)
        await asyncio.wait_for(LimitedFileResponse('/unused', semaphore=sem)({}, receive, None), 1)
        assert cancelled.is_set()
        assert not sem.locked()
    asyncio.run(run())
