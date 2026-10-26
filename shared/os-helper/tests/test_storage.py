import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).resolve().parents[1] / 'storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


def node(name, mounts, uuid='disk', children=None):
    return dict(name=name, path='/dev/'+name, fstype='ext4', uuid=uuid, mountpoints=mounts, children=children or [])


class StorageTests(unittest.TestCase):
    def test_system_siblings_excluded(self):
        tree = {'blockdevices': [node('sda', [], children=[node('sda1', ['/'], 'root'), node('sda2', ['/mnt/data'], 'data')]), node('sdb', ['/media/usb'])]}
        result = storage.volumes_from_tree(tree)
        self.assertEqual([v['device'] for v in result], ['/dev/sda1', '/dev/sdb'])
        self.assertFalse(result[0]['selectable'])
        self.assertTrue(result[1]['selectable'])

    def test_duplicate_uuid_not_selectable(self):
        result = storage.volumes_from_tree({'blockdevices': [node('sda', ['/mnt/a']), node('sdb', ['/mnt/b'])]})
        self.assertTrue(all(not v['selectable'] and v['state'] == 'ambiguous' for v in result))

    def test_unmounted_and_readonly(self):
        disk = node('sdb', ['/media/test']); disk['ro'] = True
        result = storage.volumes_from_tree({'blockdevices': [disk, node('sdc', [], 'other')]})
        self.assertTrue(all(not v['selectable'] for v in result))

    def test_traversal_rejected(self):
        for path in ('../etc', '/etc', 'a/../b', 'a//b'):
            with self.assertRaises(ValueError):
                storage.safe_directory('/not-needed', path)

    def test_system_fallback_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError): storage.safe_directory(directory, '')

    def test_no_automatic_mount(self):
        with patch.object(storage, 'inventory', return_value={'volumes': []}):
            with self.assertRaises(ValueError): storage.browse('unknown', '')


if __name__ == '__main__': unittest.main()
