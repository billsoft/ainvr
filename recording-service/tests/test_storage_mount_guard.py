from io import StringIO
from unittest.mock import patch
import pytest
from recorder.storage import external_local_mount, StorageError, StorageManager


def test_missing_external_disk_never_accepts_root_mount():
    with patch('builtins.open', return_value=StringIO('/dev/mmcblk0p17 / ext4 rw 0 0\n')):
        with pytest.raises(StorageError, match='不会回落'):
            external_local_mount('/mnt/recording-disk/recordings')


def test_usb_mount_space_is_decoded():
    with patch('builtins.open', return_value=StringIO('/dev/sdb1 /media/My\\040Disk ext4 rw 0 0\n')):
        assert external_local_mount('/media/My Disk/recordings') == ('/media/My Disk', '/dev/sdb1')


def test_readonly_disk_rejected():
    with patch('builtins.open', return_value=StringIO('/dev/sdb1 /mnt/disk ext4 ro 0 0\n')):
        with pytest.raises(StorageError): external_local_mount('/mnt/disk/recordings')


def test_different_device_at_same_mount_rejected():
    manager = StorageManager()
    try:
        manager.status.kind = 'local'; manager.status.root = '/mnt/disk/recordings'
        manager._local_mount = ('/mnt/disk', '/dev/sdb1')
        with patch('builtins.open', return_value=StringIO('/dev/sdc1 /mnt/disk ext4 rw 0 0\n')):
            with pytest.raises(StorageError, match='已更换'): manager.active_root()
    finally: manager.shutdown()

