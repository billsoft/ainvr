import asyncio
from recorder.config import StorageConfig, SmbConfig
from recorder.storage_identity import storage_identity
from test_scanner_reconcile import setup


def test_identity_tracks_path_not_credentials():
    cfg = StorageConfig(kind='smb', smb=SmbConfig(host='nas', share='video', path='one', password='old'))
    original = storage_identity(cfg)
    cfg.smb.password = 'new'
    assert storage_identity(cfg) == original
    cfg.smb.path = 'two'
    assert storage_identity(cfg) != original
    assert storage_identity(StorageConfig(localPath='/one')) != storage_identity(StorageConfig(localPath='/two'))


def test_switching_same_kind_storage_preserves_previous_index(tmp_path):
    index, storage, scanner = setup(tmp_path)
    try:
        row = index.get('missing')
        index.activate_storage('aaaa')
        index.upsert_segment({**row, 'storageId': 'aaaa'})
        assert index.used_bytes('local') == 100
        index.activate_storage('bbbb')
        storage.status.storage_id = 'bbbb'
        asyncio.run(scanner.scan_once())
        asyncio.run(scanner.scan_once())
        assert index.get('missing') is not None
        assert index.used_bytes('local') == 0
        index.activate_storage('aaaa')
        assert index.used_bytes('local') == 100
    finally:
        storage.io.shutdown()
        index.close()
