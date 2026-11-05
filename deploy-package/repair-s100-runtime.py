#!/usr/bin/env python3
"""Repair the SSD rsyslog allowlist; optionally stop unused broken Bluetooth.

Run explicitly on the target board. Never disables AppArmor or changes media,
database credentials, network policy, or the Wi-Fi service.
"""
import argparse
import datetime
import os
from pathlib import Path
import shutil
import subprocess


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--disable-unused-bluetooth', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Requires root')
    run('mountpoint', '-q', '/mnt/ainvr-ssd')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    parent = Path('/mnt/ainvr-ssd/ainvr-rollback/host-logging')
    backup = parent / stamp
    profile = Path('/etc/apparmor.d/usr.sbin.rsyslogd')
    target = Path('/etc/apparmor.d/local/usr.sbin.rsyslogd')
    if '#include <local/usr.sbin.rsyslogd>' not in profile.read_text():
        raise RuntimeError('Unsupported AppArmor profile: local include missing')
    if not Path('/mnt/ainvr-ssd/logs/system').is_dir():
        raise RuntimeError('SSD logging must already be configured')
    original = target.read_text() if target.exists() else ''
    rule = '/mnt/ainvr-ssd/logs/system/** rw,'
    if rule not in original:
        backup.mkdir(parents=True)
        (backup / 'rsyslog-local-before').write_text(original)
        target.write_text(original.rstrip() + '\n# AINVR bounded system logs on SSD\n'
                          '/mnt/ainvr-ssd/logs/system/ r,\n' + rule + '\n')
        try:
            run('apparmor_parser', '-r', str(profile))
            run('rsyslogd', '-N1')
            run('systemctl', 'restart', 'rsyslog')
        except Exception:
            target.write_text(original)
            run('apparmor_parser', '-r', str(profile))
            raise
    if args.disable_unused_bluetooth:
        # Explicit opt-in: no usable Bluetooth adapter, and AINVR does not use it.
        if list(Path('/sys/class/bluetooth').glob('hci*')):
            raise RuntimeError('A Bluetooth adapter exists; leave it untouched')
        backup.mkdir(parents=True, exist_ok=True)
        state = subprocess.run(['systemctl', 'is-enabled', 'hobot-bluetooth'],
                               capture_output=True, text=True).stdout
        (backup / 'bluetooth-enabled-before').write_text(state)
        run('systemctl', 'disable', '--now', 'hobot-bluetooth')
        run('systemctl', 'reset-failed', 'hobot-bluetooth')
    if parent.exists():
        for old in sorted(p for p in parent.iterdir() if p.is_dir())[:-3]:
            if old.is_symlink() or old.resolve().parent != parent.resolve():
                raise RuntimeError('Unsafe backup path')
            shutil.rmtree(old)


if __name__ == '__main__':
    main()
