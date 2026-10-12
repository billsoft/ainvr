#!/usr/bin/env python3
"""Read-only production storage gate. This is NOT secure-boot attestation."""
import argparse
import json
from pathlib import Path
import subprocess


def output(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=15).strip()


def encrypted(path):
    current = path.resolve()
    while not current.exists():
        current = current.parent
    source = output('findmnt', '-n', '-o', 'SOURCE', '-T', str(current)).split('[')[0]
    if not source.startswith('/dev/'):
        return False
    # Reverse dependencies include an encrypted ancestor for LVM-on-LUKS too.
    return 'crypt' in output('lsblk', '-s', '-n', '-o', 'TYPE', source).split()


def audit(paths):
    failures = []
    for path in paths:
        try:
            if not encrypted(path):
                failures.append('Unencrypted or unsupported storage: ' + str(path))
        except (OSError, subprocess.SubprocessError):
            failures.append('Cannot verify storage: ' + str(path))
    # Known development/factory leftovers: inspect names only, never key contents.
    for root in (Path('/home/sunrise/ainvr'), Path('/opt/ainvr-ai')):
        for relative in ('tools/license-keygen/secrets/MASTER_KEY.local',
                         'tools/license-keygen/secrets/v2/MASTER_KEY.local',
                         'license-service/src/key_material.hpp'):
            if (root / relative).exists():
                failures.append('Factory/development material remains: ' + str(root / relative))
    return failures


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', action='append', type=Path, default=[])
    parser.add_argument('--docker', action='store_true')
    parser.add_argument('--development-host', action='store_true',
                        help='Explicit engineering installation only; never disables licensing')
    args = parser.parse_args()
    paths = [Path('/etc/ainvr-license'), Path('/var/lib/ainvr-license'), *args.path]
    failures = []
    if args.docker:
        try:
            paths.append(Path(output('docker', 'info', '--format', '{{.DockerRootDir}}')))
        except (OSError, subprocess.SubprocessError):
            failures.append('Cannot verify Docker data storage')
    failures.extend(audit(paths))
    print(json.dumps({'profile': 'engineering' if args.development_host else 'production',
                      'storage_checks_passed': not failures, 'findings': failures,
                      'secure_boot': 'not_attested', 'application_integrity': 'not_attested',
                      'rollback_protection': 'not_attested'}, ensure_ascii=False, indent=2))
    if failures and not args.development_host:
        parser.exit(1, 'Production installation blocked. See license-service-design.md and INSTALL-FROM-SCRATCH.md.\n')
