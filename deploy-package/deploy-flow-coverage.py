#!/usr/bin/env python3
"""Deploy prebuilt console backend coverage/geometry fix with rollback."""
from pathlib import Path
import subprocess,time,os,json,urllib.request,hashlib
R=Path('/home/sunrise/ainvr')
def run(*a):return subprocess.check_output(a,text=True,stderr=subprocess.STDOUT,timeout=60).strip()
def main():
 assert Path(__file__).resolve().parents[1]==R and os.geteuid()==0
 run('git','-C',str(R),'diff','--check')
 root=R/'srs-web-console/backend';candidate=root/'dist.coverage-fix';target=root/'dist'
 assert (candidate/'server.js').is_file() and (candidate/'store/migrations').is_dir()
 units=['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-alarm','ainvr-llm']
 before={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units}
 def hashes():return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (R/'deploy/s100p/runtime').glob('*.json')}
 config=hashes();backup=R/'deploy/s100p'/('rollback-coverage-'+time.strftime('%Y%m%d-%H%M%S'));backup.mkdir()
 target.rename(backup/'backend')
 report={'backup':str(backup)}
 try:
  candidate.rename(target);run('systemctl','restart','ainvr-backend')
  for _ in range(30):
   try:
    with urllib.request.urlopen('http://127.0.0.1:8088/api/health',timeout=3) as f:
     if f.status==200:break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('backend health failed')
  assert before=={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units}
  assert config==hashes()
  report.update(phase='deployed',other_service_pids_unchanged=True,config_unchanged=True)
 except BaseException:
  if target.exists():target.rename(backup/'failed-backend')
  (backup/'backend').rename(target);run('systemctl','restart','ainvr-backend');report['phase']='rolled_back';raise
 finally:(backup/'report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report))
if __name__=='__main__':main()