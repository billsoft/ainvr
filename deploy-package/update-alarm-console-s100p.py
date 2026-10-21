#!/usr/bin/env python3
"""Update verified AINVR alarm/console artifacts; retain rollback, never restart video."""
import argparse,hashlib,json,os,pathlib,pwd,shutil,subprocess,time,urllib.request
ROOT=pathlib.Path('/home/sunrise/ainvr');SSD=pathlib.Path('/mnt/ainvr-ssd')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def tree(p):return hashlib.sha256(json.dumps([(str(f.relative_to(p)),sha(f)) for f in sorted(p.rglob('*')) if f.is_file()]).encode()).hexdigest()
def cmd(args):return subprocess.run(args,check=True,capture_output=True,timeout=60).stdout.decode().strip()
def identity(service):return {k:cmd(['systemctl','show',service,'-p',k,'--value']) for k in ['MainPID','ActiveState','ExecMainStartTimestampMonotonic']}
def get(url,headers=None):
 with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=8) as r:return json.load(r)
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--web-candidate',type=pathlib.Path,required=True);parser.add_argument('--frontend-only',action='store_true');parser.add_argument('--alarm-candidate',type=pathlib.Path);a=parser.parse_args();out=a.web_candidate
 if os.geteuid()!=0 or not SSD.is_mount() or out.resolve()!=out or not out.is_relative_to(SSD):raise SystemExit('Canonical SSD candidate and board root required')
 stamp=time.strftime('%Y%m%d-%H%M%S');report={'phase':'preflight','started_at':time.time(),'video_services_restarted':False};swapped=[];changed_unit=False;backend_touched=False;migration_started=False;recovery=None;db_env=None;guard_file=None
 unit=ROOT/'deploy/s100p/ainvr-alarm.service';old_unit=unit.read_bytes();unit_hash=sha(unit)
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);(ROOT/('test/results/alarm-submit-dashboard-deployment-20261019.json' if a.frontend_only else 'test/results/alarm-submit-deployment-20261019.json')).write_text(json.dumps(report,indent=2)+'\n')
 try:
  built=json.loads((out/'status.json').read_text());manifest=json.loads((out/'source-manifest.json').read_text())
  if built['phase']!='passed' or any(sha(ROOT/r)!=h for r,h in manifest.items()):raise RuntimeError('Web source is not the verified generation')
  for artifact in built['artifacts'].values():
   if tree(pathlib.Path(artifact['root']))!=artifact['sha256']:raise RuntimeError('Candidate artifact changed')
  baseline={s:identity(s) for s in ['ainvr-ai.service','ainvr-recorder.service']}
  if any(v['ActiveState']!='active' for v in baseline.values()):raise RuntimeError('Video services must already be running')
  if a.frontend_only:
   target=ROOT/'srs-web-console/frontend/dist';old_hash=tree(target);next_dir=target.with_name('dist.alarm-next-'+stamp);backup=target.with_name('dist.alarm-before-'+stamp)
   shutil.copytree(built['artifacts']['frontend']['root'],next_dir)
   for f in (target/'assets').iterdir():
    if f.is_file() and not (next_dir/'assets'/f.name).exists():shutil.copy2(f,next_dir/'assets'/f.name)
   if tree(target)!=old_hash:raise RuntimeError('Concurrent frontend deployment')
   target.rename(backup);next_dir.rename(target);swapped.append((target,backup,tree(target)))
   if get('http://127.0.0.1:3001/api/health').get('data',{}).get('status')!='ok':raise RuntimeError('Backend is not ready')
   if any(identity(s)!=old for s,old in baseline.items()):raise RuntimeError('Video service identity changed')
   if any(sha(ROOT/r)!=h for r,h in manifest.items()):raise RuntimeError('Concurrent source edit')
   save('passed',frontend_only=True,web_candidate=str(out),artifact_sha256=built['artifacts']['frontend']['sha256'],baseline=baseline,rollback_directory=str(backup),video_services_unchanged=True)
   return
  bootstrap=json.loads((ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json').read_text());headers={'x-service-token':bootstrap['service_token']}
  def alarm():
   state=get('http://127.0.0.1:3001/api/v1/config/service-states/alarm-service',headers)['data']
   if state.get('status')!='applied' or state.get('appliedVersion')!=state.get('desiredVersion'):raise RuntimeError('Configuration not applied')
   docs=get('http://127.0.0.1:3001/api/v1/config/versions/'+str(state['appliedVersion'])+'/snapshot?service=alarm-service',headers)['data'];cfg=docs[0]['config']
   url='http://127.0.0.1:'+str(cfg['port']);auth={'authorization':'Bearer '+cfg['api_token']}
   return get(url+'/v1/status',auth),url,auth
  before,_,_=alarm()
  candidate=a.alarm_candidate
  if candidate is None or candidate.resolve()!=candidate or not candidate.is_relative_to(SSD):raise RuntimeError('Verified frozen alarm candidate required')
  accepted=json.loads((candidate/'status.json').read_text())
  if accepted.get('phase')!='passed' or accepted.get('counts',{}).get('skipped')!=0:raise RuntimeError('Alarm candidate acceptance incomplete')
  if sha(candidate/'artifact-manifest.json')!=accepted['artifact_manifest_sha256']:raise RuntimeError('Alarm manifest changed')
  frozen=candidate/'release';artifacts=json.loads((candidate/'artifact-manifest.json').read_text())
  actual={str(p.relative_to(frozen)):sha(p) for p in frozen.rglob('*') if p.is_file()}
  if actual!=artifacts or any(p.is_symlink() for p in frozen.rglob('*')):raise RuntimeError('Alarm frozen release changed')
  source=ROOT/'alarm-service';sources=json.loads((candidate/'source-manifest.json').read_text())
  if any(sha(source/r)!=h for r,h in sources.items()):raise RuntimeError('Alarm source is not the verified generation')
  release=ROOT/'deploy/s100p/alarm-service'/('release-'+stamp)
  shutil.copytree(frozen,release)
  if {str(p.relative_to(release)):sha(p) for p in release.rglob('*') if p.is_file()}!=artifacts:raise RuntimeError('Alarm release copy mismatch')
  old_work=next(line.split('=',1)[1] for line in old_unit.decode().splitlines() if line.startswith('WorkingDirectory='))
  old_release=pathlib.Path(old_work)
  if old_release.parent!=release.parent or not old_release.is_dir():raise RuntimeError('Unexpected live alarm release')
  (release/'source-manifest.json').write_text(json.dumps(sources,indent=2)+'\n')
  owner=pwd.getpwnam('sunrise')
  for p in [release,*release.rglob('*')]:
   if p.is_symlink():os.lchown(p,owner.pw_uid,owner.pw_gid)
   else:os.chown(p,owner.pw_uid,owner.pw_gid)
  new_unit=old_unit.decode().replace(old_work,str(release)).encode()
  recovery=SSD/('ainvr-alarm-rollout-'+stamp);recovery.mkdir(mode=0o700)
  for name in ['alarm_offline_migration.mjs','alarm_migration_rollback.mjs']:
   shutil.copy2(ROOT/'test/ai_port'/name,recovery/name)
  backend_root=pathlib.Path(built['artifacts']['backend']['root']).parent
  pid=int(cmd(['systemctl','show','ainvr-backend.service','-p','MainPID','--value']))
  live_env=dict(item.split(b'=',1) for item in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
  db_env=os.environ.copy()
  for key in ['CONFIG_PG_HOST','CONFIG_PG_PORT','CONFIG_PG_USER','CONFIG_PG_PASSWORD','CONFIG_PG_DATABASE']:
   if key.encode() in live_env:db_env[key]=live_env[key.encode()].decode()
  if not db_env.get('CONFIG_PG_HOST') or not db_env.get('CONFIG_PG_DATABASE'):raise RuntimeError('Database environment unavailable')
  guard_file=recovery/'migration-checkpoint.json'
  def offline(mode):
   r=subprocess.run(['node',str(recovery/'alarm_offline_migration.mjs'),mode,str(backend_root),str(guard_file)],env=db_env,capture_output=True,timeout=120)
   if r.returncode:raise RuntimeError('Offline migration/recovery failed')
   return json.loads(r.stdout)
  save('prepared',release=str(release),baseline=baseline,source_manifest=sources,web_candidate=str(out),recovery_directory=str(recovery))
  # Close writers before the migration; no video service is touched.
  backend_touched=True
  cmd(['systemctl','stop','ainvr-backend.service']);cmd(['systemctl','stop','ainvr-alarm.service'])
  dump=recovery/'configuration-before.dump'
  with dump.open('xb') as output:
   os.chmod(dump,0o600)
   r=subprocess.run(['docker','exec','ainvr-postgres','sh','-c','pg_dump -U "$POSTGRES_USER" -d "$1" --format=custom','alarm-backup',db_env['CONFIG_PG_DATABASE']],stdout=output,stderr=subprocess.PIPE,timeout=120)
  if r.returncode or dump.stat().st_size<100:raise RuntimeError('Deployment backup failed')
  save('database-backed-up',backup_sha256=sha(dump))
  migration_started=True
  checkpoint=offline('prepare')
  save('database-prepared',migration_checkpoint=checkpoint)
  for name in ['backend','frontend']:
   target=ROOT/'srs-web-console'/name/'dist';old_hash=tree(target);next_dir=target.with_name('dist.alarm-next-'+stamp);backup=target.with_name('dist.alarm-before-'+stamp)
   shutil.copytree(built['artifacts'][name]['root'],next_dir)
   if name=='frontend':
    for f in (target/'assets').iterdir():
     if f.is_file() and not (next_dir/'assets'/f.name).exists():shutil.copy2(f,next_dir/'assets'/f.name)
   if tree(target)!=old_hash:raise RuntimeError('Concurrent deployment')
   target.rename(backup);next_dir.rename(target);swapped.append((target,backup,tree(target)))
  if sha(unit)!=unit_hash:raise RuntimeError('Concurrent service unit change')
  (release/'previous-unit.service').write_bytes(old_unit)
  temp=unit.with_name(unit.name+'.update');temp.write_bytes(new_unit);os.chmod(temp,0o644);temp.replace(unit);changed_unit=True
  cmd(['systemd-analyze','verify',str(unit)]);cmd(['systemctl','daemon-reload']);backend_touched=True
  cmd(['systemctl','restart','ainvr-backend.service']);cmd(['systemctl','restart','ainvr-alarm.service'])
  deadline=time.monotonic()+80
  while time.monotonic()<deadline:
   try:
    current,url,auth=alarm()
    if current['status']=='ready' and current['storage']['writable'] and current['rule_configuration']['state']=='applied':break
   except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('Alarm did not become ready')
  # Exercise new timezone/group API against real installed code.
  get(url+'/v1/behavior-statistics?from=2026-10-19T00:00:00Z&to=2026-10-20T00:00:00Z&bucket=day&timezone=Asia%2FShanghai&group_by=entry_direction',auth)
  if any(identity(s)!=old for s,old in baseline.items()):raise RuntimeError('Video service identity changed')
  if any(sha(ROOT/r)!=h for r,h in manifest.items()) or any(sha(source/r)!=h for r,h in sources.items()):raise RuntimeError('Concurrent source edit')
  save('passed',applied_version=current['config']['applied_version'],rule_revision=current['rule_configuration']['revision'],rollback_directories=[str(p) for _,p,_ in swapped],unit_sha256=sha(unit),video_services_unchanged=True)
 except Exception as e:
  save('rolling-back',error_type=type(e).__name__)
  if backend_touched:
   cmd(['systemctl','stop','ainvr-backend.service']);cmd(['systemctl','stop','ainvr-alarm.service'])
  if changed_unit:
   if unit.read_bytes()!=new_unit:raise RuntimeError('Concurrent unit change prevents rollback')
   unit.write_bytes(old_unit)
  for target,backup,h in reversed(swapped):
   if tree(target)!=h:raise RuntimeError('Concurrent deployment prevents rollback')
   target.rename(target.with_name('dist.alarm-failed-'+stamp));backup.rename(target)
  restored=False;expected_recovery_revision=before['rule_configuration']['revision'] if backend_touched else None
  if backend_touched:
   if migration_started:
    try:
     if guard_file is None or not guard_file.exists():raise RuntimeError('Migration checkpoint unavailable')
     result=offline('rollback');restored=True;expected_recovery_revision=result.get('revision',expected_recovery_revision)
     save('database-recovered',database_recovery=result)
    except Exception:
     # Do not start either old/new configuration publishers with unverified rules.
     save('manual-recovery-required',database_restored=False,business_configuration_verified=False,backend_stopped=True,alarm_stopped=True)
     raise
   cmd(['systemctl','daemon-reload']);cmd(['systemctl','start','ainvr-backend.service']);cmd(['systemctl','start','ainvr-alarm.service'])
   deadline=time.monotonic()+80
   while time.monotonic()<deadline:
    try:
     current,_,_=alarm()
     if current['status']=='ready' and current['rule_configuration']['state']=='applied' and str(current['rule_configuration']['revision'])==str(expected_recovery_revision):break
    except Exception:pass
    time.sleep(1)
   else:
    save('recovery-application-unconfirmed',database_restored=restored,business_configuration_verified=False);raise RuntimeError('Recovered service rules not confirmed')
  save('rolled-back',database_restored=restored,business_configuration_verified=backend_touched);raise
if __name__=='__main__':main()
