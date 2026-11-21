#!/usr/bin/env python3
"""Provision the scene reference namespace on the backend's selected volume."""
import argparse
import grp
import http.client
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_console_env import read_env
sys.path.insert(0, str(ROOT / 'shared/os-helper'))
from storage import inventory

NAMESPACE = 'ainvr-arming-scenes'
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def helper_volumes(path=ROOT / 'deploy/s100p/runtime/backend.env'):
    env = read_env(path) if path.is_file() else {}
    if not env.get('OS_HELPER_URL') or not env.get('OS_HELPER_TOKEN'):
        return []
    url = urlsplit(env['OS_HELPER_URL'])
    if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1')
            or url.username is not None or url.password is not None
            or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('Expected a local OS helper URL')
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=6)
    try:
        if any(ord(c) < 33 or ord(c) > 126 for c in env['OS_HELPER_TOKEN']):
            raise ValueError('Invalid OS helper credential format')
        conn.request('GET', '/storage/volumes', headers={'Authorization': 'Bearer ' + env['OS_HELPER_TOKEN']})
        response = conn.getresponse()
        if response.status != 200:
            raise ValueError('OS helper did not return the volume inventory')
        body = response.read(512 * 1024 + 1)
        if len(body) > 512 * 1024:
            raise ValueError('OS helper volume inventory too large')
        return json.loads(body)['volumes']
    finally:
        conn.close()


def select(volumes, mount=None):
    candidates = [v for v in volumes if v['selectable'] is True and v['system'] is False
                  and v['readOnly'] is False and v['state'] == 'mounted'
                  and v['mountPath'].startswith(('/mnt/', '/media/', '/run/media/'))
                  and v['id'] and sum(other['id'] == v['id'] for other in volumes) == 1
                  and (mount is None or v['mountPath'] == mount)]
    return candidates[0] if len(candidates) == 1 else None


def backend_owner():
    values = subprocess.check_output(['systemctl', 'show', 'ainvr-backend.service',
                                      '-p', 'User', '-p', 'Group'], text=True, timeout=5)
    props = dict(line.split('=', 1) for line in values.splitlines())
    account = pwd.getpwnam(props['User'])
    if not account.pw_uid:
        raise ValueError('Expected an unprivileged backend service user')
    gid = grp.getgrnam(props['Group']).gr_gid if props['Group'] else account.pw_gid
    return account.pw_uid, gid


def mount_id(fd):
    for line in Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines():
        if line.startswith('mnt_id:'):
            return int(line.split()[1])
    raise ValueError('Cannot verify mount identity')


def open_volume(volume):
    path = volume['mountPath']
    if os.path.realpath(path) != path or not os.path.ismount(path):
        raise ValueError('Expected a mounted volume at its canonical path')
    block = os.stat(volume['device'])
    fd = os.open(path, DIRECTORY)
    try:
        device = os.fstat(fd).st_dev
        if (not stat.S_ISBLK(block.st_mode) or block.st_rdev != device
                or device == os.stat('/').st_dev or os.fstatvfs(fd).f_flag & os.ST_RDONLY):
            raise ValueError('Expected a writable external block filesystem')
        return fd
    except BaseException:
        os.close(fd)
        raise


def prepare_namespace(root_fd, uid, gid):
    try:
        os.mkdir(NAMESPACE, 0o700, dir_fd=root_fd)
        created = True
    except FileExistsError:
        created = False
    fd = os.open(NAMESPACE, DIRECTORY, dir_fd=root_fd)
    try:
        if mount_id(fd) != mount_id(root_fd):
            raise ValueError('Namespace is a separate mount')
        if created:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, 0o700)
        info = os.fstat(fd)
        if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (uid, gid, 0o700):
            raise ValueError('Existing scene directory has unexpected ownership or permissions')
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mount', help='Exact local block volume mountpoint (offline provisioning)')
    parser.add_argument('--if-configured', action='store_true', help='Skip if the backend has no unique volume')
    parser.add_argument('--backend-env', type=Path, default=ROOT / 'deploy/s100p/runtime/backend.env',
                        help='Live backend environment file when running from a release candidate')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root')
    local = inventory()['volumes']
    selected = select(local, args.mount) if args.mount else select(helper_volumes(args.backend_env))
    if selected is None:
        if args.if_configured and not args.mount:
            print('Scene storage skipped: backend has no unique selectable volume')
            return
        raise ValueError('No matching selectable volume')
    current = select(local, selected['mountPath'])
    if not current or any(current[k] != selected[k] for k in ('id', 'device', 'filesystem')):
        raise ValueError('OS helper selection differs from local block inventory')
    uid, gid = backend_owner()
    fd = open_volume(current)
    try:
        prepare_namespace(fd, uid, gid)
    finally:
        os.close(fd)
    print(f"Scene storage ready: {current['mountPath']}/{NAMESPACE} ({uid}:{gid}, 0700)")


if __name__ == '__main__':
    try:
        main()
    except (KeyError, TypeError, OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as exc:
        sys.exit(f'Scene storage provisioning failed: {exc}')
