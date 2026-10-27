#!/usr/bin/env python3
"""Read-only GB installer preflight. Never operates services or reads secrets."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify(root, gateway=None, expected=None, installed=None):
    root = root.resolve(strict=True)
    output = root/'out/gb28181'
    default = output/'gateway'
    if bool(gateway) != bool(expected):
        raise ValueError('Explicit gateway and SHA-256 must be supplied together')
    binary = Path(gateway).resolve(strict=True) if gateway else default.resolve(strict=True)
    if not binary.is_relative_to(root/'out'):
        raise ValueError('Gateway candidate must be inside this repository out directory')
    paths = [default, output/'ZLMediaKit/release/linux/Release/MediaServer',
             output/'ffmpeg-runtime/bin/ffmpeg', output/'ffmpeg-runtime/bin/ffprobe']
    if expected:
        if not re.fullmatch('[0-9a-f]{64}', expected) or sha(binary) != expected:
            raise ValueError('Explicit gateway does not match the accepted SHA-256')
    else:
        # A partial/manual build must never silently install an old gateway.
        # build.sh writes this only after all components and notices succeed.
        manifest = output/'artifacts.sha256'
        checks = {}
        for line in manifest.read_text().splitlines():
            match = re.fullmatch(r'([0-9a-f]{64}) [ *](.+)', line)
            if not match:
                raise ValueError('Invalid build artifact manifest')
            key = Path(match[2])
            if key in checks:
                raise ValueError('Duplicate build artifact manifest entry')
            checks[key] = match[1]
        if set(checks) != set(paths) or any(sha(p) != checks[p] for p in paths):
            raise ValueError('Build artifact manifest is incomplete or changed')
    lock = json.loads((root/'gb28181-service/dependencies.lock.json').read_text())
    for path, want in [
        (paths[1], lock['zlmediakit']['arm64BinarySha256']),
        (paths[2], lock['ffmpeg']['installedArm64BinarySha256']),
        (paths[3], lock['ffmpeg']['installedArm64ProbeSha256']),
    ]:
        if sha(path) != want:
            raise ValueError('Media binary does not match the fixed dependency lock: '+path.name)
    notices = output/'licenses'
    inventory = json.loads((notices/'inventory.json').read_text())
    if not inventory:
        raise ValueError('Dependency notice inventory is empty')
    for notice in inventory:
        name = notice['notice']
        if Path(name).name != name or name in ('.', '..') or sha(notices/name) != notice['sha256']:
            raise ValueError('Dependency notice inventory is invalid')
    for path in [binary, *paths[1:]]:
        with path.open('rb') as source:
            header = source.read(20)
        if len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\xb7\x00':
            raise ValueError('Runtime executable is not little-endian ARM64 ELF: '+path.name)
    if not (root/'srs-web-console/backend/dist/store/migrations/012_gb28181.sql').is_file():
        raise ValueError('Compatible console migration is not installed')
    if installed:
        installed = Path(installed)
        for source, destination in [(binary, installed/'gateway'), (paths[1], installed/'MediaServer'),
                                    (paths[2], installed/'ffmpeg/bin/ffmpeg'), (paths[3], installed/'ffmpeg/bin/ffprobe')]:
            if sha(source) != sha(destination):
                raise ValueError('Installed artifact differs from the verified candidate: '+destination.name)
        if json.loads((installed/'licenses/inventory.json').read_text()) != inventory:
            raise ValueError('Installed notice inventory differs')
        for notice in inventory:
            if sha(installed/'licenses'/notice['notice']) != notice['sha256']:
                raise ValueError('Installed dependency notice differs')
    return {'verified': True, 'gateway': str(binary), 'gatewaySHA256': sha(binary),
            'noticeFiles': len(inventory), 'servicesChanged': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--gateway', type=Path)
    parser.add_argument('--gateway-sha256')
    parser.add_argument('--installed-root', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.gateway, args.gateway_sha256, args.installed_root)))


if __name__ == '__main__':
    main()
