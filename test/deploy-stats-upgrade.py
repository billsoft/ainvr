"""Publish tested analytics UI + four alarm modules, with SSD rollback and PID gates."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,time,urllib.request
root=Path('/home/sunrise/ainvr').resolve()
results=root/'test/results/stats-upgrade-20261030';results.mkdir(parents=True,exist_ok=True)
release=Path(subprocess.check_output(['systemctl','show','ainvr-alarm','-p','WorkingDirectory','--value'],text=True).strip()).resolve()
assert release.is_relative_to(root/'deploy/s100p/alarm-service')
web=root/'srs-web-console/frontend/dist';candidate=root/'out/stats-analytics-upgrade/frontend'
assert (candidate/'index.html').is_file()
modules=['ingestion.mjs','dwell-visits.mjs','dwell-query.mjs','region-heat.mjs']
for name in modules:subprocess.run(['node','--check',str(root/'alarm-service/src'/name)],check=True)
rollback=Path('/mnt/ainvr-ssd/ainvr-rollback').resolve()
assert rollback.is_dir() and os.stat(rollback).st_dev!=os.stat('/').st_dev
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-stats-upgrade'
backups={}
alarm_changed=any((root/'alarm-service/src'/name).read_bytes()!=(release/'src'/name).read_bytes() for name in modules)
targets=([('alarm-service',release/'src','src')] if alarm_changed else [])+[('web',web,'dist')]
for service,source,subdir in targets:
 base=rollback/service;assert base.resolve().parent==rollback
 dest=base/stamp;assert not dest.exists();shutil.copytree(source,dest/subdir)
 (dest/'snapshot.json').write_text(json.dumps({'complete':True,'created_at':stamp,'source':str(source)})+'\n')
 backups[service]=str(dest)
protected=['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-llm','ainvr-search','ainvr-backend']
if not alarm_changed:protected.append('ainvr-alarm')
pid=lambda name:subprocess.check_output(['systemctl','show',name,'-p','MainPID','--value'],text=True).strip()
before={name:pid(name) for name in protected}
def install(source,target):
 target.parent.mkdir(parents=True,exist_ok=True);temp=target.with_name(target.name+'.stats-publish')
 shutil.copyfile(source,temp);temp.chmod(0o644);os.replace(temp,target)
def publish_web(source):
 for p in sorted((p for p in source.rglob('*') if p.is_file()),key=lambda p:p.name=='index.html'):
  install(p,web/p.relative_to(source))
def ready():
 for _ in range(40):
  try:
   with urllib.request.urlopen('http://127.0.0.1:8200/readyz',timeout=2) as response:
    if response.status==200:return
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError('Alarm service readiness failed')
try:
 if alarm_changed:
  subprocess.run(['systemctl','stop','ainvr-alarm'],check=True)
  for name in modules:install(root/'alarm-service/src'/name,release/'src'/name)
  subprocess.run(['systemctl','start','ainvr-alarm'],check=True)
 ready()
 publish_web(candidate)
 assert all(pid(name)==value for name,value in before.items()),'Unexpected protected process restart'
except Exception:
 if alarm_changed:
  subprocess.run(['systemctl','stop','ainvr-alarm'],check=False)
  for name in modules:install(Path(backups['alarm-service'])/'src'/name,release/'src'/name)
  subprocess.run(['systemctl','start','ainvr-alarm'],check=False)
 publish_web(Path(backups['web'])/'dist');raise
for service in backups:
 base=rollback/service
 entries=sorted(p for p in base.iterdir() if p.is_dir() and not p.is_symlink())
 for old in entries[:-3]:
  assert old.resolve().parent==base.resolve() and old.name[:8].isdigit()
  shutil.rmtree(old)
manifest={'deployed_at':stamp,'alarm_updated':alarm_changed,'alarm_release':str(release),'backups':backups,'protected_pids':before,
 'runtime_hashes':{name:hashlib.sha256((release/'src'/name).read_bytes()).hexdigest() for name in modules},
 'web_index_sha256':hashlib.sha256((web/'index.html').read_bytes()).hexdigest(),
 'backup_counts':{service:len([p for p in (rollback/service).iterdir() if p.is_dir()]) for service in backups}}
(results/'deployment.json').write_text(json.dumps(manifest,indent=2)+'\n')
(results/(stamp+'.json')).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
