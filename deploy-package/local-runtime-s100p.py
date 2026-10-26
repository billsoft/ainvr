#!/usr/bin/env python3
"""Detach AI configuration and bounded observation journal from removable storage.
Run only after installing and verifying all runtime models on board storage.
Defaults to inspection; --apply preserves rollback files and current config.
"""
import argparse,datetime,json,os,pwd,shutil,subprocess
from pathlib import Path
ROOT=Path('/home/sunrise/ainvr'); SSD=Path('/mnt/ainvr-ssd'); SYSTEM=Path('/etc/systemd/system')
def run(*args):return subprocess.run(args,check=True,text=True,capture_output=True,timeout=90)
def write(p,text):
 p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.local-runtime.tmp');tmp.write_text(text);tmp.chmod(0o644);os.replace(tmp,p)
def main():
 a=argparse.ArgumentParser(description=__doc__);a.add_argument('--apply',action='store_true');args=a.parse_args()
 assert ROOT.resolve()==ROOT
 models=ROOT/'ai-service/models'
 for rel in ['derived/s100p/yolo26x.hbm','derived/s100p/yolo26x-face.hbm','gpen_bfr_256.hbm','derived/s100p/yoloe-26x-32.hbm','llm/qwen3vl-4b-review-v3/llm-package.ainvr.json']:
  p=models/rel;assert p.is_file() and p.stat().st_dev==ROOT.stat().st_dev,'Install board-local runtime first: '+str(p)
 print(json.dumps({'ai_state_is_mounted':(ROOT/'data/ai').is_mount(),'apply':args.apply}))
 if not args.apply:return
 assert os.geteuid()==0
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S');backup=ROOT/'.Codex-trash'/('local-runtime-'+stamp);backup.mkdir(parents=True,mode=0o700)
 fstab=Path('/etc/fstab');shutil.copy2(fstab,backup/'fstab')
 services=['ainvr-ai','ainvr-alarm','ainvr-review-reference']
 active={s:subprocess.run(['systemctl','is-active','--quiet',s]).returncode==0 for s in services}
 # The legacy LocateAnything research daemon is not a supported runtime model.
 try:
  # Optional retired unit may already be absent after a successful migration.
  for service in services:
   if active[service]:run('systemctl','stop',service)
  legacy='ainvr-locateanything-official-bpu.service'
  loaded=subprocess.run(['systemctl','show',legacy,'-p','LoadState','--value'],capture_output=True,text=True).stdout.strip()=='loaded'
  if loaded:
   run('systemctl','stop',legacy)
   run('systemctl','disable',legacy)
  state=ROOT/'data/ai';config=(state/'config_overlay.json').read_bytes()
  (backup/'config_overlay.json').write_bytes(config);(backup/'config_overlay.json').chmod(0o600)
  old='/mnt/ainvr-ssd/ai /home/sunrise/ainvr/data/ai none bind,x-systemd.requires-mounts-for=/mnt/ainvr-ssd 0 0'
  text=fstab.read_text();lines=text.splitlines()
  mounts=[l for l in lines if l.strip() and not l.lstrip().startswith('#') and len(l.split())>1 and l.split()[1]==str(state)]
  assert not mounts or mounts==[old],'Unexpected AI mount: inspect manually'
  if state.is_mount():run('umount',str(state))
  write(fstab,'\n'.join(l for l in lines if l!=old)+'\n')
  state.mkdir(exist_ok=True);tmp=state/'config_overlay.json.local-runtime.tmp';tmp.write_bytes(config);tmp.chmod(0o600);os.replace(tmp,state/'config_overlay.json')
  for name in ['30-ainvr-ssd.conf','45-locateanything-official-bpu.conf']:
   p=SYSTEM/'ainvr-ai.service.d'/name
   if p.exists():shutil.move(str(p),str(backup/name))
  # Preserve the journal identity/offset so queued facts retain idempotency.
  journal=ROOT/'data/observations'
  if not journal.exists():
   if (SSD/'ainvr-observations').is_dir():shutil.copytree(SSD/'ainvr-observations',journal,symlinks=False)
   else:journal.mkdir(parents=True)
  assert journal.stat().st_dev==ROOT.stat().st_dev
  analytics=ROOT/'data/analytics';analytics.mkdir(exist_ok=True)
  owner=pwd.getpwnam('sunrise')
  for base in [state,journal,analytics]:
   os.chown(base,owner.pw_uid,owner.pw_gid);base.chmod(0o700)
   for parent,dirs,files in os.walk(base):
    for name in dirs+files:
     p=Path(parent)/name
     if not p.is_symlink():os.chown(p,owner.pw_uid,owner.pw_gid)
  write(SYSTEM/'ainvr-ai.service.d/40-alarm-observations.conf','[Service]\nEnvironment=AINVR_OBSERVATION_SPOOL_ROOT='+str(journal)+'\nEnvironment=AINVR_ANALYTICS_STATE_ROOT='+str(analytics)+'\n')
  write(SYSTEM/'ainvr-alarm.service.d/80-local-journal.conf','[Service]\nEnvironment=AINVR_OBSERVATION_SPOOL_ROOT='+str(journal)+'\nReadWritePaths='+str(journal)+'\n')
  for p in (models/'derived/s100p').glob('locateanything*'):
   assert p.is_symlink(),'Unreviewed LocateAnything artifact';shutil.move(str(p),str(backup/p.name))
  run('systemctl','daemon-reload')
 finally:
  for s in services:
   if active[s]:run('systemctl','start',s)
 print(json.dumps({'backup':str(backup),'ai_config_local':not (ROOT/'data/ai').is_mount()}))
if __name__=='__main__':main()
