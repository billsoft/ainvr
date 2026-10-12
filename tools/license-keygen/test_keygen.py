import base64
import concurrent.futures
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from legacy_v2 import issue, AAD
from factory_material import device_key, normalize_code
from gen_material import provision
CODE = "0123456789ABCDEFGHJKMNPQ"
MASTER = bytes(32)


def opened(token):
    value = token.removeprefix("AINVR-LIC-")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    return json.loads(AESGCM(device_key(MASTER, CODE)).decrypt(raw[:12], raw[12:], AAD))


def test_concurrent_issue_sequences_are_unique(tmp_path):
    ledger = tmp_path / "issuer.sqlite3"
    # Establish schema before exercising concurrent transactions.
    first = opened(issue(MASTER, CODE, 1, ledger))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda _: opened(issue(MASTER, CODE, 60, ledger)), range(8)))
    assert {v["grant_seq"] for v in [first, *values]} == set(range(1, 10))


def test_device_keys_are_different():
    assert device_key(MASTER, CODE) != device_key(MASTER, "1123456789ABCDEFGHJKMNPQ")


def test_provisioning_is_idempotent_and_does_not_export_master(tmp_path):
    provision(MASTER, CODE, tmp_path)
    first = (tmp_path / "license-service.yaml").read_bytes()
    provision(MASTER, CODE, tmp_path)
    assert (tmp_path / "license-service.yaml").read_bytes() == first
    assert not (tmp_path / "MASTER_KEY.local").exists()
    config = json.loads(first)
    assert len(set(config["signal_keys"].values())) == 4


def test_minutes_rejected_outside_range(tmp_path):
    import pytest
    for minutes in (0, -1, True, 5256001):
        with pytest.raises(ValueError):
            issue(MASTER, CODE, minutes, tmp_path / "ledger")
