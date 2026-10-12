#!/usr/bin/env python3
"""Offline issuer. Never distribute its private directory in a device release."""
from __future__ import annotations
import argparse
from contextlib import closing
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

MAX_MINUTES = 5256000
MAX_SEQUENCE = 9007199254740991
DEFAULT_HOME = Path.home() / ".ainvr-license-issuer" / "v3"

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def init_key(directory: Path) -> tuple[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "signing-private.pem"
    if path.exists():
        raise ValueError("签发私钥已存在，禁止覆盖；请备份现有私钥与台账")
    key = Ed25519PrivateKey.generate()
    data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data); f.flush(); os.fsync(f.fileno())
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    kid = hashlib.sha256(bytes.fromhex(pub)).hexdigest()[:16]
    (directory / "public.json").write_text(json.dumps({"kid": kid, "public_key": pub}, indent=2))
    return kid, pub

def read_request(value: str) -> dict:
    value = value.strip()
    if len(value) > 8192 or not value.startswith("AINVR-REQ3-"):
        raise ValueError("请复制完整 v3 授权申请，不能只输入短机器码")
    encoded = value[len("AINVR-REQ3-"):]
    data = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    if b64(data) != encoded:
        raise ValueError("申请编码无效")
    r = json.loads(data)
    if r.get("v") != 3 or r.get("product") != "AINVR":
        raise ValueError("申请版本无效")
    if not re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{24}", r.get("machine_code", "")):
        raise ValueError("机器码无效")
    if not re.fullmatch(r"[0-9a-f]{32}", r.get("installation_id", "")):
        raise ValueError("安装标识无效")
    floor = r.get("grant_floor")
    if type(floor) is not int or not 0 <= floor < MAX_SEQUENCE:
        raise ValueError("授权序号无效")
    if r.get("purpose") not in ("activate", "recover", "migrate"):
        raise ValueError("申请类型无效")
    challenge = r.get("challenge", "")
    if (r["purpose"] == "recover" and not re.fullmatch(r"[0-9a-f]{32}", challenge)) or (r["purpose"] != "recover" and challenge):
        raise ValueError("恢复挑战值无效")
    return r

def sign(key: Ed25519PrivateKey, payload: dict) -> str:
    encoded = b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    signature = key.sign(("AINVR/license/v3|" + encoded).encode())
    return "AINVR-LIC3-" + encoded + "." + b64(signature)

def issue(directory: Path, request: str, minutes: int, *, recovery: bool = False,
          migration: dict | None = None) -> str:
    r = read_request(request)
    if type(minutes) is not int or not 1 <= minutes <= MAX_MINUTES:
        raise ValueError("授权分钟数超出范围")
    if (r["purpose"] == "recover") != recovery:
        raise ValueError("恢复授权必须明确指定 --recover，并人工确认剩余权益")
    if (r["purpose"] == "migrate") != (migration is not None):
        raise ValueError("迁移申请必须提供旧授权权益记录")
    key = serialization.load_pem_private_key((directory / "signing-private.pem").read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("需要 Ed25519 私钥")
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    kid = hashlib.sha256(pub).hexdigest()[:16]
    request_id = hashlib.sha256(json.dumps([r, minutes, migration], sort_keys=True).encode()).hexdigest()
    ledger = directory / "issued-v3.sqlite3"
    with closing(sqlite3.connect(ledger, timeout=30)) as db:
        if os.name != "nt": os.chmod(ledger, 0o600)
        db.execute("PRAGMA synchronous=FULL")
        db.execute("CREATE TABLE IF NOT EXISTS grants (request_id TEXT PRIMARY KEY, machine TEXT, installation TEXT, sequence INTEGER, purpose TEXT, minutes INTEGER, issued_at INTEGER, token TEXT, UNIQUE(machine,sequence))")
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT token FROM grants WHERE request_id=?", (request_id,)).fetchone()
        if prior: return prior[0]
        previous = db.execute("SELECT COALESCE(MAX(sequence),0) FROM grants WHERE machine=?", (r["machine_code"],)).fetchone()[0]
        seq = max(previous, r["grant_floor"]) + 1
        payload = dict(v=3, product="AINVR", policy="hybrid_local", kid=kid,
                       machine_code=r["machine_code"], installation_id=r["installation_id"],
                       license_id=secrets.token_hex(16), grant_seq=seq, duration_minutes=minutes,
                       issued_at=int(time.time()), purpose=r["purpose"], challenge=r.get("challenge", ""),
                       legacy_token_hash="", activation_wall=0)
        if migration:
            if migration["total_seconds"] != minutes * 60 or migration["grant_seq"] <= previous:
                raise ValueError("迁移权益或授权序号与台账冲突")
            payload.update(license_id=migration["license_id"], grant_seq=migration["grant_seq"],
                           legacy_token_hash=migration["token_hash"], activation_wall=migration["activation_wall"])
        if payload["grant_seq"] > MAX_SEQUENCE: raise ValueError("授权序号耗尽")
        token = sign(key, payload)
        db.execute("INSERT INTO grants VALUES(?,?,?,?,?,?,?,?)",
                   (request_id,r["machine_code"],r["installation_id"],payload["grant_seq"],r["purpose"],minutes,payload["issued_at"],token))
        db.commit()
    return token

def main() -> None:
    p = argparse.ArgumentParser(description="AINVR v3 离线签名注册机（仅发行方运行）")
    p.add_argument("--private-dir", type=Path, default=DEFAULT_HOME)
    p.add_argument("--init-key", action="store_true")
    p.add_argument("--export-header", type=Path)
    p.add_argument("--request-file", type=Path)
    p.add_argument("--minutes", type=int)
    p.add_argument("--recover", action="store_true")
    p.add_argument("--migration-record", type=Path)
    p.add_argument("--output", type=Path)
    a = p.parse_args()
    try:
        if a.init_key: init_key(a.private_dir)
        if a.export_header:
            public = json.loads((a.private_dir / "public.json").read_text())
            a.export_header.write_text('#pragma once\nnamespace ainvr_license {\n'
                f'inline constexpr char kIssuerKeyId[] = "{public["kid"]}";\n'
                f'inline constexpr char kIssuerPublicKeyHex[] = "{public["public_key"]}";\n' + '}\n')
        if a.request_file:
            migration = json.loads(a.migration_record.read_text()) if a.migration_record else None
            token = issue(a.private_dir, a.request_file.read_text(), a.minutes, recovery=a.recover, migration=migration)
            if a.output: a.output.write_text(token + "\n")
            else: print(token)
        elif not (a.init_key or a.export_header): p.error("需要 --request-file 与 --minutes")
    except (ValueError, OSError, KeyError, sqlite3.Error) as e:
        p.exit(1, f"签发失败：{e}\n")

if __name__ == "__main__": main()
