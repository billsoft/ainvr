#!/usr/bin/env python3
"""Publish alarm JS + a prebuilt console bundle without restarting video services.

Run on the authorized S100P as root. Build frontend to a separate directory first.
Backups and the release report are device-local artifacts, not repository assets.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=120).strip()

def atomic(path, data):
    temp = path.with_name(path.name + '.review-next')
    temp.write_bytes(data)
    temp.chmod(path.stat().st_mode)
    os.replace(temp, path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--frontend', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    candidate = Path(args.frontend).resolve()
    assert os.geteuid() == 0
    assert root == Path('/home/sunrise/ainvr')
    assert candidate != root / 'srs-web-console/frontend/dist'
    assert (candidate / 'index.html').is_file()
    run('git', '-C', str(root), 'diff', '--check')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = root / 'deploy/s100p' / ('rollback-review-fixes-' + stamp)
    backup.mkdir()
    unit = Path('/etc/systemd/system/ainvr-alarm.service')
    old_unit = unit.read_bytes()
    (backup / unit.name).write_bytes(old_unit)
    preserved = ['ainvr-ai', 'ainvr-recorder', 'ainvr-ingest', 'ainvr-llm']
    pids = {s: run('systemctl', 'show', s, '-p', 'MainPID', '--value') for s in preserved}
    def configs():
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (root / 'deploy/s100p/runtime').glob('*.json')}
    before_config = configs()
    spec = importlib.util.spec_from_file_location('deploy', root / 'deploy-package/deploy-alarm-review.py')
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    cfg = deploy.config('alarm-service')
    release = root / 'deploy/s100p/alarm-service' / ('release-review-fixes-' + stamp)
    release.mkdir()
    shutil.copytree(root / 'alarm-service/src', release / 'src')
    os.symlink(root / 'alarm-service/node_modules', release / 'node_modules')
    target = root / 'srs-web-console/frontend/dist'
    next_dir = target.with_name('dist.review-next-' + stamp)
    previous = target.with_name('dist.review-before-' + stamp)
    shutil.copytree(candidate, next_dir)
    # Open tabs may still request assets from their previous document.
    for p in (target / 'assets').glob('*'):
        if p.is_file() and not (next_dir / 'assets' / p.name).exists():
            shutil.copy2(p, next_dir / 'assets' / p.name)
    swapped = False
    report = {'backup': str(backup), 'previous_frontend': str(previous), 'release': str(release), 'published': stamp}
    try:
        old = run('systemctl', 'show', 'ainvr-alarm', '-p', 'WorkingDirectory', '--value')
        assert old.startswith(str(root / 'deploy/s100p/alarm-service/'))
        assert old.encode() in old_unit
        atomic(unit, old_unit.replace(old.encode(), str(release).encode()))
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'ainvr-alarm')
        for _ in range(45):
            try:
                status = deploy.get('http://127.0.0.1:' + str(cfg['port']) + '/v1/status', {'Authorization': 'Bearer ' + cfg['api_token']})
                if status.get('status') == 'ready':
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('alarm health check failed')
        target.rename(previous)
        try:
            next_dir.rename(target)
        except BaseException:
            previous.rename(target)
            raise
        swapped = True
        with urllib.request.urlopen('http://127.0.0.1:8088/', timeout=10) as response:
            assert response.read() == (target / 'index.html').read_bytes()
        assert before_config == configs(), 'Runtime configuration changed'
        assert pids == {s: run('systemctl', 'show', s, '-p', 'MainPID', '--value') for s in preserved}, 'Unrelated service restarted'
        report.update(phase='deployed', preserved_services=pids)
    except BaseException:
        if swapped:
            target.rename(target.with_name('dist.review-failed-' + stamp))
            previous.rename(target)
        atomic(unit, old_unit)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'ainvr-alarm')
        report['phase'] = 'rolled_back'
        raise
    finally:
        path = root / 'test/results/review-v2-fixes-release.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2))
    print(json.dumps(report))

if __name__ == '__main__':
    main()
