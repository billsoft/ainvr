#!/usr/bin/env python3
"""Apply the explicitly authorized S100 recovery; never reboot automatically.

This writes system packages and boot firmware. Only use after reviewing the
official maintainer scripts and creating partition backups. Default is verify.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'results/system-recovery'
PACKAGES = ['hobot-miniboot', 'linux-image-rdk-s100',
            'linux-headers-6.1.158-rt58', 'hobot-camera', 'hobot-multimedia',
            'hobot-multimedia-dev', 'hobot-multimedia-samples',
            'hobot-spdev', 'hobot-io-samples']


def package_files():
    records = []
    for package in PACKAGES:
        policy = subprocess.check_output(['apt-cache', 'policy', package], text=True)
        candidate = next(line.split(':', 1)[1].strip() for line in policy.splitlines()
                         if line.strip().startswith('Candidate:'))
        if candidate == '(none)':
            raise RuntimeError('No authenticated APT candidate: ' + package)
        metadata = subprocess.check_output(['apt-cache', 'show', package + '=' + candidate], text=True)
        expected = next(line.split(': ', 1)[1] for line in metadata.splitlines()
                        if line.startswith('SHA256: '))
        candidates = list(Path('/var/cache/apt/archives').glob(package + '_' + candidate + '_*.deb'))
        candidates += list((ROOT / 'runtime/system-recovery/packages').glob(package + '_' + candidate + '_*.deb'))
        if len(candidates) != 1:
            raise RuntimeError('Expected exactly one downloaded package: ' + package)
        file = candidates[0]
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError('Official index hash mismatch: ' + str(file))
        records.append({'package': package, 'version': candidate, 'path': str(file), 'sha256': actual})
    return records


def run(name, command, env):
    started = time.time()
    print(name + ': ' + ' '.join(command), flush=True)
    # A timeout must not interrupt firmware flashing or dpkg configuration.
    with (OUT / (name + '.log')).open('w') as stream:
        result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env)
    record = {'command': command, 'exit_code': result.returncode,
              'elapsed_seconds': time.time() - started}
    (OUT / (name + '.json')).write_text(json.dumps(record, indent=2))
    print(name + ': exit ' + str(result.returncode), flush=True)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if ROOT != Path('/home/sunrise/ainvr/test'):
        raise RuntimeError('Only the authorized remote test directory is supported')
    OUT.mkdir(exist_ok=True, parents=True)
    records = package_files()
    (OUT / 'verified-package-manifest.json').write_text(json.dumps(records, indent=2))
    if not args.apply:
        print('All ' + str(len(records)) + ' package hashes match authenticated APT metadata.')
        return
    if os.geteuid() != 0:
        raise RuntimeError('Recovery requires root')
    backups = json.loads((OUT / 'backup-manifest.json').read_text())
    for device in ['/dev/mmcblk0p12', '/dev/mtd6', '/dev/mtd8', '/dev/mtd10',
                   '/dev/mtd12', '/dev/mtd16', '/dev/mtd18']:
        if not any(record['device'] == device and record['bytes'] > 0 for record in backups):
            raise RuntimeError('Missing boot partition backup: ' + device)
    env = dict(os.environ, PREINST_CONFIRM='y', DEBIAN_FRONTEND='noninteractive',
               NEEDRESTART_MODE='l')
    old_headers = subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Abbrev}',
                                 'linux-headers-6.1.112-rt43'], capture_output=True, text=True)
    if old_headers.stdout == 'ii ':
        # The official new package shares /usr/src/hobot-drivers with the old
        # package but declares no replacement. Preserve sources, then retire
        # only the obsolete header package; running kernel modules remain.
        source_paths = [str(path) for path in Path('/usr/src').glob('linux-headers-6.1.112-rt43*')]
        if Path('/usr/src/hobot-drivers').exists():
            source_paths.append('/usr/src/hobot-drivers')
        archive = ROOT / 'runtime/system-recovery/backup/obsolete-headers.before.tar.gz'
        subprocess.run(['tar', '-czf', str(archive), *source_paths], check=True)
        code = run('remove-obsolete-headers', ['dpkg', '--remove', 'linux-headers-6.1.112-rt43'], env)
        if code:
            raise SystemExit(code)
    code = run('unpack-cohort', ['dpkg', '--force-confold', '--unpack',
                                *[record['path'] for record in records]], env)
    if code:
        raise SystemExit(code)
    code = run('configure-all', ['dpkg', '--force-confold', '--configure', '-a'], env)
    if code:
        code = run('repair-dependencies', ['apt-get', '-y', '--no-remove',
                   '-o', 'Dpkg::Options::=--force-confold', '-f', 'install'], env)
        if code:
            raise SystemExit(code)
    with (OUT / 'dpkg-audit.after.txt').open('w') as stream:
        subprocess.run(['dpkg', '--audit'], stdout=stream, stderr=subprocess.STDOUT, check=True)
    rows = subprocess.check_output(['dpkg-query', '-W',
             '-f=${db:Status-Abbrev}\t${binary:Package}\t${Version}\n'], text=True)
    (OUT / 'packages.after.txt').write_text(rows)
    pending = [line for line in rows.splitlines() if line.startswith('i') and not line.startswith('ii ')]
    audit = (OUT / 'dpkg-audit.after.txt').read_text()
    result = {'status': 'FAIL' if pending or audit.strip() else 'PASS', 'pending_packages': pending,
              'dpkg_audit': audit,
              'reboot_performed': False, 'scope': 'Package configuration only; boot verification required'}
    (OUT / 'recovery.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    raise SystemExit(bool(pending or audit.strip()))


if __name__ == '__main__':
    main()
