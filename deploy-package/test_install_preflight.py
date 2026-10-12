"""Exercise installer ordering with fake root and system-writing commands."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'linux', 'Requires Linux bash')
class InstallPreflightTest(unittest.TestCase):
    def check_rejected_without_system_write(self, invalid_provision):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'bin'
            binary.mkdir()
            (root / 'install.sh').write_bytes(Path(__file__).with_name('install.sh').read_bytes())
            (root / 'audit_release.py').write_text('pass\n')
            (binary / 'id').write_text('#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else echo 1000; fi\n')
            for name in ('install', 'sysctl'):
                (binary / name).write_text('#!/bin/sh\necho called >> "$TEST_MARKER"\n')
            for path in binary.iterdir():
                path.chmod(0o755)
            marker = root / 'unexpected-system-write'
            provision = ''
            if invalid_provision:
                source = root / 'license-service' / 'deploy'
                source.mkdir(parents=True)
                (source / 'install.sh').write_text('#!/bin/sh\necho invalid-provision >&2\nexit 17\n')
                materials = root / 'materials'
                materials.mkdir()
                (materials / 'license-service.yaml').write_text('{}')
                provision = str(materials)
            env = {**os.environ, 'PATH': str(binary) + ':/usr/bin:/bin',
                   'LICENSE_PROVISION_DIR': provision, 'LAYOUT': 'home',
                   'TEST_MARKER': str(marker)}
            result = subprocess.run(['bash', str(root / 'install.sh')], env=env,
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('invalid-provision' if invalid_provision else 'Provide LICENSE_PROVISION_DIR',
                          result.stderr)
            self.assertFalse(marker.exists(), 'System tuning must follow credential validation')

    def test_missing_provision_does_not_change_system(self):
        self.check_rejected_without_system_write(False)

    def test_invalid_provision_does_not_change_system(self):
        self.check_rejected_without_system_write(True)


if __name__ == '__main__':
    unittest.main()
