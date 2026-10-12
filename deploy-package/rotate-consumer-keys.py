#!/usr/bin/env python3
"""Root-only coordinated rotation of admin/signing keys; never changes grants.

Stop the enforcer before --apply; restart authority and all consumers afterwards.
Device encryption keys require a separate factory/state migration, not this tool.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time


def atomic_write(path, text):
    stat = path.stat()
    fd, temp = tempfile.mkstemp(prefix='.rotation-', dir=path.parent)
    try:
        os.fchmod(fd, stat.st_mode & 0o777)
        os.fchown(fd, stat.st_uid, stat.st_gid)
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def prepare(root=Path('/etc/ainvr-license'), *, originals=None):
    if originals is None:
        originals = {}
    config_path = root / 'license-service.yaml'
    originals[config_path] = config_path.read_text()
    config = json.loads(originals[config_path])
    old_keys = config['signal_keys']
    if len(set(old_keys.values())) != len(old_keys):
        raise ValueError('Signal keys must be distinct')
    new_keys = {name: secrets.token_hex(32) for name in old_keys}
    new_admin = secrets.token_hex(32)
    changes = {}
    seen = set()
    admin_seen = False
    for path in sorted(root.glob('*.env')):
        originals[path] = path.read_text()
        lines = []
        for line in originals[path].splitlines(keepends=True):
            name, sep, value = line.rstrip('\r\n').partition('=')
            if name == 'LICENSE_SIGNAL_KEY' and sep:
                matches = [name for name, key in old_keys.items() if key == value]
                if len(matches) != 1:
                    raise ValueError('Unrecognized signal key in ' + path.name)
                seen.add(matches[0])
                line = 'LICENSE_SIGNAL_KEY=' + new_keys[matches[0]] + '\n'
            elif name == 'LICENSE_ADMIN_API_KEY' and sep:
                if value != config['admin_api_key']:
                    raise ValueError('Admin key mismatch in ' + path.name)
                admin_seen = True
                line = 'LICENSE_ADMIN_API_KEY=' + new_admin + '\n'
            lines.append(line)
        changes[path] = ''.join(lines)
    if seen != set(old_keys) or not admin_seen:
        raise ValueError('Consumer credentials are incomplete')
    config['signal_keys'] = new_keys
    config['admin_api_key'] = new_admin
    changes[config_path] = json.dumps(config, indent=2) + '\n'
    return changes


def apply_changes(changes, originals, *, writer=atomic_write):
    # Reject stale preparation before changing any file.
    for path in changes:
        if path.read_text() != originals[path]:
            raise RuntimeError('Concurrent credentials change: ' + path.name)
    attempted = []
    try:
        for path, text in changes.items():
            if path.read_text() != originals[path]:
                raise RuntimeError('Concurrent credentials change: ' + path.name)
            # A writer may fail after rename (e.g. directory fsync). Include it
            # in rollback, but restore only if its content is still ours.
            attempted.append(path)
            writer(path, text)
    except Exception as error:
        incomplete = []
        for path in reversed(attempted):
            try:
                current = path.read_text()
                if current == changes[path]:
                    writer(path, originals[path])
                elif current != originals[path]:
                    incomplete.append(path.name)
            except Exception:
                incomplete.append(path.name)
        if incomplete:
            raise RuntimeError('Rollback incomplete; preserve concurrent edits and inspect backup: '
                               + ', '.join(incomplete)) from error
        raise


@contextmanager
def rotation_lock():
    # This utility runs on Linux as root; tests of preparation can run elsewhere.
    import fcntl
    fd = os.open('/etc/ainvr-license/.consumer-rotation.lock',
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root')
    with rotation_lock():
        rotate(parser, args)


def rotate(parser, args):
    originals = {}
    changes = prepare(originals=originals)
    if not args.apply:
        print('Validated consumer credentials; no changes. Device key and grant state preserved.')
        return
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'ainvr-license-enforcer']).returncode == 0:
        parser.error('Stop the enforcer before coordinated rotation')
    backup = Path('/var/backups') / ('ainvr-license-keys-' + time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(4))
    backup.mkdir(mode=0o700)
    for path in changes:
        target = backup / path.name
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(originals[path])
            stream.flush()
            os.fsync(stream.fileno())
    directory = os.open(backup, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    apply_changes(changes, originals)
    print('Rotated admin and consumer signing keys. Root-only backup:', backup)
    print('Restart authority and all consumers. Device key and grant state preserved.')


if __name__ == '__main__':
    main()
