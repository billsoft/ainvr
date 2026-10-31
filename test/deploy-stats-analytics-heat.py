"""Publish reviewed analytics artifacts; only backend/alarm are restarted."""
import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request

ROOT = pathlib.Path('/home/sunrise/ainvr').resolve()
RESULTS = ROOT / 'test/results/stats-analytics-20261030'
MANIFEST = RESULTS / 'deployment.json'
original = json.loads(MANIFEST.read_text())
stamp = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-analytics-heat'
assert re.fullmatch(r'\d{8}T\d{6}Z-analytics-heat', stamp)
release = pathlib.Path(original['alarm_release']).resolve()
assert release.is_relative_to(ROOT / 'deploy/s100p/alarm-service')
assert subprocess.check_output(['systemctl', 'show', 'ainvr-alarm', '-p', 'WorkingDirectory', '--value']).decode().strip() == str(release)
rollback = pathlib.Path('/mnt/ainvr-ssd/ainvr-rollback').resolve()
assert os.stat(rollback).st_dev != os.stat('/').st_dev, 'Mounted SSD required'
targets = {'backend': ROOT / 'srs-web-console/backend/dist', 'web': ROOT / 'srs-web-console/frontend/dist', 'alarm-service': release / 'src'}
candidates = {'backend': ROOT / 'out/stats-analytics/backend', 'web': ROOT / 'out/stats-analytics/frontend', 'alarm-service': ROOT / 'alarm-service/src'}
assert 'bindingApplicability' in (candidates['backend'] / 'routes/flowRoutes.js').read_text()
assert 'include_inactive' in (candidates['backend'] / 'routes/flowRoutes.js').read_text()
assert (candidates['web'] / 'index.html').is_file()
assert (candidates['alarm-service'] / 'region-heat-query.mjs').is_file()
backups = {}
for name, target in targets.items():
    base = rollback / name
    assert base.is_dir() and base.resolve().parent == rollback
    destination = base / stamp
    required = {'backend': 'dist/server.js', 'web': 'dist/index.html', 'alarm-service': 'src/main.mjs'}[name]
    if destination.exists():
        assert json.loads((destination / 'snapshot.json').read_text())['complete']
        assert hashlib.sha256((destination / required).read_bytes()).digest() == hashlib.sha256((target / pathlib.Path(required).name).read_bytes()).digest(), 'Cannot resume a backup after live artifacts changed'
        backups[name] = str(destination)
        continue
    entries = sorted(p for p in base.iterdir() if p.is_dir() and not p.is_symlink())
    # Historical packages can be incremental. Keep a complete rollback and the
    # still-running program intact while making this new full artifact backup.
    while len(entries) >= 3:
        assert len(entries) >= 3
        oldest = entries.pop(0)
        assert oldest.resolve().parent == base.resolve() and oldest.name[:8].isdigit()
        assert any((p / required).is_file() for p in entries), 'A complete rollback copy must remain'
        shutil.rmtree(oldest)
    assert not destination.exists()
    shutil.copytree(target, destination / ('src' if name == 'alarm-service' else 'dist'))
    required = {'backend': 'dist/server.js', 'web': 'dist/index.html', 'alarm-service': 'src/main.mjs'}[name]
    saved_main = destination / required
    live_main = target / pathlib.Path(required).name
    assert hashlib.sha256(saved_main.read_bytes()).digest() == hashlib.sha256(live_main.read_bytes()).digest()
    (destination / 'snapshot.json').write_text(json.dumps({'created_at': stamp, 'source': str(target), 'complete': True}) + '\n')
    backups[name] = str(destination)
    assert len([p for p in base.iterdir() if p.is_dir()]) <= 3
    (RESULTS / 'heat-release-pending.json').write_text(json.dumps({'phase': 'backing_up', 'backups': backups, 'stamp': stamp}, indent=2) + '\n')

def copy_artifacts(source, destination, index_last=False):
    files = sorted(p for p in source.rglob('*') if p.is_file())
    if index_last:
        files.sort(key=lambda p: p.name == 'index.html')
    for path in files:
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + '.analytics-publish')
        shutil.copyfile(path, temp); temp.chmod(0o644); os.replace(temp, target)

def ready(url):
    for _ in range(40):
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(.5)
    raise RuntimeError('Readiness gate failed: ' + url)

config_files = [ROOT / 'deploy/s100p/runtime/backend.env', ROOT / 'deploy/s100p/runtime/alarm-service-bootstrap.json']
config_before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in config_files}
(RESULTS / 'heat-release-pending.json').write_text(json.dumps({'phase': 'backed_up', 'backups': backups, 'stamp': stamp}, indent=2) + '\n')
try:
    subprocess.run(['systemctl', 'stop', 'ainvr-alarm', 'ainvr-backend'], check=True)
    copy_artifacts(candidates['backend'], targets['backend'])
    copy_artifacts(candidates['alarm-service'], targets['alarm-service'])
    subprocess.run(['systemctl', 'start', 'ainvr-backend', 'ainvr-alarm'], check=True)
    ready('http://127.0.0.1:3001/api/health')
    ready('http://127.0.0.1:8200/readyz')
    copy_artifacts(candidates['web'], targets['web'], index_last=True)
except Exception:
    subprocess.run(['systemctl', 'stop', 'ainvr-alarm', 'ainvr-backend'], check=False)
    for name in ['backend', 'alarm-service', 'web']:
        saved = pathlib.Path(backups[name]) / ('src' if name == 'alarm-service' else 'dist')
        copy_artifacts(saved, targets[name], index_last=name == 'web')
    subprocess.run(['systemctl', 'start', 'ainvr-backend', 'ainvr-alarm'], check=False)
    raise

data = {**original, 'base_feature_backups': original['backups'], 'backups': backups, 'phase': 'heat_and_historical_scope_deployed',
    'heat_release_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'frontend_index_sha256': hashlib.sha256((targets['web'] / 'index.html').read_bytes()).hexdigest(),
    'config_checksums_unchanged': config_before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in config_files},
    'protected_pids_unchanged': all(subprocess.check_output(['systemctl', 'show', service, '-p', 'MainPID', '--value']).decode().strip() == pid for service, pid in original['before'].items()),
    'backup_counts': {name: len([p for p in (rollback / name).iterdir() if p.is_dir()]) for name in targets}}
temp = MANIFEST.with_suffix('.json.analytics-publish'); temp.write_text(json.dumps(data, indent=2) + '\n'); os.replace(temp, MANIFEST)
(RESULTS / 'heat-release-pending.json').write_text(json.dumps({'phase': 'published', 'stamp': stamp, 'backups': backups}, indent=2) + '\n')
print(json.dumps({k: data[k] for k in ['phase', 'heat_release_at', 'frontend_index_sha256', 'config_checksums_unchanged', 'protected_pids_unchanged', 'backup_counts']}))
