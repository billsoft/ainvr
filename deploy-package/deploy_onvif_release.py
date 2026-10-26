#!/usr/bin/env python3
"""Apply/roll back a checksummed local ONVIF candidate; never restart SRS/AI/recorder.

Schema migration is additive and is deliberately retained on rollback.
Requires explicit --apply or --rollback; builds alone do not publish anything.
"""
import argparse, hashlib, json, os, shutil, subprocess, tarfile, time
from pathlib import Path
ROOT=Path(os.environ.get('AINVR_INSTALL_ROOT',str(Path(__file__).resolve().parents[1]))).resolve()
NODE=os.environ.get('AINVR_NODE','/usr/local/bin/node')
DROPIN=Path('/etc/systemd/system/ainvr-ingest.service.d/70-onvif.conf')

def run(args,**kw):return subprocess.run(args,check=True,timeout=90,**kw)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def validate(candidate):
 candidate=candidate.resolve()
 if not candidate.is_relative_to(ROOT/'out') or candidate.is_symlink():raise ValueError('Candidate must be under repository out/')
 manifest=json.loads((candidate/'artifacts.json').read_text())
 if not {'backend','frontend','ingest-service','shared','onvif','media-bridge','deploy-package','helper'}.issubset(manifest):raise ValueError('Incomplete candidate; rebuild with the coordinated ONVIF release builder')
 if json.loads((candidate/'status.json').read_text())['phase']!='built':raise ValueError('Candidate is not built')
 for folder,files in manifest.items():
  for name,want in files.items():
   p=candidate/folder/name
   if not p.resolve().is_relative_to(candidate) or p.is_symlink() or not p.is_file() or digest(p)!=want:raise ValueError('Artifact checksum mismatch: '+folder+'/'+name)
 return candidate

def atomic_text(path,text,mode=0o644):
 path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_name(path.name+'.onvif-new')
 with temp.open('x') as f:f.write(text)
 temp.chmod(mode);os.replace(temp,path)

def restore(backup):
 backup=backup.resolve()
 if not backup.is_relative_to(ROOT/'.Codex-trash') or not (backup/'deployment.json').is_file():raise ValueError('Not an ONVIF deployment backup')
 if (backup/'rolled-back.json').exists():raise ValueError('This rollback was already applied; current services were not changed')
 state=json.loads((backup/'deployment.json').read_text())
 run(['systemctl','stop','ainvr-ingest','ainvr-backend'])
 if not state['onvifPreviouslyActive']:run(['systemctl','disable','--now','ainvr-onvif'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for name in ['backend','frontend']:
  saved=backup/(name+'-dist');target=ROOT/'srs-web-console'/name/'dist'
  if saved.exists():
   if target.exists():os.replace(target,backup/(name+'-rejected-'+str(time.time_ns())))
   os.replace(saved,target)
 for name in ['ingest-dropin','onvif-unit']:
  target=DROPIN if name=='ingest-dropin' else Path('/etc/systemd/system/ainvr-onvif.service')
  old=backup/name
  if old.exists():shutil.copy2(old,target)
  elif target.exists():os.replace(target,backup/(name+'-rejected-'+str(time.time_ns())))
 # The pre-ONVIF service may have been running old code in memory while source
 # was being edited. Its captured immutable baseline is the rollback executable.
 if not (backup/'ingest-dropin').exists() and state.get('baselineIngest'):
  atomic_text(DROPIN,'[Service]\nExecStart=\nExecStart='+str(ROOT/'.venv/bin/python')+' '+state['baselineIngest']+'\n')
 if (backup/'media-bridge-runtime').exists():
  target=Path('/opt/ainvr/media-bridge')
  if target.exists():os.replace(target,backup/('media-bridge-rejected-'+str(time.time_ns())))
  os.replace(backup/'media-bridge-runtime',target)
 if (backup/'onvif-bootstrap').exists():
  target=Path('/etc/ainvr/onvif-bootstrap.json');shutil.copy2(backup/'onvif-bootstrap',target)
  attrs=state['bootstrapAttributes'];os.chown(target,attrs['uid'],attrs['gid']);target.chmod(attrs['mode'])
 if (backup/'helper-observability.py').exists():
  shutil.copy2(backup/'helper-observability.py',ROOT/'shared/host-restart-helper/observability.py')
  run(['systemctl','restart','ainvr-restart-helper'])
 if (backup/'onvif-runtime').exists():
  binary=Path('/opt/ainvr/onvif/ainvr_onvif');shutil.copy2(backup/'onvif-runtime',binary.with_suffix('.rollback'));os.replace(binary.with_suffix('.rollback'),binary)
 run(['systemctl','daemon-reload'])
 if state.get('onvifPreviouslyEnabled',state['onvifPreviouslyActive']) and (backup/'onvif-unit').exists():run(['systemctl','enable','ainvr-onvif'],stdout=subprocess.DEVNULL)
 elif (backup/'onvif-unit').exists():run(['systemctl','disable','ainvr-onvif'],stdout=subprocess.DEVNULL)
 run(['systemctl','start','ainvr-backend','ainvr-ingest'])
 if state['onvifPreviouslyActive']:run(['systemctl','restart','ainvr-onvif'])
 (backup/'rolled-back.json').write_text(json.dumps({'at':time.time(),'schemaRetained':True})+'\n')
 print('Rolled back executable code; ONVIF additive schema and historical data retained.')

def apply(candidate,baseline,baseline_sha,check_source):
 candidate=validate(candidate)
 # Candidate must still correspond to reviewed source. Build script records this.
 if check_source:
  for name,want in json.loads((candidate/'source-manifest.json').read_text()).items():
   if digest(ROOT/name)!=want:raise ValueError('Source changed since build: '+name)
 required=sum(p.stat().st_size for p in candidate.rglob('*') if p.is_file())*2+(100<<20)
 if shutil.disk_usage(ROOT).free<max(required,1<<30):raise RuntimeError('Insufficient system-disk space for rollback')
 stamp=time.strftime('%Y%m%dT%H%M%S');backup=ROOT/'.Codex-trash'/('onvif-deploy-'+stamp);backup.mkdir(parents=True,mode=0o700)
 prior=subprocess.run(['systemctl','is-active','--quiet','ainvr-onvif']).returncode==0
 enabled=subprocess.run(['systemctl','is-enabled','--quiet','ainvr-onvif'],stderr=subprocess.DEVNULL).returncode==0
 (backup/'deployment.json').write_text(json.dumps({'candidate':str(candidate),'onvifPreviouslyActive':prior,'onvifPreviouslyEnabled':enabled,'at':time.time()})+'\n')
 for target,name in [(DROPIN,'ingest-dropin'),(Path('/etc/systemd/system/ainvr-onvif.service'),'onvif-unit'),(Path('/opt/ainvr/onvif/ainvr_onvif'),'onvif-runtime')]:
  if target.exists():shutil.copy2(target,backup/name)
 helper=ROOT/'shared/host-restart-helper/observability.py'
 if not helper.is_file():raise ValueError('Existing AINVR restart helper is required')
 shutil.copy2(helper,backup/'helper-observability.py')
 bootstrap=Path('/etc/ainvr/onvif-bootstrap.json')
 if bootstrap.exists():
  shutil.copy2(bootstrap,backup/'onvif-bootstrap');attrs=bootstrap.stat()
  state=json.loads((backup/'deployment.json').read_text());state['bootstrapAttributes']={'uid':attrs.st_uid,'gid':attrs.st_gid,'mode':attrs.st_mode&0o777};(backup/'deployment.json').write_text(json.dumps(state)+'\n')
 # First migration captures the operator-specified pre-change ingest source.
 if not DROPIN.exists():
  if not baseline:raise ValueError('First deployment requires --baseline-ingest (pre-change tar)')
  with tarfile.open(baseline) as archive:
   member=archive.getmember('ingest-service/main.py')
   if not member.isfile() or member.size>1<<20:raise ValueError('Invalid baseline main file')
   data=archive.extractfile(member).read()
  if not baseline_sha or hashlib.sha256(data).hexdigest()!=baseline_sha:raise ValueError('Initial ingest baseline does not match the explicitly recorded SHA-256')
  baselineRoot=Path('/opt/ainvr/ingest/releases')/('baseline-'+stamp)
  old=baselineRoot/'ingest-service';old.mkdir(parents=True);(old/'main.py').write_bytes(data)
  shutil.copytree(ROOT/'shared/python',baselineRoot/'shared/python',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
  state=json.loads((backup/'deployment.json').read_text());state['baselineIngest']=str(old/'main.py');(backup/'deployment.json').write_text(json.dumps(state)+'\n')
 # Install immutable Python code on the system disk, outside build output.
 ingestRelease=Path('/opt/ainvr/ingest/releases')/('onvif-'+stamp)
 ingestRelease.parent.mkdir(parents=True,exist_ok=True)
 shutil.copytree(candidate/'ingest-service',ingestRelease/'ingest-service')
 shutil.copytree(candidate/'shared',ingestRelease/'shared')
 for p in ingestRelease.rglob('*'):
  if p.is_symlink():raise ValueError('Unexpected code symlink')
  p.chmod(0o755 if p.is_dir() else 0o644)
 ingestRelease.chmod(0o755)
 # Include current shared runtime in the immutable ingest release (system disk).
 shared=candidate/'shared/python'
 if not shared.is_dir():raise ValueError('Immutable shared Python runtime missing')
 for name in ['backend','frontend']:
  target=ROOT/'srs-web-console'/name/'dist';stage=target.with_name('dist-onvif-'+stamp)
  shutil.copytree(candidate/name,stage)
  if name=='frontend' and (target/'assets').is_dir():
   assets=target/'assets'
   # Keep recent chunks for already-open pages across several quick updates.
   # Original mtimes are preserved; a hard budget prevents unbounded cache growth.
   old=[p.name for p in assets.iterdir() if p.is_file() and p.stat().st_mtime>=time.time()-86400]
   own=[p.name for p in (stage/'assets').iterdir() if p.is_file()]
   if sum((assets/n).stat().st_size for n in old if Path(n).name==n and (assets/n).is_file())>64<<20:raise RuntimeError('Previous asset retention exceeds budget')
   for n in old:
    if Path(n).name!=n:raise ValueError('Invalid old asset name')
    if (assets/n).is_file() and not (stage/'assets'/n).exists():shutil.copy2(assets/n,stage/'assets'/n)
   (stage/'.ainvr-own-assets.json').write_text(json.dumps(own))
 run(['systemctl','stop','ainvr-ingest','ainvr-backend'])
 try:
  for name in ['backend','frontend']:
   target=ROOT/'srs-web-console'/name/'dist'
   if target.exists():os.replace(target,backup/(name+'-dist'))
   os.replace(target.with_name('dist-onvif-'+stamp),target)
  # Additive migration and encrypted service credential. No enabled setting change.
  run([NODE,str(candidate/'deploy-package/provision-onvif.mjs')],env={**os.environ,'AINVR_INSTALL_ROOT':str(ROOT)},stdout=subprocess.DEVNULL)
  if subprocess.run(['id','ainvr-onvif'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
   run(['useradd','--system','--no-create-home','--shell','/usr/sbin/nologin','ainvr-onvif'])
  runtime=Path('/opt/ainvr/onvif');runtime.mkdir(parents=True,exist_ok=True)
  shutil.copy2(candidate/'onvif/ainvr_onvif',runtime/'ainvr_onvif.new');os.replace(runtime/'ainvr_onvif.new',runtime/'ainvr_onvif')
  run(['chown','ainvr-onvif:ainvr-onvif','/etc/ainvr/onvif-bootstrap.json'])
  shutil.copy2(candidate/'deploy-package/ainvr-onvif.service','/etc/systemd/system/ainvr-onvif.service')
  media=Path('/opt/ainvr/media-bridge');media.parent.mkdir(parents=True,exist_ok=True)
  stage=media.with_name('media-bridge-new-'+stamp);shutil.copytree(candidate/'media-bridge',stage)
  if media.exists():os.replace(media,backup/'media-bridge-runtime')
  os.replace(stage,media)
  atomic_text(DROPIN,'[Service]\nExecStart=\nExecStart='+str(ROOT/'.venv/bin/python')+' '+str(ingestRelease/'ingest-service/main.py')+'\nEnvironment=INGEST_FFMPEG=/opt/ainvr/media-bridge/bin/ffmpeg\nEnvironment=INGEST_FFPROBE=/opt/ainvr/media-bridge/bin/ffprobe\n')
  shutil.copy2(candidate/'helper/observability.py',ROOT/'shared/host-restart-helper/observability.py')
  run(['systemctl','restart','ainvr-restart-helper'])
  run(['systemctl','daemon-reload']);run(['systemctl','enable','ainvr-onvif']);run(['systemctl','restart','ainvr-onvif']);run(['systemctl','start','ainvr-backend','ainvr-ingest'])
  for _ in range(30):
   states=[subprocess.run(['systemctl','is-active','--quiet',n]).returncode==0 for n in ['ainvr-backend','ainvr-ingest','ainvr-onvif']]
   if all(states):
    import urllib.request
    try:
     with urllib.request.urlopen('http://127.0.0.1:3001/api/health',timeout=2) as response:assert response.status==200
     break
    except Exception:pass
   time.sleep(1)
  else:raise RuntimeError('Service startup failed')
  (backup/'applied.json').write_text(json.dumps({'at':time.time(),'featureEnablementChanged':False})+'\n')
  print('Applied candidate; feature enablement unchanged. Rollback: '+str(backup))
 except BaseException:
  restore(backup);raise

def main():
 p=argparse.ArgumentParser(description=__doc__);g=p.add_mutually_exclusive_group(required=True)
 g.add_argument('--apply',type=Path);g.add_argument('--rollback',type=Path)
 p.add_argument('--check-source',action='store_true',help='Developer checkout only: require the current source to match the candidate')
 p.add_argument('--baseline-ingest',type=Path)
 p.add_argument('--baseline-ingest-sha256',help='SHA-256 of ingest-service/main.py captured before source replacement')
 a=p.parse_args()
 if os.geteuid()!=0:raise RuntimeError('Root required for service installation')
 if a.rollback:restore(a.rollback)
 else:apply(a.apply,a.baseline_ingest,a.baseline_ingest_sha256,a.check_source)
if __name__=='__main__':main()
