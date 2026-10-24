#!/usr/bin/env python3
"""Deploy only the independent observer; media service PIDs must remain unchanged."""
import json
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path('/home/sunrise/ainvr')
def run(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()

def main():
    units = ['ainvr-ai', 'ainvr-alarm', 'ainvr-backend', 'ainvr-recorder', 'ainvr-ingest', 'ainvr-llm']
    def state():
        return {**{s: run('systemctl', 'show', s, '-p', 'MainPID', '--value') for s in units},
                'srs': run('docker', 'inspect', '-f', '{{.State.Pid}}', 'ainvr-srs')}
    before = state()
    backup = ROOT / 'deploy/s100p' / time.strftime('rollback-srs-observer-%Y%m%d-%H%M%S')
    backup.mkdir()
    files = [(ROOT/'srs-web-console/deploy/srs-observer.py', Path('/opt/ainvr/srs-observer.py')),
             (ROOT/'srs-web-console/deploy/ainvr-srs-observer.service', Path('/etc/systemd/system/ainvr-srs-observer.service'))]
    for source, target in files:
        shutil.copy2(target, backup/target.name)
    try:
        for source, target in files:
            temp = target.with_suffix(target.suffix+'.diagnostics-tmp')
            shutil.copy2(source, temp)
            temp.replace(target)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'ainvr-srs-observer')
        time.sleep(3)
        assert run('systemctl', 'is-active', 'ainvr-srs-observer') == 'active'
        log = Path('/var/log/ainvr-srs-observer/incidents.jsonl')
        assert log.stat().st_size > 0
        assert any(json.loads(line)['kind'] == 'observer_started' for line in log.read_text().splitlines())
        assert state() == before, 'Media service PID changed'
    except BaseException:
        for source, target in files:
            shutil.copy2(backup/target.name, target)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'ainvr-srs-observer')
        raise
    print(json.dumps({'backup': str(backup), 'media_pids_unchanged': True,
                      'archive': str(log)}))

if __name__ == '__main__':
    main()
