#!/usr/bin/env python3
"""Publish prebuilt rectangle editor without restarting any service; restore on verification failure."""
from pathlib import Path
import subprocess,time,shutil,urllib.request,json
R=Path('/home/sunrise/ainvr')
def run(*a):return subprocess.check_output(a,text=True,timeout=30).strip()
def main():
 run('git','-C',str(R),'diff','--check')
 root=R/'srs-web-console/frontend';candidate=root/'dist.rotate-zone';target=root/'dist'
 assert (candidate/'index.html').is_file()
 stamp=time.strftime('%Y%m%d-%H%M%S');backup=R/'deploy/s100p'/('rollback-rectangle-'+stamp);backup.mkdir()
 units=['ainvr-ai','ainvr-alarm','ainvr-backend','ainvr-recorder','ainvr-ingest','ainvr-llm']
 before={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units}
 for p in (target/'assets').glob('*'):
  q=candidate/'assets'/p.name
  if p.is_file() and not q.exists():shutil.copy2(p,q)
 target.rename(backup/'frontend')
 try:
  candidate.rename(target)
  with urllib.request.urlopen('http://127.0.0.1:8088/',timeout=5) as f:assert f.read()==(target/'index.html').read_bytes()
  with urllib.request.urlopen('http://127.0.0.1:8088/api/health',timeout=5) as f:assert f.status==200
  assert before=={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units}
 except BaseException:
  if target.exists():target.rename(backup/'failed-frontend')
  (backup/'frontend').rename(target);raise
 report={'phase':'deployed','backup':str(backup),'index':(target/'index.html').read_text(),'services_unchanged':True}
 (backup/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
if __name__=='__main__':main()
