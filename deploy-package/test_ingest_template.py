from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class IngestTemplateTests(unittest.TestCase):
    def test_template_survives_a_clean_checkout(self):
        relative = 'ingest-service/deploy/ainvr-ingest.service.example'
        self.assertTrue((ROOT / relative).is_file())
        result = subprocess.run(['git', 'check-ignore', '--quiet', relative], cwd=ROOT)
        self.assertEqual(result.returncode, 1)
        build = (ROOT / 'deploy-package/build-release.sh').read_text()
        self.assertIn('ingest-service/deploy/ainvr-ingest.service.example', build)
        self.assertIn('"$PYDST/ainvr-ingest.service"', build)
        unit = (ROOT / relative).read_text()
        self.assertIn('/etc/ainvr-ingest/service.env', unit)
        self.assertNotIn('INGEST_SERVICE_TOKEN=', unit)


if __name__ == '__main__':
    unittest.main()
