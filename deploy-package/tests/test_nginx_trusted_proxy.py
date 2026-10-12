"""Opt-in isolated nginx integration: AINVR_TEST_NGINX_IMAGE=<built frontend>."""
import os
import subprocess
import unittest

IMAGE = os.environ.get('AINVR_TEST_NGINX_IMAGE')
COMMAND = r'''
set -eu
printf '%s\n' 'server { listen 8080; access_log off; location / { return 200 "$remote_addr|$console_forwarded_proto"; } }' > /etc/nginx/conf.d/default.conf
/docker-entrypoint.d/25-trusted-proxy.sh
nginx
wget -qO- --header 'X-Forwarded-For: 192.0.2.5' --header 'X-Forwarded-Proto: https' http://127.0.0.1:8080/
'''


@unittest.skipUnless(IMAGE, 'Set AINVR_TEST_NGINX_IMAGE to run isolated Docker tests')
class NginxProxyTest(unittest.TestCase):
    def run_proxy(self, peers):
        return subprocess.run(['docker', 'run', '--rm', '--network', 'none',
            '-e', 'TRUSTED_EDGE_PROXY_CIDRS=' + peers, '--entrypoint', 'sh', IMAGE,
            '-c', COMMAND], capture_output=True, text=True, timeout=30)

    def test_untrusted_headers_cannot_forge_ip_or_https(self):
        result = self.run_proxy('')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '127.0.0.1|http')

    def test_explicit_proxy_preserves_original_client_and_https(self):
        result = self.run_proxy('127.0.0.1/32')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '192.0.2.5|https')

    def test_wildcard_trust_is_rejected(self):
        result = self.run_proxy('0.0.0.0/0')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
