import hashlib
import hmac
import json
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from migrate_v1 import remaining_minutes
from legacy_v2 import issue

CODE = "0123456789ABCDEFGHJKMNPQ"


def evidence(**changes):
    d = dict(schema=1, fp=CODE, tampered=False, mode="wall", iat_min=100,
             ttl_min=10, max_wall_sec=6100, last_wall_sec=6100, used_uptime_sec=100)
    d.update(changes)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"ainvr-state-v1", info=b"board").derive(bytes(32))
    sig = hmac.new(key, json.dumps(d, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
    return json.dumps(dict(data=d, sig=sig)).encode()


def test_migration_rounds_down_and_authenticates():
    assert remaining_minutes(evidence(), bytes(32), "board", CODE, 6101) == 8
    with pytest.raises(ValueError):
        remaining_minutes(evidence(), bytes([1])*32, "board", CODE, 6101)
    with pytest.raises(ValueError):
        remaining_minutes(evidence(tampered=True), bytes(32), "board", CODE, 6101)


def test_migration_cannot_reissue_from_another_snapshot(tmp_path):
    ledger = tmp_path / "issuer.db"
    a = issue(bytes(32), CODE, 8, ledger, migration_id="v1:" + CODE)
    assert a == issue(bytes(32), CODE, 10, ledger, migration_id="v1:" + CODE)
    with pytest.raises(ValueError):
        issue(bytes(32), "1123456789ABCDEFGHJKMNPQ", 10, ledger, migration_id="v1:" + CODE)
