import tempfile
import unittest
from pathlib import Path
from audit_release import inventory


class V3ReleaseAuditTest(unittest.TestCase):
    def test_private_issuer_material_is_rejected_even_outside_secrets_directory(self):
        for name in ('signing-private.pem', 'issued-v3.sqlite3',
                     'issued-v3.sqlite3-wal', 'issued-v3.sqlite3-shm',
                     '.ainvr-license-issuer/v3/anything.txt'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root=Path(directory); p=root/name
                p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic')
                with self.assertRaisesRegex(ValueError,'Forbidden factory/live material'):
                    inventory(root)


if __name__ == '__main__': unittest.main()
