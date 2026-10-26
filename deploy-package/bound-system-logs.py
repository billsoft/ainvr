#!/usr/bin/env python3
"""Bound distro text-log retention without deleting business data or restarting Docker.

logrotate is periodic, so size is a rotation threshold, not a filesystem quota.
Journal and Docker already have their own byte budgets. Apply on the board only.
"""
from pathlib import Path
import datetime
import os
import subprocess


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Requires administrator')
    root = Path(__file__).resolve().parents[1]
    if root != Path('/home/sunrise/ainvr'):
        raise RuntimeError('Run from board repository')
    target = Path('/etc/logrotate.d/rsyslog')
    original = target.read_text()
    if 'maxsize 16M' not in original:
        if '\tweekly' not in original or '\trotate 4' not in original:
            raise RuntimeError('Unknown distribution policy: inspect before modifying')
        backup = root / '.Codex-trash' / ('log-limits-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
        backup.mkdir(parents=True)
        (backup / 'rsyslog').write_text(original)
        target.write_text(original.replace('\tweekly', '\tdaily\n\tmaxsize 16M'))
    # Run the distribution policy more frequently; its state lock serializes
    # with the original daily timer. No force rotation and no Docker restart.
    Path('/etc/systemd/system/ainvr-logrotate.service').write_text(
        '[Unit]\nDescription=AINVR bounded system text logs\n'
        '[Service]\nType=oneshot\nExecStart=/usr/sbin/logrotate /etc/logrotate.conf\n'
        'Nice=10\nTimeoutStartSec=60\n')
    Path('/etc/systemd/system/ainvr-logrotate.timer').write_text(
        '[Unit]\nDescription=Check AINVR text log size every five minutes\n'
        '[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\n'
        '[Install]\nWantedBy=timers.target\n')
    subprocess.run(['logrotate', '--debug', '/etc/logrotate.conf'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'ainvr-logrotate.timer'], check=True)
    subprocess.run(['systemctl', 'start', 'ainvr-logrotate.service'], check=True)


if __name__ == '__main__': main()
