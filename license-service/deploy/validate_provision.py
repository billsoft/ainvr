#!/usr/bin/env python3
"""Validate factory artifacts without printing any credential values."""
import argparse
import json
from pathlib import Path
import re

CLIENTS = ("ai-service", "recorder", "console-backend", "enforcer")


def check(condition, message):
    if not condition:
        raise ValueError(message)


def validate(directory, machine, installed=Path('/etc/ainvr-license'), state_root=Path('/var/lib/ainvr-license')):
    c = json.loads((directory / 'license-service.yaml').read_text())
    required = {'host', 'port', 'machine_code', 'device_key', 'admin_api_key', 'signal_keys', 'installation_path'}
    check(required <= set(c) <= required | {'migration_file'},
          'Unsupported provisioning fields; use the factory provisioner')
    check(c['machine_code'] == machine.replace('-', ''), 'Provisioning belongs to another board')
    check(c['host'] == '127.0.0.1' and c['port'] == 8001, 'Unexpected authority endpoint')
    check(c['installation_path'] ==
          '/var/lib/ainvr-license-identity/identity.json', 'Installation path must match the systemd write allowlist')
    if c.get('migration_file'):
        check(Path(c['migration_file']).is_absolute() and Path(c['migration_file']).is_file(),
              'Signed migration input must be an existing absolute path on this board')
    check(set(c['signal_keys']) == set(CLIENTS), 'Unexpected consumer identities')
    keys = [c['device_key'], c['admin_api_key'], *c['signal_keys'].values()]
    check(all(isinstance(k, str) and re.fullmatch('[0-9a-f]{64}', k) for k in keys), 'Malformed credentials')
    check(len(set(keys)) == len(keys), 'Credentials must be independent')
    for client in CLIENTS:
        lines = (directory / (client + '.env')).read_text().splitlines()
        expected = {'AINVR_PROFILE': 'production', 'LICENSE_ENABLED': 'true',
                    'LICENSE_DEVICE_ID': c['machine_code'],
                    'LICENSE_SIGNAL_KEY': c['signal_keys'][client],
                    'LICENSE_UDS_PATH': '/run/ainvr-license/license.sock'}
        if client == 'console-backend':
            expected['LICENSE_ADMIN_API_KEY'] = c['admin_api_key']
        values = {}
        for line in lines:
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, sep, value = line.partition('=')
            check(sep and key not in values, 'Malformed or duplicate consumer setting')
            values[key] = value
        check(values == expected, 'Consumer credentials do not match authority: ' + client)
    old_path = installed / 'license-service.yaml'
    if old_path.exists():
        # Ordinary upgrades preserve device identity and key material. Rotation
        # needs an explicit migration, not accidental replacement of state MAC keys.
        old = json.loads(old_path.read_text())
        check(old.get('machine_code') == c['machine_code'] and old.get('device_key') == c['device_key'],
              'Device identity/key changed; explicit state migration required')
    for name in ('state.dat', 'recovery-1.dat', 'recovery-2.dat'):
        path = state_root / name
        if path.exists():
            state = json.loads(path.read_text())
            schema = state.get('data', {}).get('schema')
            check(schema == 3 or (schema == 2 and c.get('migration_file')), 'Legacy state needs a signed migration ticket')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('machine')
    args = parser.parse_args()
    try:
        validate(args.directory, args.machine)
    except Exception:
        # JSON/decoder exceptions can contain fragments of secret input.
        parser.exit(1, 'Provisioning rejected: check device binding, credential consistency and migration requirements.\n')
    print('Provisioning validated (no credential values displayed)')
