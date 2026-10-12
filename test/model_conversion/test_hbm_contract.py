"""Check the deployment input contract independently of compiler availability."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ContractTest(unittest.TestCase):
    def test_detection_normalization_matches_exported_zero_to_one_input(self):
        for kind in ('face', 'coco80'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                model = root / 'fixture.hbm'
                model.write_bytes(b'interface-test-only-not-a-real-model')
                digest = hashlib.sha256(model.read_bytes()).hexdigest()
                tensor = {'dtype_id': 7, 'quantization': 0}
                description = {'provider': 'bpu', 'format': 'hbm',
                    'inputs': [dict(tensor, name='images', shape=[1, 3, 640, 640])],
                    'outputs': [dict(tensor, name='output', shape=[1, 300, 6])]}
                (root / 'description.json').write_text('SDK banner\n' + json.dumps(description, indent=2))
                (root / 'placement.json').write_text(json.dumps({
                    'hbm_sha256': digest, 'placement_passed': True}))
                (root / 'export.json').write_text(json.dumps({'passed': True,
                    'source_unchanged': True, 'onnx_sha256': 'test-only',
                    'class_names': ['person'] + ['class-' + str(i) for i in range(79)]}))
                subprocess.run([sys.executable, str(Path(__file__).with_name('make_hbm_contract.py')),
                    '--model', str(model), '--description', str(root / 'description.json'),
                    '--placement', str(root / 'placement.json'), '--kind', kind,
                    '--export-summary', str(root / 'export.json'),
                    '--output', str(root / 'contract.json')], check=True, capture_output=True)
                contract = json.loads((root / 'contract.json').read_text())
                prep = contract['preprocess']
                self.assertTrue(prep['normalize'])
                self.assertTrue(prep['rgb_order'])
                for mean, divisor in zip(prep['mean'], prep['std']):
                    self.assertEqual((0 - mean) / divisor, 0)
                    self.assertEqual((255 - mean) / divisor, 1)
                    self.assertAlmostEqual((114 - mean) / divisor, 114 / 255)
                self.assertFalse(contract['accuracy_verified'])
                self.assertFalse(contract['production_approved'])


if __name__ == '__main__':
    unittest.main()
