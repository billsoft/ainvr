#!/usr/bin/env python3
"""Deploy the prebuilt tracking producer after compatible alarm/backend consumers.
Keeps configs untouched and restores the executable on failed health verification.
"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,time,urllib.request
R=Path('/home/sunrise/ainvr')
def run(*args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT,timeout=60).strip()
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 assert Path(__file__).resolve().parents[1]==R and os.geteuid()==0
 run('git','-C',str(R),'diff','--check')
 candidate=R/'out/build/ai-s100p/ainvr_s100p_control_service';target=R/'deploy/s100p/bin/ainvr_ai_service'
 assert candidate.is_file() and target.is_file()
 cfg=json.loads((R/'deploy/s100p/runtime/ai-service.json').read_text())
 url='http://127.0.0.1:'+str(cfg['server']['port'])+'/health'
 units=['ainvr-recorder','ainvr-ingest','ainvr-alarm','ainvr-backend','ainvr-llm']
 pids={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units}
 paths=list((R/'deploy/s100p/runtime').glob('*.json'))+[R/'data/ai/config_overlay.json']
 before={str(p):digest(p) for p in paths if p.exists()}
 backup=R/'deploy/s100p'/('rollback-tracking-policy-'+time.strftime('%Y%m%d-%H%M%S'));backup.mkdir()
 shutil.copy2(target,backup/'ainvr_ai_service')
 report={'backup':str(backup),'binary_sha256':digest(candidate),'phase':'prepared'}
 def install(source):
  temp=target.with_name('ainvr_ai_service.tracking-next');shutil.copy2(source,temp);temp.chmod(0o755);os.replace(temp,target)
 try:
  install(candidate);run('systemctl','restart','ainvr-ai')
  for _ in range(40):
   try:
    with urllib.request.urlopen(url,timeout=3) as f:
     assert f.status==200;json.load(f)
    assert run('systemctl','is-active','ainvr-ai')=='active'
    break
   except Exception:time.sleep(1)
  else:raise RuntimeError('AI health failed')
  assert before=={str(p):digest(p) for p in paths if p.exists()},'Configuration changed during release'
  assert pids=={s:run('systemctl','show',s,'-p','MainPID','--value') for s in units},'Unrelated service restarted'
  report.update(phase='deployed',configuration_unchanged=True,other_service_pids_unchanged=True)
 except BaseException:
  install(backup/'ainvr_ai_service');run('systemctl','restart','ainvr-ai');report['phase']='rolled_back';raise
 finally:(backup/'report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report))
if __name__=='__main__':main()
