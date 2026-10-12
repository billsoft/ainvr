import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

import model_package as mp


def make_models(root, files):
    models = Path(root) / 'models'
    models.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        p = models / name
        p.write_bytes(data)
        os.utime(p, (1_700_000_000, 1_700_000_000))
    return models


def pack(models, archive):
    with tarfile.open(archive, 'w:gz', dereference=True) as tar:
        tar.add(models, arcname='models')
    return archive


class ModelPackageReuseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / 'out'
        self.out.mkdir()
        self.models = make_models(self.root / 'ai', {'a.onnx': b'aaa', 'b.engine': b'bbbb'})

    def tearDown(self):
        self.tmp.cleanup()

    def test_unchanged_models_reuse_latest_archive_and_cache_fingerprint(self):
        old = pack(self.models, self.out / 'models-20261001-000000.tar.gz')
        new = pack(self.models, self.out / 'models-20261007-185723.tar.gz')
        self.assertEqual(mp.find_reusable(self.out, self.models), new)
        sidecar = mp.sidecar(new)
        self.assertTrue(sidecar.is_file())  # 旧包第一次从包内容算出指纹并缓存，下次不再解压
        self.assertEqual(json.loads(sidecar.read_text())['files'], mp.source_fingerprint(self.models))
        self.assertFalse(mp.sidecar(old).exists())  # 找到最新的就停，不碰更早的包

    def test_changed_size_content_or_new_file_means_repack(self):
        pack(self.models, self.out / 'models-20261007-185723.tar.gz')
        (self.models / 'b.engine').write_bytes(b'bbbbb')
        self.assertIsNone(mp.find_reusable(self.out, self.models))
        make_models(self.root / 'ai', {'b.engine': b'bbbb', 'c.onnx': b'c'})
        self.assertIsNone(mp.find_reusable(self.out, self.models))

    def test_touched_file_means_repack(self):
        pack(self.models, self.out / 'models-20261007-185723.tar.gz')
        os.utime(self.models / 'a.onnx', (1_800_000_000, 1_800_000_000))
        self.assertIsNone(mp.find_reusable(self.out, self.models))

    def test_record_fingerprint_after_fresh_pack(self):
        archive = pack(self.models, self.out / 'models-20261008-120000.tar.gz')
        mp.record_fingerprint(archive, self.models)
        self.assertEqual(mp.find_reusable(self.out, self.models), archive)

    def test_symlinked_or_broken_archives_are_never_reused(self):
        real = pack(self.models, self.root / 'elsewhere.tar.gz')
        (self.out / 'models-20261009-000000.tar.gz').symlink_to(real)
        (self.out / 'models-20261010-000000.tar.gz').write_bytes(b'not a tar')
        self.assertIsNone(mp.find_reusable(self.out, self.models))

    def test_stale_sidecar_does_not_override_real_content(self):
        archive = pack(self.models, self.out / 'models-20261007-185723.tar.gz')
        mp.sidecar(archive).write_text(json.dumps({'files': [['models/x', 1, 1]]}))
        self.assertIsNone(mp.find_reusable(self.out, self.models))


if __name__ == '__main__':
    unittest.main()
