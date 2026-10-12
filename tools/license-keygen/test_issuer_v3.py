import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

spec = importlib.util.spec_from_file_location("issuer_v3", Path(__file__).with_name("issuer_v3.py"))
issuer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issuer)

class IssuerV3Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.kid, self.pub = issuer.init_key(self.directory)
        self.request = dict(v=3, product="AINVR", machine_code="0"*24,
                            installation_id="a"*32, grant_floor=0, purpose="activate", challenge="")

    def code(self):
        return "AINVR-REQ3-" + issuer.b64(json.dumps(self.request).encode())

    def test_signature_and_idempotent_ledger(self):
        token = issuer.issue(self.directory, self.code(), 60)
        self.assertEqual(token, issuer.issue(self.directory, self.code(), 60))
        encoded, signature = token[len("AINVR-LIC3-"):].split(".")
        import base64
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(self.pub)).verify(
            base64.urlsafe_b64decode(signature+"=="), ("AINVR/license/v3|"+encoded).encode())

    def test_recovery_is_explicit_and_sequence_increases(self):
        issuer.issue(self.directory, self.code(), 60)
        self.request.update(purpose="recover", challenge="b"*32, grant_floor=1)
        with self.assertRaises(ValueError): issuer.issue(self.directory, self.code(), 30)
        token = issuer.issue(self.directory, self.code(), 30, recovery=True)
        import base64
        raw=token[len("AINVR-LIC3-"):].split(".")[0]
        self.assertEqual(json.loads(base64.urlsafe_b64decode(raw+"="*(-len(raw)%4)))["grant_seq"],2)

    def test_private_key_not_overwritten_and_numeric_bounds(self):
        with self.assertRaises(ValueError): issuer.init_key(self.directory)
        for minutes in [0, True, 5256001]:
            with self.assertRaises(ValueError): issuer.issue(self.directory, self.code(), minutes)

if __name__ == "__main__": unittest.main()
