#!/usr/bin/env python3
"""Publish prebuilt frontend and alarm sources only; preserve video services and configs."""
from pathlib import Path
import hashlib,importlib.util,json,os,shutil,subprocess,time,urllib.request
R=Path('/home/sunrise/ainvr')
def run(*args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT,timeout=60).strip()
def main():
 assert Path(__file__).resolve().parents[1]==R and os.geteuid()==0
 run('git','-C',str(R),'diff','--check')
 candidate=R/'srs-web-console/frontend/dist.review-followup';target=candidate.with_name('dist')
 assert (candidate/'index.html').is_file()
 spec=importlib.util.spec_from_file_location('d',R/'deploy-package/deploy-alarm-review.py');d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
 cfg=d.config('alarm-service');headers={'Authorization':'Bearer '+cfg['api_token']};url='http://127.0.0.1:'+str(cfg['port'])+'/v1/status'
 stamp=time.strftime('%Y%m%d-%H%M%S');backup=R/'deploy/s100p'/('rollback-followup-'+stamp);backup.mkdir()
 unit=Path('/etc/systemd/system/ainvr-alarm.service');original=unit.read_bytes();(backup/unit.name).write_bytes(original)
 old=Path(run('systemctl','show','ainvr-alarm','-p','WorkingDirectory','--value'));assert old.parent==R/'deploy/s100p/alarm-service'
 release=old.parent/('release-followup-'+stamp);release.mkdir();shutil.copytree(R/'alarm-service/src',release/'src');os.symlink(R/'alarm-service/node_modules',release/'node_modules')
 services=['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-llm','ainvr-backend'];pids={s:run('systemctl','show',s,'-p','MainPID','--value') for s in services}
 def hashes():return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (R/'deploy/s100p/runtime').glob('*.json')}
 before=hashes();swapped=False
 def install(data):
  tmp=unit.with_name(unit.name+'.followup-next');tmp.write_bytes(data);tmp.chmod(unit.stat().st_mode);os.replace(tmp,unit)
 report={'release':str(release),'backup':str(backup),'previous_alarm':str(old),'head':run('git','-C',str(R),'rev-parse','HEAD')}
 try:
  assert str(old).encode() in original
  install(original.replace(str(old).encode(),str(release).encode()));run('systemctl','daemon-reload');run('systemctl','restart','ainvr-alarm')
  for _ in range(30):
   try:
    if d.get(url,headers).get('status')=='ready':break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('Alarm readiness failed')
  for p in (target/'assets').glob('*'):
   q=candidate/'assets'/p.name
   if p.is_file() and not q.exists():shutil.copy2(p,q)
  target.rename(backup/'frontend')
  try:candidate.rename(target)
  except BaseException:(backup/'frontend').rename(target);raise
  swapped=True
  assert hashes()==before
  assert pids=={s:run('systemctl','show',s,'-p','MainPID','--value') for s in services}
  with urllib.request.urlopen('http://127.0.0.1:8088/',timeout=5) as f:assert f.read()==(target/'index.html').read_bytes()
  with urllib.request.urlopen('http://127.0.0.1:8088/api/health',timeout=5) as f:assert f.status==200
  report['phase']='deployed'
 except BaseException:
  if swapped:target.rename(backup/'frontend-failed');(backup/'frontend').rename(target)
  install(original);run('systemctl','daemon-reload');run('systemctl','restart','ainvr-alarm');report['phase']='rolled_back';raise
 finally:(backup/'report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report))
if __name__=='__main__':main()
