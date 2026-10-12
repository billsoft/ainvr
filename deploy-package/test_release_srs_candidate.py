import tempfile
import unittest
from pathlib import Path

from audit_release import SRS_CONF, check_srs_conf, inventory


def write(root, text):
    p = Path(root) / SRS_CONF
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')


class ReleaseSrsCandidateTest(unittest.TestCase):
    def test_automatic_candidate_passes(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, 'rtc_server {\n    # candidate 说明注释\n    candidate       *;\n    use_auto_detect_network_ip off;\n}\n')
            check_srs_conf(Path(d))

    def test_build_machine_address_is_rejected(self):
        for value in ('192.168.100.183', '$CANDIDATE'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as d:
                write(d, f'rtc_server {{\n    candidate       {value};\n}}\n')
                with self.assertRaisesRegex(ValueError, 'automatic WebRTC candidate'):
                    inventory(Path(d))

    def test_repository_default_is_automatic(self):
        repo = Path(__file__).resolve().parents[1]
        conf = (repo / 'srs-web-console/deploy/srs-conf/srs.conf').read_text(encoding='utf-8')
        with tempfile.TemporaryDirectory() as d:
            write(d, conf)
            check_srs_conf(Path(d))
        self.assertIn('use_auto_detect_network_ip off;', conf)
        build = (repo / 'deploy-package/build-release.sh').read_text(encoding='utf-8')
        self.assertIn('candidate       *;|', build)  # 打包时强制还原为自动

    def test_entrypoint_no_longer_overrides_candidate(self):
        repo = Path(__file__).resolve().parents[1]
        entry = (repo / 'srs-web-console/deploy/srs-entrypoint.sh').read_text(encoding='utf-8')
        self.assertNotIn('$CANDIDATE', entry)
        self.assertNotIn('sed -i', entry)


if __name__ == '__main__':
    unittest.main()
