"""Historical v1/v2 migration fixtures only; current devices reject these tokens."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from factory_material import device_key, normalize_code
AAD = b"AINVR/license/v2"
MAX_MINUTES = 5256000

def seal(key: bytes, payload: dict) -> str:
    iv = secrets.token_bytes(12)
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return "AINVR-LIC-" + base64.urlsafe_b64encode(iv + AESGCM(key).encrypt(iv, raw, AAD)).rstrip(b"=").decode()


def issue(master: bytes, code: str, minutes: int, ledger: Path, *, migration_id: str | None = None) -> str:
    code = normalize_code(code)
    if type(minutes) is not int or not 1 <= minutes <= MAX_MINUTES:
        raise ValueError(f"授权分钟数必须为1~{MAX_MINUTES}")
    ledger.parent.mkdir(parents=True, exist_ok=True)
    # Serializes concurrent issuers and records the exact token before delivery.
    with sqlite3.connect(ledger, timeout=30) as db:
        if os.name != "nt":
            os.chmod(ledger, 0o600)
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS grants (machine TEXT, sequence INTEGER, license_id TEXT UNIQUE, token TEXT, issued_at INTEGER, PRIMARY KEY(machine,sequence))")
        db.execute("CREATE TABLE IF NOT EXISTS migrations (source TEXT PRIMARY KEY, machine TEXT, token TEXT)")
        db.execute("BEGIN IMMEDIATE")
        if migration_id:
            previous = db.execute("SELECT machine,token FROM migrations WHERE source=?", (migration_id,)).fetchone()
            if previous:
                if previous[0] != code:
                    raise ValueError("旧授权已迁移到另一申请码")
                return previous[1]
        seq = db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM grants WHERE machine=?", (code,)).fetchone()[0]
        if seq > 9007199254740991:
            raise ValueError("签发序号耗尽")
        payload = {"v": 2, "product": "AINVR", "policy": "hybrid_local",
                   "machine_code": code, "license_id": secrets.token_hex(16),
                   "grant_seq": seq, "duration_minutes": minutes, "issued_at": int(time.time())}
        token = seal(device_key(master, code), payload)
        db.execute("INSERT INTO grants VALUES(?,?,?,?,?)", (code, seq, payload["license_id"], token, payload["issued_at"]))
        if migration_id:
            db.execute("INSERT INTO migrations VALUES(?,?,?)", (migration_id, code, token))
        db.commit()
    return token


