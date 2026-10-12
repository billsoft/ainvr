#!/usr/bin/env python3
"""Factory-only provisioning: no factory master or issuer ledger ships to a board."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import secrets
from factory_material import device_key, load_master, normalize_code, HERE

CLIENTS = ("ai-service", "recorder", "console-backend", "enforcer")


def private_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())


def provision(master: bytes, code: str, output: Path) -> None:
    code = normalize_code(code)
    output.mkdir(parents=True, exist_ok=True)
    config_path = output / "license-service.yaml"
    if config_path.exists():
        existing = json.loads(config_path.read_text())
        if existing["machine_code"] != code or existing["device_key"] != device_key(master, code).hex():
            raise ValueError("供应目录属于其他设备或其他主密钥，拒绝覆盖")
        config = existing
        if 'installation_path' not in config:
            raise ValueError("旧供应包缺少 installation_path；保留原密钥，显式补充安装登记路径后重试")
    else:
        config = {"host": "127.0.0.1", "port": 8001, "machine_code": code,
                  "installation_path": "/var/lib/ainvr-license-identity/identity.json",
                  "device_key": device_key(master, code).hex(),
                  "admin_api_key": secrets.token_hex(32),
                  "signal_keys": {cid: secrets.token_hex(32) for cid in CLIENTS}}
        private_write(config_path, json.dumps(config, indent=2) + "\n")
    for cid in CLIENTS:
        path = output / f"{cid}.env"
        body = (f"AINVR_PROFILE=production\nLICENSE_ENABLED=true\nLICENSE_DEVICE_ID={code}\n"
                f"LICENSE_SIGNAL_KEY={config['signal_keys'][cid]}\n"
                "LICENSE_UDS_PATH=/run/ainvr-license/license.sock\n")
        if cid == "console-backend":
            body += f"LICENSE_ADMIN_API_KEY={config['admin_api_key']}\n"
        if path.exists():
            if path.read_text() != body:
                raise ValueError(f"{path.name} 已被修改，拒绝覆盖")
        else:
            private_write(path, body)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成厂内主密钥或单板供应包")
    parser.add_argument("--init", action="store_true")
    parser.add_argument("--code")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--secrets", type=Path, default=HERE / "secrets" / "v2")
    args = parser.parse_args()
    try:
        if args.init:
            path = args.secrets / "MASTER_KEY.local"
            if not path.exists():
                private_write(path, secrets.token_hex(32) + "\n")
            load_master(args.secrets)
        if args.code:
            if not args.out:
                parser.error("--code 需要 --out")
            provision(load_master(args.secrets), args.code, args.out)
        elif not args.init:
            parser.error("使用 --init 或 --code ... --out ...")
    except (ValueError, OSError) as exc:
        parser.exit(1, f"供应失败：{exc}\n")


if __name__ == "__main__":
    main()
