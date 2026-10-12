import importlib.util
from pathlib import Path
import json
import unittest
import tempfile

spec = importlib.util.spec_from_file_location('network_refresh', Path(__file__).parents[1] / 'configure-internal-network.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NetworkRefreshTest(unittest.TestCase):
    def test_changed_docker_subnet_preserves_explicit_remote_peers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, extra = root / 'policy', root / 'extra'
            extra.write_text('["192.168.100.182/32"]')
            self.assertTrue(module.update(policy, extra, discover_fn=lambda: ['172.19.0.0/16']))
            self.assertTrue(module.update(policy, extra, discover_fn=lambda: ['172.20.0.0/16']))
            self.assertEqual(json.loads(policy.read_text()), ['172.20.0.0/16', '192.168.100.182/32'])
            before = policy.stat().st_mtime_ns
            self.assertFalse(module.update(policy, extra, discover_fn=lambda: ['172.20.0.0/16']))
            self.assertEqual(before, policy.stat().st_mtime_ns)

    def test_invalid_manual_peers_do_not_replace_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, extra = root / 'policy', root / 'extra'
            policy.write_text('["172.19.0.0/16"]')
            extra.write_text('["0.0.0.0/0"]')
            with self.assertRaises(ValueError):
                module.update(policy, extra, discover_fn=lambda: ['172.20.0.0/16'])
            self.assertEqual(json.loads(policy.read_text()), ['172.19.0.0/16'])

    def test_remote_only_mode_never_requires_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extra = root / 'extra'
            extra.write_text('["192.168.100.182/32"]')
            def forbidden():
                raise AssertionError('Docker is not present on this remote-only host')
            module.update(root / 'policy', extra, static_only=True, discover_fn=forbidden)
            extra.write_text('[]')
            module.update(root / 'policy', extra, static_only=True, discover_fn=forbidden)
            self.assertEqual(json.loads((root / 'policy').read_text()), [])


if __name__ == '__main__':
    unittest.main()
