#!/usr/bin/env python3
"""Install independent alarm/console candidates with rollback; never stop video services."""
import argparse,hashlib,json,os,pathlib,pwd,shutil,subprocess,time,urllib.request
ROOT=pathlib.Path('/home/sunrise/ainvr');SSD=pathlib.Path('/mnt/ainvr-ssd')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def tree_sha(p):return hashlib.sha256(json.dumps([(str(f.relative_to(p)),sha(f)) for f in sorted(p.rglob('*')) if f.is_file()]).encode()).hexdigest()
def cmd(args):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60).stdout.decode().strip()
def system(s,k):return cmd(['systemctl','show',s,'-p',k,'--value'])
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--web-candidate',required=True,type=pathlib.Path);args=parser.parse_args();candidate=args.web_candidate
 owner=pwd.getpwnam('sunrise');stamp=time.strftime('%Y%m%d-%H%M%S');units=[];swapped=[];next_dirs=[];alarm_started=False;backend_touched=False
 report={'started_at':time.time(),'phase':'preflight','recorder_restarted':False,'ai_restarted':False,'frontend_installed':False}
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);(ROOT/'test/results/alarm-console-deployment-20261019.json').write_text(json.dumps(report,indent=2)+'\n')
 def get(url,headers=None):
  with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=5) as r:return json.load(r)
 def add_unit(p,text):
  if p.exists() or p.is_symlink():raise RuntimeError('Existing unit needs reconciliation')
  p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);os.chmod(p,0o644);units.append((p,sha(p)))
 def swap(name):
  target=ROOT/'srs-web-console'/name/'dist';next_dir=target.with_name('dist.alarm-next-'+stamp)
  if tree_sha(target)!=report[name+'_before_sha256']:raise RuntimeError('Concurrent console deployment')
  previous=target.with_name('dist.alarm-before-'+stamp);target.rename(previous);next_dir.rename(target);swapped.append((target,previous,tree_sha(target)))
 try:
  if os.geteuid()!=0 or not SSD.is_mount() or candidate.resolve()!=candidate or not str(candidate).startswith('/mnt/ainvr-ssd/ainvr-alarm-web-'):raise RuntimeError('Verified board SSD candidate required')
  built=json.loads((candidate/'status.json').read_text());manifest=json.loads((candidate/'source-manifest.json').read_text())
  if built['phase']!='passed' or any(sha(ROOT/r)!=h for r,h in manifest.items()):raise RuntimeError('Web source generation changed')
  for artifact in built['artifacts'].values():
   if tree_sha(pathlib.Path(artifact['root']))!=artifact['sha256']:raise RuntimeError('Web artifact changed')
  bootstrap=json.loads((ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json').read_text());envfile=ROOT/'deploy/s100p/runtime/alarm-service-backend.env'
  if not envfile.is_file():raise RuntimeError('Provision central settings first')
  baseline={s:{k:system(s,k) for k in ['MainPID','ActiveState','ExecMainStartTimestampMonotonic']} for s in ['ainvr-recorder.service','ainvr-ai.service']}
  if any(v['ActiveState']!='active' for v in baseline.values()):raise RuntimeError('Existing video services must be active')
  parent=ROOT/'deploy/s100p/alarm-service';parent.mkdir(mode=0o755,exist_ok=True);release=parent/('release-'+stamp);release.mkdir(mode=0o755)
  source=ROOT/'alarm-service';sources={str(p.relative_to(source)):sha(p) for p in (source/'src').glob('*.mjs')}
  shutil.copytree(source/'src',release/'src');shutil.copytree(source/'node_modules',release/'node_modules',symlinks=True)
  for name in ['package.json','package-lock.json']:shutil.copy2(source/name,release/name)
  if any(sha(source/r)!=h or sha(release/r)!=h for r,h in sources.items()):raise RuntimeError('Alarm source changed during packaging')
  (release/'source-manifest.json').write_text(json.dumps(sources,indent=2)+'\n')
  for folder,dirs,files in os.walk(release,followlinks=False):
   os.chown(folder,owner.pw_uid,owner.pw_gid)
   for name in dirs+files:
    p=pathlib.Path(folder)/name
    if p.is_symlink():os.lchown(p,owner.pw_uid,owner.pw_gid)
    else:os.chown(p,owner.pw_uid,owner.pw_gid)
  for name in ['backend','frontend']:
   target=ROOT/'srs-web-console'/name/'dist';next_dir=target.with_name('dist.alarm-next-'+stamp);report[name+'_before_sha256']=tree_sha(target)
   shutil.copytree(built['artifacts'][name]['root'],next_dir);next_dirs.append(next_dir)
   if name=='frontend' and (target/'assets').exists():
    for file in (target/'assets').iterdir():
     if file.is_file() and not (next_dir/'assets'/file.name).exists():shutil.copy2(file,next_dir/'assets'/file.name)
  for p in [SSD/'ainvr-observations',SSD/'ainvr-alarm-evidence']:
   p.mkdir(mode=0o700,exist_ok=True)
   if p.is_symlink():raise RuntimeError('Private SSD directories must not be symlinks')
   os.chown(p,owner.pw_uid,owner.pw_gid);os.chmod(p,0o700)
  unit=ROOT/'deploy/s100p/ainvr-alarm.service'
  lines=['[Unit]','Description=AINVR independent alarm service','After=network-online.target docker.service ainvr-backend.service','Wants=network-online.target','StartLimitIntervalSec=60','StartLimitBurst=5','[Service]','Type=simple','User=sunrise','Group=sunrise','WorkingDirectory='+str(release),'ExecStart=/opt/ainvr/node-v24.20.0-linux-arm64/bin/node '+str(release)+'/src/main.mjs --config-center '+str(ROOT)+'/deploy/s100p/runtime/alarm-service-bootstrap.json','Environment=AINVR_OBSERVATION_SPOOL_ROOT=/mnt/ainvr-ssd/ainvr-observations','Environment=AINVR_ALARM_EVIDENCE_ROOT=/mnt/ainvr-ssd/ainvr-alarm-evidence','Restart=on-failure','RestartSec=3','TimeoutStopSec=30','KillMode=mixed','NoNewPrivileges=true','PrivateTmp=true','ProtectSystem=strict','ProtectHome=read-only','ReadWritePaths=/mnt/ainvr-ssd/ainvr-observations /mnt/ainvr-ssd/ainvr-alarm-evidence','RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6','MemoryMax=768M','TasksMax=128','LimitNOFILE=4096','UMask=0077','[Install]','WantedBy=multi-user.target','']
  add_unit(unit,'\n'.join(lines));link=pathlib.Path('/etc/systemd/system/ainvr-alarm.service')
  if link.exists() or link.is_symlink():raise RuntimeError('Alarm system unit already exists')
  link.symlink_to(unit);units.append((link,None));add_unit(pathlib.Path('/etc/systemd/system/ainvr-backend.service.d/40-alarm-service.conf'),'[Service]\nEnvironmentFile='+str(envfile)+'\n')
  cmd(['systemd-analyze','verify',str(unit)]);save('installing-backend',release=str(release),baseline=baseline)
  swap('backend');cmd(['systemctl','daemon-reload']);backend_touched=True;cmd(['systemctl','restart','ainvr-backend.service']);deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   try:
    if get('http://127.0.0.1:3001/api/health').get('data',{}).get('status')=='ok':break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('Backend readiness failed')
  cmd(['systemctl','enable','--now','ainvr-alarm.service']);alarm_started=True;save('checking-alarm');headers={'x-service-token':bootstrap['service_token']};deadline=time.monotonic()+75;status=None
  while time.monotonic()<deadline:
   try:
    state=get('http://127.0.0.1:3001/api/v1/config/service-states/alarm-service',headers)['data']
    if state.get('status')=='applied' and state.get('appliedVersion')==state.get('desiredVersion'):
     docs=get('http://127.0.0.1:3001/api/v1/config/versions/'+str(state['appliedVersion'])+'/snapshot?service=alarm-service',headers)['data'];settings=docs[0]['config']
     status=get('http://127.0.0.1:'+str(settings['port'])+'/v1/status',{'authorization':'Bearer '+settings['api_token']})
     if status['status']=='ready' and status['storage']['writable'] and status['rule_configuration']['state']=='applied':break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('Alarm config/rule application failed')
  swap('frontend')
  if any({k:system(s,k) for k in old}!=old for s,old in baseline.items()):raise RuntimeError('Video service changed externally')
  save('passed',frontend_installed=True,alarm_pid=system('ainvr-alarm.service','MainPID'),applied_version=status['config']['applied_version'],rule_revision=status['rule_configuration']['revision'],evidence_vault=status['evidence_vault'],rollback_directories=[str(v[1]) for v in swapped],video_services_unchanged=True)
 except Exception as error:
  save('rolling-back',error_type=type(error).__name__)
  if alarm_started:subprocess.run(['systemctl','disable','--now','ainvr-alarm.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=45)
  for target,previous,h in reversed(swapped):
   if tree_sha(target)!=h:raise RuntimeError('Concurrent dist change prevents rollback')
   target.rename(target.with_name('dist.alarm-failed-'+stamp));previous.rename(target)
  for p,h in reversed(units):
   if p.is_symlink() and h is None:p.unlink()
   elif p.is_file() and sha(p)==h:p.unlink()
  cmd(['systemctl','daemon-reload'])
  if backend_touched:cmd(['systemctl','restart','ainvr-backend.service'])
  save('rolled-back',central_settings_retained=True);raise
if __name__=='__main__':main()
