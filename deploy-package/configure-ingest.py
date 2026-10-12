#!/usr/bin/env python3
"""Provision an independent service credential without printing secret values."""
import argparse
import os
from pathlib import Path
import re
import secrets
import tempfile


def atomic(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = path.stat() if path.exists() else None
    fd, name = tempfile.mkstemp(prefix='.ingest-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        if owner and os.geteuid() == 0: os.fchown(fd, owner.st_uid, owner.st_gid)
        with os.fdopen(fd, 'w') as f:
            f.write(content); f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def configure(console, code, template):
    env = console / '.env'
    if env.is_symlink(): raise ValueError('invalid console environment file')
    text = env.read_text()
    values = re.findall(r'^INGEST_SERVICE_TOKEN=([a-f0-9]{64})$', text, flags=re.M)
    token = values[-1] if values else secrets.token_hex(32)
    text = re.sub(r'^INGEST_SERVICE_TOKEN=.*\n?', '', text, flags=re.M)
    atomic(env, text.rstrip() + '\nINGEST_SERVICE_TOKEN=' + token + '\n', 0o600)
    atomic(Path('/etc/ainvr-ingest/service.env'), 'INGEST_SERVICE_TOKEN=' + token + '\n', 0o600)
    unit = template.read_text().replace('/home/sunrise/ainvr/ingest-service', str(code))
    unit = unit.replace('WorkingDirectory=/home/sunrise/ainvr', 'WorkingDirectory=' + str(code.parent))
    if (code / 'main.pyc').exists(): unit = unit.replace('/main.py\n', '/main.pyc\n')
    atomic(Path('/etc/systemd/system/ainvr-ingest.service'), unit, 0o644)
    print('Camera input service credential and unit configured')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--console', type=Path, required=True)
    p.add_argument('--code', type=Path, required=True)
    p.add_argument('--template', type=Path, required=True)
    a = p.parse_args()
    if os.geteuid() != 0: raise SystemExit('Root is required')
    configure(a.console, a.code, a.template)
