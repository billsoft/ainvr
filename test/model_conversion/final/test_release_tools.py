"""No compiler execution: verify the release entry rejects wrong inputs."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from run_approved_recipe import command


class RecipeSafety(unittest.TestCase):
    def test_valid_pinned_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'model.bc').write_bytes(b'fixture')
            recipe = dict(checkpoint_file='model.bc', bc_sha256=hashlib.sha256(b'fixture').hexdigest(),
                          opt=2, jobs=2, filename='model.hbm')
            args = command(recipe, root, root / 'new', root)
            self.assertIn('--expected-sha256', args)
            self.assertEqual(args[-1], 'model.hbm')
            self.assertFalse((root / 'new').exists())

    def test_wrong_hash_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'model.bc').write_bytes(b'wrong model')
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                command(dict(checkpoint_file='model.bc', bc_sha256='0' * 64), root, root/'new', root)

    def test_missing_checkpoint_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'Missing'):
                command(dict(checkpoint_file='missing.bc'), root, root/'new', root)

    def test_existing_output_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'model.bc').write_bytes(b'fixture')
            (root / 'existing').mkdir()
            with self.assertRaisesRegex(ValueError, 'already exists'):
                command(dict(checkpoint_file='model.bc', bc_sha256=hashlib.sha256(b'fixture').hexdigest()),
                        root, root/'existing', root)


if __name__ == '__main__':
    unittest.main()
