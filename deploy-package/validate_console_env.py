#!/usr/bin/env python3
"""Reject example credentials without printing values or changing existing DBs."""
import sys
from pathlib import Path


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        k, sep, v = line.partition('=')
        if sep:
            k = k.strip()
            if k in values:
                raise ValueError('Duplicate environment field: ' + k)
            values[k] = v.strip().strip('"').strip("'")
    return values


def validate(path):
    values = read_env(path)
    for name in ('POSTGRES_PASSWORD', 'CONFIG_SERVICE_TOKEN_RECORDER',
                 'CONFIG_SERVICE_TOKEN_AI_SERVICE', 'RESTART_HELPER_TOKEN', 'OS_HELPER_TOKEN'):
        value = values.get(name, '')
        if len(value) < 24 or value.lower() in ('change-me', 'consolepass') or '${' in value:
            raise ValueError('Set a unique credential of at least 24 characters: ' + name)
    tokens = [values[k] for k in ('CONFIG_SERVICE_TOKEN_RECORDER', 'CONFIG_SERVICE_TOKEN_AI_SERVICE',
                                  'RESTART_HELPER_TOKEN', 'OS_HELPER_TOKEN')]
    if len(set(tokens)) != len(tokens):
        raise ValueError('Each service requires its own credential')
    return values


def validate_host_files(values, etc):
    for name, relative in (
        ('CONFIG_SERVICE_TOKEN_AI_SERVICE', 'ainvr-ai/service.env'),
        ('CONFIG_SERVICE_TOKEN_RECORDER', 'ainvr-recorder/service.env'),
        ('OS_HELPER_TOKEN', 'ainvr-ai/os-helper.env'),
        ('RESTART_HELPER_TOKEN', 'ainvr-ai/restart-helper.env'),
    ):
        if read_env(etc / relative).get(name) != values[name]:
            raise ValueError('Host and console credentials differ: ' + name)


if __name__ == '__main__':
    try:
        validate_host_files(validate(Path(sys.argv[1])), Path('/etc'))
    except ValueError as exc:
        sys.exit(str(exc))
    except Exception:
        sys.exit('Cannot validate console environment')
    print('Console credentials validated (values hidden)')
