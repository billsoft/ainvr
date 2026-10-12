#!/usr/bin/env python3
"""Deploy the reused business controller with a verified rollback boundary."""
import json, os, shutil, subprocess, time, urllib.request
from pathlib import Path
root = Path(__file__).resolve().parents[2]
source = root / 'out/build/ai-api-compat/ainvr_s100p_control_service'
target = root / 'deploy/s100p/bin/ainvr_ai_service'
overlay = root / 'data/ai/config_overlay.json'
settings = json.loads((root/'deploy/s100p/runtime/ai-service.json').read_text())
headers = {'x-api-key': settings['server']['api_key']}
stamp = time.strftime('%Y%m%d-%H%M%S')
backup = Path('/mnt/ainvr-ssd/migration-backups') / ('reused-controller-' + stamp)
assert Path('/mnt/ainvr-ssd').is_mount(), 'SSD must be mounted'
backup.mkdir(mode=0o700)
assert source.is_file() and target.is_file()
shutil.copy2(target, backup/'ainvr_ai_service')
if overlay.exists():
    shutil.copy2(overlay, backup/'config_overlay.json')
    (backup/'config_overlay.json').chmod(0o600)
report = {'backup':str(backup),'passed':False,'rollback':False}
def request(path):
    r=urllib.request.Request('http://127.0.0.1:8000'+path,headers=headers)
    with urllib.request.urlopen(r,timeout=10) as f:return json.load(f)
def service(action):
    subprocess.run(['systemctl',action,'ainvr-ai'],check=True,timeout=30)
try:
    service('stop')
    pending=target.with_name(target.name+'.reused-controller.tmp')
    shutil.copy2(source,pending);pending.chmod(0o755);os.replace(pending,target)
    service('start')
    health=None
    for _ in range(60):
        try:
            health=request('/health')
            if health.get('business',{}).get('ready'):break
        except (OSError,ValueError):pass
        time.sleep(.5)
    assert health and health['version']=='ainvr-s100p-reused-control-0.2'
    assert health['business']['ready']
    assert health['disk_total_bytes']>1_000_000_000_000
    assert health['capabilities']['required_model_provider']=='bpu'
    assert not health['capabilities']['model_providers']
    channels=request('/api/v1/channels')['channels']
    for ch in channels:
        assert ch['state']=='idle'
        assert ch['stats']['inference_count']==0
        overview=request('/api/v1/channels/'+ch['id']+'/snapshots/overview')
        assert overview['connected'], 'Original Mongo history unavailable'
    assert subprocess.run(['systemctl','is-active','--quiet','ainvr-recorder']).returncode==0
    report.update(passed=True,version=health['version'],disk_total_bytes=health['disk_total_bytes'],
      channels=len(channels),cpu_inference_disabled=True,original_history_connected=True,
      recorder_active=True)
except Exception as e:
    service('stop');shutil.copy2(backup/'ainvr_ai_service',target);service('start')
    report.update(rollback=True,error_type=type(e).__name__)
    raise
finally:
    (root/'test/results/reused-controller-deployment.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
