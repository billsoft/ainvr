#!/usr/bin/env python3
"""AINVR: guarded rollout of the tested copied configuration client and watchdog.

This transition targets the inspected S100P installation. Backups include private
environment files and must remain on the board. No credential is printed.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

ROOT = Path('/home/sunrise/ainvr')
EXPECTED = {
    'deploy/s100p/bin/ainvr_ai_service': '3fdd59031744e7fe052bde71b6fd2ec6facdb92ab59431722c0e3602ce8b3b95',
    'deploy/s100p/runtime/ai-service.env': '6f615660d52805a90d3e4731aa2e077f862157d9af1b9bc0f6a96e03fdce687d',
    'deploy/s100p/runtime/backend.env': 'f8cf1a1bee3eae24eb87561ea09962a039df669a114f0b11f1add65077891b07',
}


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def replace(p, contents):
    st = p.stat()
    temp = p.with_name(p.name + '.runtime-control.tmp')
    assert not temp.exists()
    with temp.open('xb') as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, st.st_mode & 0o777)
    os.chown(temp, st.st_uid, st.st_gid)
    temp.replace(p)


def main():
    assert Path.cwd().resolve() == ROOT and os.geteuid() == 0
    assert Path('/mnt/ainvr-ssd').is_mount(), 'SSD backup mount required'
    for rel, expected in EXPECTED.items():
        assert digest(ROOT/rel) == expected, 'Concurrent change: ' + rel
    result = json.loads((ROOT/'test/results/runtime-control-20261012-025239/summary.json').read_text())
    assert result['passed'] and result['unit_tests_passed'] == 20 and result['service_callback_phases_passed'] == 7
    binary = ROOT/'out/build/ai-api-compat/ainvr_s100p_control_service'
    assert digest(binary) == result['binary_sha256']
    unit = ROOT/'deploy/s100p/ainvr-ai.service'
    assert 'WatchdogSec=30' in unit.read_text() and 'NotifyAccess=main' in unit.read_text()
    subprocess.run(['systemd-analyze', 'verify', str(unit)], check=True, timeout=20)
    installed_unit = Path('/etc/systemd/system/ainvr-ai.service')
    # The installer links the system unit to the project file. Preserve that link;
    # the conflict-aware source upload already backed up the old unit.
    assert installed_unit.is_symlink() and installed_unit.resolve() == unit.resolve()
    original_unit = Path('/mnt/ainvr-ssd/migration-backups/reused-worker-20261012-030127/deploy/s100p/ainvr-ai.service')
    assert digest(original_unit) == 'd9e69fc6de1debe3ee7307833a84a84b84b1039bc3160727dab3528f42eaf186'
    backup = Path('/mnt/ainvr-ssd/migration-backups')/('runtime-control-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    for rel in EXPECTED:
        dst = backup/rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/rel, dst)
    shutil.copy2(original_unit, backup/'ainvr-ai.service')
    token = secrets.token_hex(32)
    additions = {
        'deploy/s100p/runtime/backend.env': {'CONFIG_SERVICE_TOKEN_AI_SERVICE': token},
        'deploy/s100p/runtime/ai-service.env': {'CONFIG_SERVICE_TOKEN_AI_SERVICE': token,
            'CONFIG_CENTER_URL': 'http://127.0.0.1:3001', 'CONFIG_CENTER_POLL': '10'},
    }
    for rel, values in additions.items():
        text = (ROOT/rel).read_text()
        keys = {line.split('=', 1)[0] for line in text.splitlines() if '=' in line}
        assert not keys.intersection(values), 'Existing configuration-center setting: ' + rel
    for rel, values in additions.items():
        p = ROOT/rel
        contents = p.read_text().rstrip('\n') + '\n' + ''.join(k+'='+v+'\n' for k, v in values.items())
        replace(p, contents.encode())
    replace(ROOT/'deploy/s100p/bin/ainvr_ai_service', binary.read_bytes())
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
    subprocess.run(['systemctl', 'restart', 'ainvr-backend'], check=True, timeout=30)
    subprocess.run(['systemctl', 'restart', 'ainvr-ai'], check=True, timeout=45)
    print(json.dumps({'deployed': True, 'binary_sha256': digest(binary), 'backup': str(backup),
        'dedicated_service_token_installed': True, 'watchdog_seconds': 30}))


if __name__ == '__main__':
    main()
