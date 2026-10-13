import asyncio
import os
import time
from datetime import datetime
from unittest.mock import patch

from recorder.index import SegmentIndex
from recorder.scanner import CatalogResolver, Scanner
from recorder.storage import StorageManager


def setup(tmp_path):
    index = SegmentIndex(str(tmp_path / 'index.db'))
    storage = StorageManager()
    storage.status.root = str(tmp_path / 'videos')
    (tmp_path / 'videos').mkdir()
    storage.status.kind = 'local'
    storage.status.healthy = True
    scanner = Scanner(index, storage, CatalogResolver(), 60)
    for id_, kind in [('missing', 'local'), ('other', 'smb')]:
        index.upsert_segment(dict(id=id_, channelId='ch', channelName='camera', streamName='s',
            startTs=1000, endTs=61000, durationMs=60000, sizeBytes=100, codec='h264',
            storage=kind, relPath='20260918/missing.mp4', complete=True))
    return index, storage, scanner


def test_local_probe_timeout_does_not_stop_recording(tmp_path):
    index, storage, scanner = setup(tmp_path)
    day = tmp_path / 'videos' / '20260918'
    day.mkdir()
    (day / 'ch_camera_20260918_100000.mp4').write_bytes(b'video')

    async def run():
        await scanner.resolver.update([dict(id='ch', name='camera', streamName='s')])
        with patch('recorder.scanner.ffprobe', side_effect=asyncio.TimeoutError):
            await scanner.scan_once()
        assert storage.status.healthy
        assert not storage.io.tripped

    try:
        asyncio.run(run())
    finally:
        storage.shutdown()
        index.close()


def test_manual_delete_reconciles_only_current_storage_even_when_quota_stopped(tmp_path):
    index, storage, scanner = setup(tmp_path)
    storage.status.quota_stopped = True
    async def run():
        await scanner.scan_once()
        assert index.get('missing') is not None
        await scanner.scan_once()
        assert index.get('missing') is None
        assert index.get('other') is not None
        assert index.used_bytes('local') == 0
    try:
        asyncio.run(run())
    finally:
        storage.io.shutdown()
        index.close()


def test_nas_clock_skew_does_not_reverse_segment_completion(tmp_path):
    index, storage, scanner = setup(tmp_path)
    day = tmp_path / 'videos' / '20260918'
    day.mkdir()
    old = day / 'ch_camera_20260918_100000.mp4'
    new = day / 'ch_camera_20260918_100100.mp4'
    old.write_bytes(b'old')
    new.write_bytes(b'new')
    now = datetime(2026, 9, 18, 10, 5).timestamp()
    # NAS times are both in the future and in the wrong chronological order.
    os.utime(old, (now + 86410, now + 86410))
    os.utime(new, (now + 86400, now + 86400))
    async def run():
        await scanner.resolver.update([dict(id='ch', name='camera', streamName='s')])
        with patch('recorder.scanner.time.time', return_value=now), patch('recorder.scanner.ffprobe', return_value={'format': {'duration': '60'}}):
            await scanner.scan_once()
            rows = {r['relPath']: r for r in index.all_segments()}
            assert rows['20260918/' + old.name]['complete']
            assert not rows['20260918/' + new.name]['complete']
            await scanner.scan_once()
            rows = {r['relPath']: r for r in index.all_segments()}
            assert rows['20260918/' + new.name]['complete']
    try:
        asyncio.run(run())
    finally:
        storage.shutdown()
        index.close()


def test_failed_or_partial_scan_never_prunes_and_resets_confirmation(tmp_path):
    index, storage, scanner = setup(tmp_path)
    async def run():
        await scanner.scan_once()
        with patch('recorder.scanner._collect_files', side_effect=PermissionError('unreadable day')):
            await scanner.scan_once()
        await scanner.scan_once()
        assert index.get('missing') is not None
        await scanner.scan_once()
        assert index.get('missing') is None
    try:
        asyncio.run(run())
    finally:
        storage.io.shutdown()
        index.close()


def test_unhealthy_storage_preserves_index(tmp_path):
    index, storage, scanner = setup(tmp_path)
    storage.status.healthy = False
    try:
        asyncio.run(scanner.scan_once())
        asyncio.run(scanner.scan_once())
        assert index.get('missing') is not None
    finally:
        storage.io.shutdown()
        index.close()


def test_storage_generation_change_during_scan_preserves_index(tmp_path):
    index, storage, scanner = setup(tmp_path)
    async def run():
        await scanner.scan_once()
        def changed(root):
            storage.io.reset('changed during enumeration')
            return []
        with patch('recorder.scanner._collect_files', side_effect=changed):
            await scanner.scan_once()
        assert index.get('missing') is not None
    try:
        asyncio.run(run())
    finally:
        storage.io.shutdown()
        index.close()


def test_catalog_arrives_late_and_old_duplicate_identity_is_repaired(tmp_path):
    index, storage, scanner = setup(tmp_path)
    day = tmp_path / 'videos' / '20260918'
    day.mkdir()
    media = day / 'ch_camera_20260918_100000.mp4'
    media.write_bytes(b'mock mp4')
    os.utime(media, (time.time() - 200, time.time() - 200))
    probe = {'streams': [{'codec_type': 'video', 'codec_name': 'h264'}], 'format': {'duration': '60'}}
    async def run():
        with patch('recorder.scanner.ffprobe', return_value=probe):
            await scanner.scan_once()
            assert not any(r['relPath'].endswith(media.name) for r in index.all_segments())
            await scanner.resolver.update([{'id': 'ch', 'name': 'camera', 'streamName': 's'}])
            await scanner.scan_once()
            row = next(r for r in index.all_segments() if r['relPath'].endswith(media.name))
            # 模拟旧版本遗留的错误身份和重复行，绕过新 upsert 的去重逻辑。
            index.conn.execute('UPDATE segments SET id=?,channel_id=? WHERE id=?',
                               ('bad-id', 'ch_camera', row['id']))
            index.conn.commit()
            await scanner.scan_once()
            fixed = [r for r in index.all_segments() if r['relPath'].endswith(media.name)]
            assert len(fixed) == 1 and fixed[0]['channelId'] == 'ch'
            index.upsert_segment({**fixed[0], 'id': 'replacement'})
            assert len([r for r in index.all_segments() if r['relPath'].endswith(media.name)]) == 1
    try:
        asyncio.run(run())
    finally:
        storage.io.shutdown()
        index.close()


def test_initialization_only_file_is_not_fabricated_into_playable_segment(tmp_path):
    index, storage, scanner = setup(tmp_path)
    day = tmp_path / 'videos' / '20260918'
    day.mkdir()
    video = day / 'ch_camera_20260918_100000.mp4'
    video.write_bytes(b'initialization-only')
    async def run():
        await scanner.resolver.update([dict(id='ch', name='camera', streamName='s', kind='ai')])
        for probe in ({'format': {}}, {'format': {'duration': '0.000000'}}):
            with patch('recorder.scanner.ffprobe', return_value=probe):
                await scanner.scan_once()
            assert not any(r['relPath'].endswith(video.name) for r in index.all_segments())
            assert video.read_bytes() == b'initialization-only'
        video.write_bytes(b'initialization-only plus actual samples')
        with patch('recorder.scanner.ffprobe', return_value={'format': {'duration': '0.033333'}}):
            await scanner.scan_once()
        rows=[r for r in index.all_segments() if r['relPath'].endswith(video.name)]
        assert len(rows)==1 and rows[0]['durationMs']==33
    try:
        asyncio.run(run())
    finally:
        storage.shutdown();index.close()
