from pathlib import Path
import datetime, hashlib, json, os, shutil, subprocess, time, urllib.request
root=Path('/home/sunrise/ainvr').resolve()
manifest=root/'test/results/stats-analytics-20261030/deployment.json'
data=json.loads(manifest.read_text())
release=Path(data['alarm_release']).resolve()
assert release.is_relative_to(root/'deploy/s100p/alarm-service')
assert subprocess.check_output(['systemctl','show','ainvr-alarm','-p','WorkingDirectory','--value'],text=True).strip()==str(release)
backup=Path(data['backups']['alarm-service'])
assert backup.is_relative_to(Path('/mnt/ainvr-ssd/ainvr-rollback/alarm-service')) and (backup/'src/main.mjs').is_file()
assert os.stat(backup).st_dev != os.stat('/').st_dev
names=['region-heat.mjs','region-heat-query.mjs']
old={name:(release/'src'/name).read_bytes() for name in names}
for name in names: subprocess.run(['node','--check',str(root/'alarm-service/src'/name)],check=True)
def install(name,content):
 target=release/'src'/name
 temp=target.with_name(name+'.analytics-publish')
 temp.write_bytes(content); temp.chmod(0o644); os.replace(temp,target)
def ready():
 for _ in range(50):
  try:
   with urllib.request.urlopen('http://127.0.0.1:8200/readyz',timeout=2) as response:
    if response.status==200:return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('Alarm readiness failed')
try:
 subprocess.run(['systemctl','stop','ainvr-alarm'],check=True)
 for name in names:install(name,(root/'alarm-service/src'/name).read_bytes())
 subprocess.run(['systemctl','start','ainvr-alarm'],check=True);ready()
except Exception:
 subprocess.run(['systemctl','stop','ainvr-alarm'],check=False)
 for name in names:install(name,old[name])
 subprocess.run(['systemctl','start','ainvr-alarm'],check=False)
 raise
data['heat_compatible_sessions_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
data['heat_runtime_hashes']={name:hashlib.sha256((release/'src'/name).read_bytes()).hexdigest() for name in names}
data['protected_pids_unchanged']=all(subprocess.check_output(['systemctl','show',service,'-p','MainPID','--value'],text=True).strip()==pid for service,pid in data['before'].items())
assert data['protected_pids_unchanged']
temp=manifest.with_suffix('.json.analytics-publish');temp.write_text(json.dumps(data,indent=2)+'\n');os.replace(temp,manifest)
print(json.dumps({k:data[k] for k in ['heat_compatible_sessions_at','protected_pids_unchanged','heat_runtime_hashes']}))
