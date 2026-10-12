import asyncio
import os
from unittest.mock import patch

from recorder.playback_protection import PlaybackProtection
from recorder.quota import QuotaEnforcer
from recorder.config import QuotaConfig
from test_quota import _setup, _add_segment
from test_media_circuit import _seed_segment


def test_read_lease_delete_reservation_and_expiry():
    protection = PlaybackProtection(ttl=10)
    with patch('recorder.playback_protection.time.monotonic', return_value=100):
        assert protection.touch('seg')
        assert not protection.begin_delete('seg')
    with protection.reader('seg'):
        with patch('recorder.playback_protection.time.monotonic', return_value=1000):
            assert not protection.begin_delete('seg')
    with patch('recorder.playback_protection.time.monotonic', return_value=10**12):
        assert protection.begin_delete('seg')
        assert not protection.touch('seg')
        protection.end_delete('seg')
        assert protection.touch('seg')


def test_quota_skips_playing_segment(tmp_path):
    store, index, storage, root = _setup(tmp_path, QuotaConfig(mode='gb', gb=1))
    _add_segment(index, root, 'ch', 'old', 10, 600)
    _add_segment(index, root, 'ch', 'new', 9, 600)
    old = next(row for row in index.all_segments() if row['channelName'] == 'old')
    protection = PlaybackProtection()
    protection.touch(old['id'])
    try:
        assert asyncio.run(QuotaEnforcer(store, index, storage, protection).enforce('local')) == 1
        assert index.get(old['id']) is not None
        assert os.path.exists(os.path.join(root, old['relPath']))
    finally:
        storage.shutdown()
        index.close()


def test_missing_file_is_removed_from_index_immediately(client, store):
    seg = _seed_segment(client, store)
    assert client.get(f'/v1/recordings/{seg}/availability').status_code == 200
    row = client.app.state.index.get(seg)
    os.unlink(os.path.join(store.get().recording.storage.localPath, row['relPath']))
    assert client.get(f'/v1/recordings/{seg}/availability').status_code == 410
    assert client.app.state.index.get(seg) is None


def test_unreadable_storage_keeps_index(client, store):
    seg = _seed_segment(client, store)
    async def denied(*args, **kwargs):
        raise PermissionError('NAS access failure')
    with patch.object(client.app.state.storage.io, 'run', denied):
        assert client.get(f'/v1/recordings/{seg}/availability').status_code == 503
    assert client.app.state.index.get(seg) is not None
