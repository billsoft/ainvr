#!/usr/bin/env python3
"""Coordinated PTZ release. Backups only on mounted SSD, max three per service.
Never resets customer configuration, changes SRS or restarts recording/ingest.
"""
import argparse,ctypes,fcntl,hashlib,json,os,re,shutil,subprocess,time,urllib.request,uuid,sys
from pathlib import Path
from release_common import validate as validate_console,files,ready as backend_ready,atomic_bytes
from ptz_rollback_guard import preflight as ptz_preflight
ROOT=Path(__file__).resolve().parents[1]
NODE='/opt/ainvr/node-v24.20.0-linux-arm64/bin/node'
SSD=Path('/mnt/ainvr-ssd');BACKUPS=SSD/'ainvr-rollback'
DROPIN=Path('/etc/systemd/system/ainvr-alarm.service.d/95-ptz-control.conf')
TARGETS={'ai-service':ROOT/'deploy/s100p/bin/ainvr_ai_service','onvif':Path('/opt/ainvr/onvif/ainvr_onvif'),'gb28181':Path('/opt/ainvr/gb28181/gateway')}
UNITS={'ai-service':'ainvr-ai','onvif':'ainvr-onvif','gb28181':'ainvr-gb28181','alarm-service':'ainvr-alarm','backend':'ainvr-backend'}
WATCHED=['ainvr-recorder','ainvr-ingest','ainvr-gb-media','ainvr-llm','ainvr-review-reference','ainvr-web']
SERVICES=['ai-service','onvif','gb28181','alarm-service','backend','web']
def run(args,timeout=60):return subprocess.run([str(a)for a in args],capture_output=True,text=True,check=True,timeout=timeout).stdout.strip()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,value):
 atomic_bytes(p,(json.dumps(value,indent=2)+'\n').encode(),0o600)
def require_ssd():
 if not SSD.is_mount()or SSD.stat().st_dev==ROOT.stat().st_dev:raise RuntimeError('Mounted external SSD is required; no eMMC backup fallback')
 if BACKUPS.is_symlink():raise RuntimeError('Backup root must not be a symlink')
 BACKUPS.mkdir(mode=0o700,exist_ok=True);BACKUPS.chmod(0o700)
def validate(candidate):
 candidate=validate_console(candidate)
 if json.loads((candidate/'status.json').read_text()).get('ptzComponents') is not True:raise RuntimeError('All PTZ components must be built')
 for folder,want in json.loads((candidate/'artifacts.json').read_text()).items():
  if files(candidate/folder)!=want:raise RuntimeError('Artifact changed: '+folder)
 for service in TARGETS:
  if TARGETS[service].is_symlink()or not TARGETS[service].is_file():raise RuntimeError('Expected installed regular binary: '+service)
 return candidate

def atomic_file(source,target):
 temp=target.with_name(target.name+'.ptz-'+uuid.uuid4().hex)
 shutil.copy2(source,temp);temp.chmod(source.stat().st_mode&0o777);os.replace(temp,target)
def swap_tree(source,target):
 # New code is staged on the system disk; the ONLY rollback copy is on SSD.
 # renameat2 exchanges existing directories atomically, without copying old
 # releases into an eMMC backup. The displaced directory is removed immediately.
 stage=target.with_name('.ptz-stage-'+uuid.uuid4().hex);shutil.copytree(source,stage)
 if not target.exists():os.replace(stage,target);return
 libc=ctypes.CDLL(None,use_errno=True)
 if not hasattr(libc,'renameat2'):shutil.rmtree(stage);raise RuntimeError('Atomic directory exchange is unavailable')
 result=libc.renameat2(-100,os.fsencode(stage),-100,os.fsencode(target),2)
 if result:err=ctypes.get_errno();shutil.rmtree(stage);raise OSError(err,os.strerror(err))
 assert stage.parent==target.parent and stage.name.startswith('.ptz-stage-')
 shutil.rmtree(stage)
def fingerprints():
 result=json.loads(run([NODE,ROOT/'deploy-package/ptz-production-state.mjs',ROOT]))
 result['private_files']={}
 for name in ['deploy/s100p/runtime/backend.env','deploy/s100p/runtime/ai-service.env','deploy/s100p/runtime/ai-service.json','data/ai/config_overlay.json','/etc/ainvr/onvif-bootstrap.json','/etc/ainvr/gb28181-bootstrap.json']:
  p=Path(name)if name.startswith('/')else ROOT/name
  if p.suffix=='.json':digest=hashlib.sha256(json.dumps(json.loads(p.read_text()),sort_keys=True,separators=(',',':')).encode()).hexdigest()
  else:digest=sha(p)
  result['private_files'][name]=digest
 return result

def identities():
 result={u:run(['systemctl','show',u,'--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic'])for u in WATCHED}
 result['srs']=run(['docker','inspect','--format','{{.State.Pid}} {{.State.StartedAt}}','ainvr-srs']);return result

def wait_ai(expected_sha):
 deadline=time.monotonic()+45
 while time.monotonic()<deadline:
  try:
   with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)as f:health=json.load(f)
   pid=run(['systemctl','show','ainvr-ai','--value','--property=MainPID'])
   if health.get('status')=='ok'and health.get('business',{}).get('ready') is True and health.get('media',{}).get('ffmpeg',{}).get('version')=='8.1.2'and health.get('capabilities',{}).get('model_providers')==['bpu']and sha(Path('/proc')/pid/'exe')==expected_sha:return
  except (OSError,ValueError,subprocess.CalledProcessError):pass
  time.sleep(.3)
 raise RuntimeError('AI runtime health/version verification failed')

def backup_time(path):
 # Older joint releases mislabeled local time with Z. Their nanosecond suffix
 # is an unambiguous Unix timestamp; do not sort these alongside UTC names.
 suffix=path.name.rsplit('-',1)[-1]
 if suffix.isdigit() and len(suffix)>=18:return int(suffix)/1e9
 marker=path/'backup.json'
 if marker.is_file():
  value=json.loads(marker.read_text()).get('createdAt')
  if isinstance(value,(int,float)) and value>0:return value
 from datetime import datetime,timezone
 if 'T' in path.name:return datetime.strptime(path.name.split('-')[0],'%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp()
 return datetime.strptime(path.name,'%Y%m%d-%H%M%S').timestamp()

def invalidate_transactions(component):
 bucket=BACKUPS/'backend'
 if not bucket.exists():return
 for record in bucket.glob('*/deployment.json'):
  if record.is_symlink() or record.parent.is_symlink():raise RuntimeError('Unsafe transaction record')
  state=json.loads(record.read_text())
  if str(component) in state.get('backups',{}).values():
   missing=state.setdefault('retentionRemoved',[])
   if str(component) not in missing:missing.append(str(component))
   save(record,state)

def prune(service):
 require_ssd();bucket=BACKUPS/service
 dirs=[p for p in bucket.iterdir()if p.is_dir()]
 if any(p.is_symlink()or not re.fullmatch(r'\d{8}(?:T\d{6}Z(?:-\d+)?|-\d{6})',p.name)for p in dirs):raise RuntimeError('Unknown backup directory; manual reconciliation required')
 ordered=sorted(dirs,key=lambda p:(backup_time(p),p.name),reverse=True)
 for old in ordered[3:]:
  marker=old/'backup.json'
  if marker.exists():
   status=json.loads(marker.read_text())
   if status.get('phase')not in ['applied','rolled_back']:raise RuntimeError('An unfinished backup prevents retention cleanup')
  elif not ((service=='gb28181' and (old/'etc').is_dir() and (old/'opt').is_dir() and (old/'repository').exists() and not (old/'repository').is_symlink())or(service=='ai-service' and (old/'ainvr_ai_service').is_file() and (old/'report.json').is_file())):
   raise RuntimeError('Unrecognized legacy backup; manual reconciliation required')
  if old.resolve().parent!=bucket.resolve():raise RuntimeError('Backup path changed')
  invalidate_transactions(old)
  shutil.rmtree(old)
 if len(list(bucket.iterdir()))>3:raise RuntimeError('Backup retention limit exceeded')

def backup_inventory(paths):
 return {service:files(p) for service,p in paths.items()}

def check_rollback(state,paths):
 if state.get('format')!='ainvr-ptz-v1' or set(paths)!=set(SERVICES) or state.get('phase')=='rolled_back':raise RuntimeError('Invalid rollback transaction')
 if state.get('retentionRemoved'):raise RuntimeError('Rollback transaction is incomplete after retention cleanup')
 for service,p in paths.items():
  if p.is_symlink() or p.resolve().parent!=(BACKUPS/service).resolve():raise RuntimeError('Invalid rollback component path')
  expected=state['integrity'][service]
  actual=files(p)
  for name,digest in expected.items():
   if actual.get(name)!=digest:raise RuntimeError('Rollback artifact changed: '+service+'/'+name)
 for service,target in TARGETS.items():
  if sha(target) not in state['allowedBinaries'][service]:raise RuntimeError('Concurrent binary deployment prevents rollback: '+service)
 for service,name in [('backend','backend'),('web','frontend')]:
  if files(ROOT/'srs-web-console'/name/'dist') not in state['allowedTrees'][service]:raise RuntimeError('Concurrent console deployment prevents rollback: '+service)
 if files(paths['alarm-service']/'src')!=state['integrity']['alarm-service-src']:raise RuntimeError('Alarm SSD source backup changed; rollback refused')

def prune_alarm_releases(current):
 parent=ROOT/'deploy/s100p/alarm-service'
 if parent.is_symlink():raise RuntimeError('Alarm runtime root must not be a symlink')
 current=current.resolve(strict=True)
 if current.parent!=parent.resolve():raise RuntimeError('Unexpected active alarm runtime')
 for old in parent.glob('release-ptz-*'):
  if old.is_symlink() or old.resolve()==current:continue
  # Only releases created by this publisher. Unmarked legacy releases require
  # one-time inventory review; never delete arbitrary application directories.
  marker=old/'.ainvr-ptz-runtime.json'
  if marker.is_file() and json.loads(marker.read_text()).get('managedBy')=='deploy_ptz_release':
   if old.resolve().parent!=parent.resolve():raise RuntimeError('Unsafe alarm cleanup path')
   shutil.rmtree(old)

def restore_alarm_runtime(state,backup):
 # Materialize from verified SSD evidence, never depend on old eMMC copies.
 parent=ROOT/'deploy/s100p/alarm-service'
 release=parent/('release-ptz-restore-'+uuid.uuid4().hex)
 release.mkdir()
 save(release/'.ainvr-ptz-runtime.json',{'managedBy':'deploy_ptz_release'})
 try:
  shutil.copytree(backup/'src',release/'src')
  if files(release/'src')!=state['integrity']['alarm-service-src']:raise RuntimeError('Restored alarm source mismatch')
  (release/'node_modules').symlink_to(ROOT/'alarm-service/node_modules',target_is_directory=True)
  if state['dropinExisted']:
   original=(backup/'dropin.conf').read_text()
   old=str(Path(state['oldAlarmSource']).parent)
   if old not in original:raise RuntimeError('Alarm drop-in does not reference the recorded source')
   text=original.replace(old,str(release))
  else:
   text='[Service]\nWorkingDirectory='+str(release)+'\nExecStart=\nExecStart='+NODE+' '+str(release/'src/main.mjs')+' --config-center '+str(ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json')+'\n'
  config=release/'runtime.conf';config.write_text(text);config.chmod(0o644)
  return release,config
 except BaseException:
  shutil.rmtree(release);raise

def rollback(backup):
 require_ssd();backup=backup.resolve(strict=True)
 if backup.parent!=BACKUPS/'backend':raise RuntimeError('Expected backend SSD rollback transaction')
 state=json.loads((backup/'deployment.json').read_text());paths={k:Path(v)for k,v in state['backups'].items()}
 check_rollback(state,paths)
 ptz_preflight(ROOT,paths['backend']/'dist')
 restored,alarm_config=restore_alarm_runtime(state,paths['alarm-service'])
 run(['systemctl','stop','ainvr-backend'])
 try:
  check_rollback(state,paths)
  ptz_preflight(ROOT,paths['backend']/'dist')
 except BaseException:run(['systemctl','start','ainvr-backend']);raise
 for service in ['alarm-service','ai-service','onvif','gb28181']:run(['systemctl','stop',UNITS[service]])
 for service,target in TARGETS.items():atomic_file(paths[service]/'binary',target)
 atomic_file(alarm_config,DROPIN)
 for service in ['backend','web']:swap_tree(paths[service]/'dist',ROOT/'srs-web-console'/('frontend'if service=='web'else'backend')/'dist')
 run(['systemctl','daemon-reload'])
 for unit in ['ainvr-onvif','ainvr-gb28181','ainvr-ai','ainvr-alarm','ainvr-backend']:run(['systemctl','start',unit])
 backend_ready();wait_ai(sha(paths['ai-service']/'binary'))
 state['phase']='rolled_back';save(backup/'deployment.json',state)
 for service,p in paths.items():save(p/'backup.json',{'service':service,'phase':'rolled_back','at':time.time()})
 prune_alarm_releases(restored)
 return {'rolledBack':True,'configurationRestored':False,'schemaRetained':True}

def apply(candidate):
 candidate=validate(candidate);require_ssd();backend_ready()
 if shutil.disk_usage(ROOT).free<1<<30:raise RuntimeError('Keep at least 1GiB free on system disk')
 if shutil.disk_usage(SSD).free<256<<20:raise RuntimeError('Insufficient SSD rollback space')
 for service in SERVICES:
  bucket=BACKUPS/service
  if bucket.exists():
   if bucket.is_symlink():raise RuntimeError('Service backup root is a symlink')
   prune(service)
 before=fingerprints();watched=identities();stamp=time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())+'-'+str(time.time_ns());paths={}
 release=None
 try:
  for service in SERVICES:
   bucket=BACKUPS/service;bucket.mkdir(mode=0o700,exist_ok=True)
   if bucket.is_symlink():raise RuntimeError('Service backup root is a symlink')
   p=bucket/stamp;p.mkdir(mode=0o700);paths[service]=p;save(p/'backup.json',{'service':service,'phase':'preparing','at':time.time()})
  state={'format':'ainvr-ptz-v1','phase':'preparing','candidate':str(candidate),'backups':{k:str(v)for k,v in paths.items()},'configuration':before,'watched':watched,'dropinExisted':DROPIN.exists()};record=paths['backend']/'deployment.json';save(record,state)
  for service,target in TARGETS.items():shutil.copy2(target,paths[service]/'binary');assert sha(target)==sha(paths[service]/'binary')
  for service,name in [('backend','backend'),('web','frontend')]:
   source=ROOT/'srs-web-console'/name/'dist';shutil.copytree(source,paths[service]/'dist');assert files(source)==files(paths[service]/'dist')
  if DROPIN.exists():shutil.copy2(DROPIN,paths['alarm-service']/'dropin.conf')
  # Capture the old immutable alarm executable source, not its historical data.
  alarm_cmd=run(['systemctl','show','ainvr-alarm','--value','--property=ExecStart'])
  match=re.search(r'(/home/sunrise/ainvr/[^ ;]+/src/main\.mjs)',alarm_cmd)
  if not match:raise RuntimeError('Cannot identify original alarm executable')
  old_alarm=Path(match.group(1)).parent;shutil.copytree(old_alarm,paths['alarm-service']/'src');state['oldAlarmSource']=str(old_alarm);save(record,state)
  release=ROOT/'deploy/s100p/alarm-service'/('release-ptz-'+stamp);shutil.copytree(candidate/'ptz-alarm',release);(release/'node_modules').symlink_to(ROOT/'alarm-service/node_modules',target_is_directory=True)
  save(release/'.ainvr-ptz-runtime.json',{'managedBy':'deploy_ptz_release'})
  # Compare-and-swap guards protect later rollback from overwriting another deployment.
  state['integrity']=backup_inventory(paths)
  # deployment.json changes phase later, so it is not an immutable backup artifact.
  state['integrity']['backend'].pop('deployment.json',None)
  for expected in state['integrity'].values():expected.pop('backup.json',None)
  state['integrity']['alarm-service-src']=files(old_alarm)
  state['allowedBinaries']={service:[sha(target)] for service,target in TARGETS.items()}
  for service,folder,file in [('onvif','onvif','ainvr_onvif'),('gb28181','ptz-gb28181','gateway'),('ai-service','ptz-ai','ainvr_s100p_control_service')]:state['allowedBinaries'][service].append(sha(candidate/folder/file))
  state['allowedTrees']={service:[files(paths[service]/'dist'),files(candidate/name)] for service,name in [('backend','backend'),('web','frontend')]}
  state['phase']='prepared';save(record,state);changed=False
 except BaseException:
  for service,p in paths.items():
   if p.parent!=BACKUPS/service or p.is_symlink():raise RuntimeError('Unsafe incomplete backup path')
   shutil.rmtree(p)
  if release is not None and release.is_dir():
   if release.parent!=ROOT/'deploy/s100p/alarm-service' or not release.name.startswith('release-ptz-'):raise RuntimeError('Unsafe staging path')
   shutil.rmtree(release)
  raise
 try:
  run(['systemctl','stop','ainvr-backend']);changed=True
  for service,folder,file in [('onvif','onvif','ainvr_onvif'),('gb28181','ptz-gb28181','gateway'),('ai-service','ptz-ai','ainvr_s100p_control_service')]:
   run(['systemctl','stop',UNITS[service]]);atomic_file(candidate/folder/file,TARGETS[service]);run(['systemctl','start',UNITS[service]])
  wait_ai(sha(candidate/'ptz-ai/ainvr_s100p_control_service'))
  DROPIN.parent.mkdir(exist_ok=True);new=paths['alarm-service']/'new-dropin.conf';new.write_text('[Service]\nWorkingDirectory='+str(release)+'\nExecStart=\nExecStart='+NODE+' '+str(release/'src/main.mjs')+' --config-center '+str(ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json')+'\n');new.chmod(0o644)
  atomic_file(new,DROPIN);run(['systemctl','daemon-reload']);run(['systemctl','restart','ainvr-alarm'])
  for service,name in [('backend','backend'),('web','frontend')]:swap_tree(candidate/name,ROOT/'srs-web-console'/name/'dist')
  run(['systemctl','start','ainvr-backend']);backend_ready()
  for unit in UNITS.values():
   if run(['systemctl','is-active',unit])!='active':raise RuntimeError('Service not active: '+unit)
  if identities()!=watched:raise RuntimeError('An unrelated media service changed during deployment')
  if fingerprints()!=before:raise RuntimeError('Customer configuration changed during deployment; inspect preserved parameters')
  state['phase']='applied';state['at']=time.time();save(record,state)
  for service,p in paths.items():save(p/'backup.json',{'service':service,'phase':'applied','at':time.time()})
 except BaseException:
  if changed:
   state['phase']='failed';save(record,state)
   rollback(paths['backend'])
  raise
 for service in SERVICES:prune(service)
 prune_alarm_releases(release)
 return {'applied':True,'rollback':str(paths['backend']),'backups':'SSD only, at most 3 per service','configurationPreserved':True,'mediaServicesUnchanged':True}

def main():
 p=argparse.ArgumentParser(description=__doc__);mode=p.add_mutually_exclusive_group(required=True);mode.add_argument('--check',type=Path);mode.add_argument('--apply',type=Path);mode.add_argument('--rollback',type=Path);p.add_argument('--profile',choices=['ptz','search'],default='ptz');a=p.parse_args()
 # One publisher/lock and SSD transaction mechanism. The default profile and
 # existing ainvr-ptz-v1 records retain their original CLI and wire format.
 from search_release_profile import plan as search_plan,apply as search_apply,rollback as search_rollback,FORMAT as SEARCH_FORMAT
 search=a.profile=='search'
 if a.rollback:
  recorded=json.loads((a.rollback/'deployment.json').read_text()).get('format')
  if recorded==SEARCH_FORMAT:search=True
  elif search:raise RuntimeError('Rollback profile does not match transaction')
 publisher=sys.modules[__name__]
 if a.check:
  print(json.dumps(search_plan(publisher,a.check)if search else {'verified':True,'candidate':str(validate(a.check)),'productionChanged':False}));return
 if os.geteuid()!=0:raise RuntimeError('Board administrator required')
 with Path('/run/lock/ainvr-ptz-deploy.lock').open('w')as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  result=(search_apply(publisher,a.apply)if a.apply else search_rollback(publisher,a.rollback))if search else(apply(a.apply)if a.apply else rollback(a.rollback))
  print(json.dumps(result))
if __name__=='__main__':main()
