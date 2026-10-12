import asyncio
import io
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from recorder import sei_worker
from recorder.playback_sei import PlaybackSeiReader


def nal(payload, hevc=False):
    data = sei_worker.UUID + json.dumps(payload).encode()
    size = b'\xff' * (len(data) // 255) + bytes([len(data) % 255])
    return (b'\x4e\x01' if hevc else b'\x06') + b'\x05' + size + data + b'\x80'


@pytest.mark.parametrize('hevc', [False, True])
def test_preserves_empty_and_shared_payload_parser(hevc):
    payload = {'v': 1, 'det': [], 'pts': 99999999999}
    encoded = nal(payload, hevc)
    assert sei_worker.read_ainvr_sei(encoded, hevc) == payload
    assert not sei_worker.has_ainvr_sei(encoded, hevc)
    packet = len(encoded).to_bytes(4, 'big') + encoded
    assert sei_worker.packet_prefix_metadata(io.BytesIO(packet), 0, len(packet), 4, hevc) == payload


def test_window_uses_mp4_pts_and_does_not_read_picture(tmp_path, monkeypatch):
    encoded = nal({'v': 1, 'pts': 900000000000, 'det': []})
    packet = len(encoded).to_bytes(4, 'big') + encoded
    path = tmp_path / 'a.mp4'
    path.write_bytes(packet * 4)
    samples = [SimpleNamespace(pts=t, duration=.033, pos=i * len(packet), size=len(packet))
               for i, t in enumerate([9.6, 9.8, 10.1, 20.0])]
    monkeypatch.setattr(sei_worker.mp4_samples, 'read_video_samples',
                        lambda _: (SimpleNamespace(codec='h264', length_size=4), samples))
    frames = sei_worker.scan_frames(str(path), 10000, 20000)
    assert [f['timeMs'] for f in frames] == [9800, 10100]
    # Picture bytes are never loaded; only the first NAL byte is needed to stop.
    class Guard(io.BytesIO):
        def read(self, n=-1):
            assert n <= 5
            return super().read(n)
    picture = (1000000).to_bytes(4, 'big') + b'\x65'
    assert sei_worker.packet_prefix_metadata(Guard(picture), 0, 1000004, 4, False) is None


def test_rejects_unbounded_windows():
    with pytest.raises(ValueError):
        sei_worker.scan_frames('unused', 0, 10001)


@pytest.mark.asyncio
async def test_busy_or_blocked_child_does_not_spawn_more_workers():
    reader = PlaybackSeiReader()
    reader.proc = SimpleNamespace(returncode=None)
    with pytest.raises(HTTPException) as error:
        await reader.read('unused', ('id', 1), 0)
    assert error.value.status_code == 503
    reader.proc = None
    async with reader.lock:
        with pytest.raises(HTTPException):
            await reader.read('unused', ('id', 1), 0)


@pytest.mark.asyncio
async def test_timeout_kills_worker_and_does_not_cache_empty(monkeypatch):
    reader = PlaybackSeiReader()
    killed = []
    class Process:
        returncode = None
        async def communicate(self):
            raise asyncio.TimeoutError()
        def kill(self):
            killed.append(True)
    async def create(*args, **kwargs):
        return Process()
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', create)
    with pytest.raises(HTTPException):
        await reader.read('unused', ('id', 1), 0)
    assert killed == [True]
    assert not reader.cache


@pytest.mark.asyncio
async def test_cache_is_scoped_by_storage_and_window(monkeypatch):
    reader = PlaybackSeiReader()
    calls = []
    class Process:
        returncode = 0
        async def communicate(self):
            return b'[]', b''
    async def create(*args, **kwargs):
        calls.append(args)
        return Process()
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', create)
    for key, start in [(('id', 1), 0), (('id', 1), 0), (('id', 2), 0), (('id', 2), 10000)]:
        assert await reader.read('unused', key, start) == []
    assert len(calls) == 3


def test_endpoint_auth_and_deleted_segment(client, monkeypatch):
    assert client.get('/v1/recordings/missing/sei').status_code == 404
    assert client.get('/v1/recordings/missing/sei?from_ms=-1').status_code == 422
    monkeypatch.setattr('recorder.auth._authorize', lambda *_: 401)
    assert client.get('/v1/recordings/missing/sei').status_code == 401


def test_endpoint_window_and_storage_guard(client, store, monkeypatch):
    from test_media_circuit import _seed_segment
    seg_id = _seed_segment(client, store)
    async def read(self, path, key, start_ms):
        assert start_ms == 10000
        return [{'timeMs': 10500, 'payload': {'v': 1, 'det': []}}]
    monkeypatch.setattr(PlaybackSeiReader, 'read', read)
    response = client.get(f'/v1/recordings/{seg_id}/sei?from_ms=12345')
    assert response.status_code == 200
    assert response.json()['frames'][0]['payload']['det'] == []
    assert response.headers['cache-control'] == 'no-store'
    client.app.state.storage.status.storage_id = 'different-storage'
    assert client.get(f'/v1/recordings/{seg_id}/sei').status_code == 410
