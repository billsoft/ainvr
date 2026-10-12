#!/usr/bin/env python3
"""Factory-only migration. Authenticates legacy evidence; never edits board state."""
from __future__ import annotations
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import time
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from legacy_v2 import MAX_MINUTES, issue
from factory_material import HERE, load_master, normalize_code


def remaining_minutes(raw: bytes, old_master: bytes, chip_uid: str,
                      old_code: str, now: int) -> int:
    if len(raw) > 16384 or not chip_uid or type(now) is not int or now < 0:
        raise ValueError("旧状态证据无效")
    envelope = json.loads(raw)
    data = envelope["data"]
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"ainvr-state-v1",
               info=chip_uid.encode()).derive(old_master)
    expected = hmac.new(key, canonical, hashlib.sha256).hexdigest()
    if not isinstance(envelope.get("sig"), str) or not hmac.compare_digest(expected, envelope["sig"]):
        raise ValueError("旧状态认证失败，不能自动换发")
    if data["schema"] != 1 or normalize_code(data["fp"]) != normalize_code(old_code):
        raise ValueError("旧申请码或状态版本不匹配")
    if data["tampered"] is not False or data["mode"] not in ("wall", "uptime"):
        raise ValueError("旧状态异常，需要人工核验购买记录")
    for name in ("iat_min", "ttl_min", "max_wall_sec", "last_wall_sec", "used_uptime_sec"):
        if type(data[name]) is not int or data[name] < 0:
            raise ValueError("旧状态数值无效")
    if not 1 <= data["ttl_min"] <= MAX_MINUTES:
        raise ValueError("旧授权范围无效")
    # Migration adopts the new hybrid policy. Trusted factory time counts elapsed
    # offline time as well; never round remaining partial minutes upward.
    used = max(data["used_uptime_sec"],
               max(now, data["max_wall_sec"], data["last_wall_sec"]) - data["iat_min"] * 60, 0)
    minutes = max(0, (data["ttl_min"] * 60 - used) // 60)
    if not minutes:
        raise ValueError("旧授权没有可迁移的完整分钟")
    return minutes


def main():
    p = argparse.ArgumentParser(description="厂内核验旧状态并一次性换发 v2 剩余时长")
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--chip-uid", required=True)
    p.add_argument("--old-code", required=True)
    p.add_argument("--code", required=True, help="新 v2 申请码；必须人工核对同一物理板")
    p.add_argument("--legacy-secrets", type=Path, required=True)
    p.add_argument("--secrets", type=Path, default=HERE / "secrets" / "v2")
    p.add_argument("--ledger", type=Path)
    p.add_argument("--legacy-v2", action="store_true", help="仅用于维护尚未升级的历史 v2 设备")
    a = p.parse_args()
    if not a.legacy_v2:
        p.error("此工具只产生旧 v2 注册码；当前设备请按 docs/license-v3-design.md 恢复或迁移。历史操作需显式 --legacy-v2")
    try:
        minutes = remaining_minutes(a.state.read_bytes(), load_master(a.legacy_secrets),
                                    a.chip_uid, a.old_code, int(time.time()))
        # All state snapshots from one old device map to one migration receipt.
        identity = "v1:" + normalize_code(a.old_code)
        print(issue(load_master(a.secrets), a.code, minutes,
                    a.ledger or a.secrets / "issued-v2.sqlite3", migration_id=identity))
    except Exception as exc:
        p.exit(1, f"迁移失败：{exc}\n")


if __name__ == "__main__":
    main()
