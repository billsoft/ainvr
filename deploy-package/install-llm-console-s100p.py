#!/usr/bin/env python3
"""First production installation of the LLM control plane. Inference stays disabled.

Requires a frozen console build. Does not stop AI, recording, or stream services.
Never reads ION debugfs. Rollback preserves the disabled central configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/home/sunrise/ainvr')

def run(args, **kw):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=60, **kw).decode().strip()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def tree_sha(path):
    return hashlib.sha256(json.dumps([(str(p.relative_to(path)), sha(p)) for p in sorted(path.rglob('*')) if p.is_file()]).encode()).hexdigest()

def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=5) as r:
        return json.load(r)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True, type=Path)
    args = parser.parse_args()
    candidate = args.candidate
    if os.geteuid() or not Path('/mnt/ainvr-ssd').is_mount() or candidate.resolve() != candidate or not str(candidate).startswith('/mnt/ainvr-ssd/ainvr-llm-web-'):
        raise RuntimeError('Root and canonical SSD candidate required')
    manifest = json.loads((candidate/'source-manifest.json').read_text())
    built = json.loads((candidate/'status.json').read_text())
    if built['phase'] != 'passed' or any(sha(ROOT/p) != h for p, h in manifest.items()):
        raise RuntimeError('Candidate is stale or incomplete')
    for item in built['artifacts'].values():
        if tree_sha(Path(item['root'])) != item['sha256']:
            raise RuntimeError('Artifact changed')
    runtime = ROOT/'deploy/s100p/runtime'
    unit = Path('/etc/systemd/system/ainvr-llm.service')
    drop = Path('/etc/systemd/system/ainvr-backend.service.d/50-llm-service.conf')
    bootstrap = runtime/'llm-service-bootstrap.json'
    envfile = runtime/'llm-service-backend.env'
    if any(p.exists() for p in [unit, drop, bootstrap, envfile]):
        raise RuntimeError('Existing deployment must be reconciled, not overwritten')
    owner = pwd.getpwnam('sunrise')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    release = ROOT/'deploy/s100p/llm-service'/('release-'+stamp)
    release.mkdir(parents=True)
    binary = release/'ainvr_llm_service'
    shutil.copy2('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service', binary)
    binary.chmod(0o755)
    run(['ldd', str(binary)])
    baseline = {s: run(['systemctl', 'show', s, '-p', 'MainPID', '--value']) for s in ['ainvr-ai', 'ainvr-recorder', 'ainvr-ingest', 'ainvr-alarm']}
    pid = run(['systemctl', 'show', 'ainvr-backend', '-p', 'MainPID', '--value'])
    backend_env = dict(part.decode().split('=', 1) for part in Path('/proc/'+pid+'/environ').read_bytes().split(b'\0') if b'=' in part)
    report = {'started_at': time.time(), 'inference_enabled': False, 'reason': 'model_acceptance_not_completed', 'baseline': baseline}
    output = ROOT/'test/results/llm-service-development/production-install.json'
    def record(phase):
        report.update(phase=phase, updated_at=time.time())
        output.write_text(json.dumps(report, indent=2)+'\n')
    swapped, created = [], []
    nginx = runtime/'nginx.conf'
    nginx_before = nginx.read_bytes()
    try:
        token = secrets.token_hex(32)
        for path, text in [(bootstrap, json.dumps({'control_url':'http://127.0.0.1:3001', 'service_token':token})), (envfile, 'CONFIG_SERVICE_TOKEN_LLM_SERVICE='+token+'\nLLM_SERVICE_HOST=127.0.0.1\n')]:
            fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f: f.write(text+'\n')
            os.chown(path, owner.pw_uid, owner.pw_gid)
            created.append(path)
        for name in ['backend','frontend']:
            target = ROOT/'srs-web-console'/name/'dist'
            prepared = target.with_name('dist.llm-next-'+stamp)
            shutil.copytree(built['artifacts'][name]['root'], prepared)
            if name == 'frontend':
                for asset in (target/'assets').glob('*'):
                    if asset.is_file() and not (prepared/'assets'/asset.name).exists(): shutil.copy2(asset, prepared/'assets'/asset.name)
            previous = target.with_name('dist.llm-before-'+stamp)
            target.rename(previous)
            prepared.rename(target)
            swapped.append((target, previous))
        provision = run(['/usr/local/bin/node', str(ROOT/'deploy-package/provision-llm.mjs')], env=backend_env)
        report['configuration'] = json.loads(provision)
        drop.parent.mkdir(exist_ok=True)
        drop.write_text('[Service]\nEnvironmentFile='+str(envfile)+'\n')
        created.append(drop)
        unit.write_text('\n'.join(['[Unit]', 'Description=AINVR independent large model service', 'After=network-online.target ainvr-backend.service', 'Wants=network-online.target', '[Service]', 'Type=simple', 'User=sunrise', 'Group=sunrise', 'WorkingDirectory='+str(release), 'ExecStart='+str(binary)+' --bootstrap '+str(bootstrap), 'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=45', 'KillMode=mixed', 'NoNewPrivileges=true', 'UMask=0077', 'Environment=MALLOC_ARENA_MAX=2', 'InaccessiblePaths=/sys/kernel/debug', '[Install]', 'WantedBy=multi-user.target', '']))
        created.append(unit)
        run(['systemd-analyze', 'verify', str(unit)])
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', 'ainvr-backend'])
        for _ in range(45):
            try:
                if get('http://127.0.0.1:3001/api/health')['data']['status'] == 'ok': break
            except Exception: pass
            time.sleep(1)
        else: raise RuntimeError('Backend did not recover')
        tmpfiles = Path('/etc/tmpfiles.d/ainvr-large-models.conf')
        policy = (ROOT/'deploy-package/ainvr-large-models.tmpfiles.conf').read_text()
        if tmpfiles.exists() and tmpfiles.read_text() != policy:
            raise RuntimeError('Conflicting large-model runtime directory policy')
        tmpfiles.write_text(policy)
        run(['systemd-tmpfiles', '--create', str(tmpfiles)])
        run(['systemctl', 'enable', '--now', 'ainvr-llm'])
        for _ in range(45):
            try:
                health = get('http://127.0.0.1:8300/health')
                if health['config_version'] == report['configuration']['version'] and health['model'] == 'unloaded': break
            except Exception: pass
            time.sleep(1)
        else: raise RuntimeError('LLM disabled configuration not acknowledged')
        # A dedicated location allows image requests without changing other APIs.
        text = nginx_before.decode()
        if 'location /api/llm/' in text: raise RuntimeError('Reconcile existing LLM proxy')
        text = text.replace('    location /api/ {', '    location /api/llm/ { proxy_pass http://127.0.0.1:3001/api/llm/; client_max_body_size 12m; proxy_read_timeout 450s; proxy_buffering off; }\n    location /api/ {', 1)
        nginx.write_text(text)
        run(['/usr/sbin/nginx','-t','-p',str(runtime/'nginx')+'/', '-c',str(nginx)])
        run(['systemctl','reload','ainvr-web'])
        run(['systemctl','restart','ainvr-restart-helper'])
        current = {s:run(['systemctl','show',s,'-p','MainPID','--value']) for s in baseline}
        if current != baseline: raise RuntimeError('Video/alarm process changed during release')
        report.update(health=health, binary_sha256=sha(binary), console_artifacts=built['artifacts'], rollback_directories=[str(p) for _,p in swapped], production_processes_unchanged=True)
        record('control-plane-deployed-inference-disabled')
        print(json.dumps({'phase':report['phase'], 'configuration_version':report['configuration']['version']}))
    except Exception:
        record('rolling-back')
        subprocess.run(['systemctl','disable','--now','ainvr-llm'], capture_output=True, timeout=55)
        nginx.write_bytes(nginx_before)
        for target, previous in reversed(swapped):
            target.rename(target.with_name('dist.llm-failed-'+stamp))
            previous.rename(target)
        for path in reversed(created): path.unlink(missing_ok=True)
        run(['systemctl','daemon-reload'])
        run(['systemctl','restart','ainvr-backend'])
        run(['systemctl','reload','ainvr-web'])
        record('rolled-back-disabled-settings-retained')
        raise

if __name__ == '__main__': main()
