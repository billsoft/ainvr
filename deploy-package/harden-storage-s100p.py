#!/usr/bin/env python3
"""AINVR S100P: bounded logs and recoverable recorder-state migration to SSD.
Run as root after mounting /mnt/ainvr-ssd. Never formats or deletes business data.
"""
import argparse
import datetime
import json
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SSD = Path('/mnt/ainvr-ssd')

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120)

def managed(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not path.read_text().startswith('# Managed by AINVR'):
        raise RuntimeError('Refusing unrelated configuration: ' + str(path))
    tmp = path.with_name(path.name + '.ainvr-tmp')
    tmp.write_text(content)
    os.chmod(tmp, 0o644)
    tmp.replace(path)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-existing-logs', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0 or ROOT != Path('/home/sunrise/ainvr'):
        raise RuntimeError('Run as root in the board project')
    run('mountpoint', '-q', str(SSD))
    if shutil.disk_usage(SSD).free < 12 * 1024**3:
        raise RuntimeError('Need 12 GiB free on SSD for recoverable migration')
    for location in (
        '/etc/systemd/system/ainvr-recorder.service.d/60-ainvr-storage.conf',
        '/etc/systemd/journald.conf.d/60-ainvr-storage.conf',
        '/etc/rsyslog.d/10-ainvr-jpu-lifecycle.conf',
    ):
        path = Path(location)
        if path.exists() and not path.read_text().startswith('# Managed by AINVR'):
            raise RuntimeError('Refusing unrelated configuration: ' + location)
    backup = SSD / 'migration-backups'  / ('storage-health-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, mode=0o700)
    source = ROOT / 'data/recorder'
    target = SSD / 'databases/recorder'
    active = subprocess.run(['systemctl', 'is-active', '--quiet', 'ainvr-recorder']).returncode == 0
    if source.is_symlink():
        if source.resolve() != target.resolve() or not target.is_dir():
            raise RuntimeError('Unexpected recorder state symlink')
    else:
        if target.exists():
            raise RuntimeError('Target exists: inspect before migration')
        if active:
            run('systemctl', 'stop', 'ainvr-recorder')
        old = source.with_name('recorder.before-ssd-' + backup.name)
        try:
            shutil.copytree(source, target, copy_function=shutil.copy2)
            for original in source.rglob('*'):
                if original.is_file():
                    copied = target / original.relative_to(source)
                    if hashlib.sha256(original.read_bytes()).digest() != hashlib.sha256(copied.read_bytes()).digest():
                        raise RuntimeError('Recorder copy checksum mismatch')
            db = target / 'segments.db' 
            if db.exists():
                with sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True) as connection:
                    if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Copied recorder index failed integrity check')
            source.rename(old)
            try:
                source.symlink_to(target, target_is_directory=True)
            except BaseException:
                old.rename(source)
                raise
        finally:
            if active:
                run('systemctl', 'start', 'ainvr-recorder')
    managed('/etc/systemd/system/ainvr-recorder.service.d/60-ainvr-storage.conf',
        '# Managed by AINVR storage hardening\n[Unit]\nRequiresMountsFor=/mnt/ainvr-ssd\n'
        '[Service]\nExecStartPre=/usr/bin/mountpoint -q /mnt/ainvr-ssd\n')
    managed('/etc/systemd/journald.conf.d/60-ainvr-storage.conf',
        '# Managed by AINVR storage hardening\n[Journal]\nSystemMaxUse=256M\nSystemKeepFree=2G\n'
        'SystemMaxFileSize=32M\nRuntimeMaxUse=64M\n')
    # Keep warning/error messages, including JPU failures. Suppress only routine
    # driver instance lifecycle INFO messages duplicated in syslog and kern.log.
    managed('/etc/rsyslog.d/10-ainvr-jpu-lifecycle.conf',
        '# Managed by AINVR storage hardening\n'
        'if ($syslogfacility-text == "kern" and $syslogseverity >= 6 and '
        '$msg contains "[JPUDRV]" and '
        '($msg contains "jpu_open_instance:" or $msg contains "jpu_close_instance:" or '
        '$msg contains "jpu_alloc_instance_id:" or $msg contains "jpu_free_instance_id:" or '
        '$msg contains "jpu_release_internal_res:")) then stop\n')
    run('rsyslogd', '-N1')
    if args.archive_existing_logs:
        # Preserve exact text files before releasing their eMMC space. No rm of
        # directories, no model/database/recording deletion.
        run('systemctl', 'stop', 'rsyslog')
        try:
            for name in ('syslog', 'kern.log', 'syslog.1', 'kern.log.1'):
                log = Path('/var/log') / name
                if log.is_file() and not log.is_symlink():
                    shutil.copy2(log, backup / name)
                    with log.open('r+b') as stream:
                        stream.truncate(0)
        finally:
            run('systemctl', 'start', 'rsyslog')
        run('journalctl', '--rotate')
        journals = Path('/var/log/journal')
        if journals.is_dir():
            shutil.copytree(journals, backup / 'journal')
        run('journalctl', '--vacuum-size=256M')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'systemd-journald', 'rsyslog')
    result = {'backup': str(backup), 'recorder_state': str(source.resolve()),
              'recorder_was_active': active, 'archived_logs': args.archive_existing_logs}
    (backup / 'manifest.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))

if __name__ == '__main__':
    main()
