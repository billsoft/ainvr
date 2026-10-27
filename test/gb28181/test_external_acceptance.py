"""Regression checks for the external topology's TLS negative oracle."""
import ssl
import unittest
import urllib.error
from unittest.mock import MagicMock, Mock

from external_acceptance import require_certificate_rejection


class CertificateNegativeTests(unittest.TestCase):
    def test_requires_actual_certificate_verification_failure(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(ssl.SSLCertVerificationError(1, 'untrusted certificate'))
        require_certificate_rejection(opener, 'https://fixture.invalid/')

    def test_http_authentication_failure_does_not_prove_certificate_check(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError('https://fixture.invalid/', 401, 'Unauthorized', {}, None)
        with self.assertRaisesRegex(AssertionError, 'Expected certificate'):
            require_certificate_rejection(opener, 'https://fixture.invalid/')

    def test_connection_failure_does_not_prove_certificate_check(self):
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(ConnectionRefusedError('not listening'))
        with self.assertRaisesRegex(AssertionError, 'Expected certificate'):
            require_certificate_rejection(opener, 'https://fixture.invalid/')

    def test_successful_tls_is_rejected_and_response_closed(self):
        opener = MagicMock()
        with self.assertRaisesRegex(AssertionError, 'Unknown HTTPS certificate'):
            require_certificate_rejection(opener, 'https://fixture.invalid/')
        opener.open.return_value.__exit__.assert_called_once()


if __name__ == '__main__':
    unittest.main()
