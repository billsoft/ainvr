import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('rotation', Path(__file__).with_name('rotate-consumer-keys.py'))
rotation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rotation)


class RotationTest(unittest.TestCase):
    def fixture(self, root):
        config = {'device_key': 'device-secret', 'machine_code': 'machine',
                  'admin_api_key': 'old-admin', 'signal_keys': {'ai': 'old-ai', 'recorder': 'old-rec'}}
        (root / 'license-service.yaml').write_text(json.dumps(config))
        (root / 'ai.env').write_text('LICENSE_SIGNAL_KEY=old-ai\nOTHER=unchanged\n')
        (root / 'rec.env').write_text('LICENSE_SIGNAL_KEY=old-rec\nLICENSE_ADMIN_API_KEY=old-admin\n')
        return config

    def test_consistent_rotation_preserves_device_and_other_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = self.fixture(root)
            changes = rotation.prepare(root)
            new = json.loads(changes[root / 'license-service.yaml'])
            self.assertEqual(new['device_key'], old['device_key'])
            self.assertEqual(new['machine_code'], old['machine_code'])
            self.assertNotEqual(new['admin_api_key'], old['admin_api_key'])
            self.assertIn('LICENSE_SIGNAL_KEY=' + new['signal_keys']['ai'], changes[root / 'ai.env'])
            self.assertIn('OTHER=unchanged', changes[root / 'ai.env'])
            self.assertEqual(json.loads((root / 'license-service.yaml').read_text()), old)

    def test_unknown_consumer_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = self.fixture(root)
            (root / 'ai.env').write_text('LICENSE_SIGNAL_KEY=unknown\n')
            with self.assertRaises(ValueError):
                rotation.prepare(root)
            self.assertEqual(json.loads((root / 'license-service.yaml').read_text()), old)

    def test_missing_consumer_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / 'ai.env').unlink()
            with self.assertRaises(ValueError):
                rotation.prepare(root)

    def test_stale_preparation_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            originals = {}
            changes = rotation.prepare(root, originals=originals)
            (root / 'ai.env').write_text('external update\n')
            with self.assertRaisesRegex(RuntimeError, 'Concurrent'):
                rotation.apply_changes(changes, originals, writer=lambda p, s: p.write_text(s))
            self.assertEqual((root / 'ai.env').read_text(), 'external update\n')
            self.assertEqual((root / 'rec.env').read_text(), originals[root / 'rec.env'])

    def test_unwritten_concurrent_file_is_preserved_and_own_write_rolled_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            originals = {}
            changes = rotation.prepare(root, originals=originals)
            first, second = list(changes)[:2]

            def writer(path, text):
                path.write_text(text)
                if path == first and text == changes[first]:
                    second.write_text('external update\n')

            with self.assertRaisesRegex(RuntimeError, 'Concurrent'):
                rotation.apply_changes(changes, originals, writer=writer)
            self.assertEqual(first.read_text(), originals[first])
            self.assertEqual(second.read_text(), 'external update\n')

    def test_concurrent_change_to_written_file_is_preserved_during_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            originals = {}
            changes = rotation.prepare(root, originals=originals)
            first, second = list(changes)[:2]

            def writer(path, text):
                if path == second:
                    first.write_text('external update\n')
                    raise OSError('write failure')
                path.write_text(text)

            with self.assertRaisesRegex(RuntimeError, 'Rollback incomplete'):
                rotation.apply_changes(changes, originals, writer=writer)
            self.assertEqual(first.read_text(), 'external update\n')
            self.assertEqual(second.read_text(), originals[second])

    def test_failure_after_rename_rolls_back_both_attempted_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            originals = {}
            changes = rotation.prepare(root, originals=originals)
            second = list(changes)[1]

            def writer(path, text):
                path.write_text(text)
                if path == second and text == changes[second]:
                    raise OSError('directory fsync failure')

            with self.assertRaisesRegex(OSError, 'fsync'):
                rotation.apply_changes(changes, originals, writer=writer)
            for path, text in originals.items():
                self.assertEqual(path.read_text(), text)


if __name__ == '__main__':
    unittest.main()
