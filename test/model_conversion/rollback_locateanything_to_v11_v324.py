"""One-click rollback from the v323 GPTQ INT8 install to the previous v11 (vision O2) runtime.

Default:read-only admission (no service change). --execute:stop AI + LocateAnything backend, atomically
restore the saved prior drop-in and the prior sidecar link from the v323 release, daemon-reload, start,
then wait for fresh native results and real SEI and verify the backend health reports the v11 contract.
User configuration, recorder, ingest and SRS are never touched.
"""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,time,traceback,urllib.request,urllib.error
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';UNIT='ainvr-locateanything-official-bpu'
SIDECAR=ROOT/'ai-service/models/derived/s100p/locateanything-3b.hbm.ainvr.json';DROP=Path('/etc/systemd/system')/(UNIT+'.service.d')/'60-ainvr-runtime-reused-io.conf'
INSTALL=ROOT/'test/results/locateanything-text-gptq8-runtime-upgrade-v323.json';REPORT=ROOT/'test/results/locateanything-rollback-to-v11-v324.json'
V11_SHA='d471046ae84930c385db34841154583e2476a1d0fe210f5985debee31a29fbf2';V11_BACKEND='locateanything_bpu_vision_o2_executor_v11.py'
HEALTH=CODE/'read_locateanything_prefill_three_groups_health_v216.py'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def run(a,t=100):return subprocess.check_output(a,text=True,timeout=t)
def atomic(p,data,suffix):
 t=p.with_name('.'+p.name+suffix);assert not t.exists();t.write_bytes(data);os.chmod(t,0o644);t.replace(p)
def admit():
 inst=read(INSTALL);assert inst['status']=='installed_text_gptq8_trial_and_current_native_results_real_SEI_verified'
 release=Path(inst['release']);prior_drop=(release/'prior-dropin.conf').read_bytes();prior_side=read(release/'prior-sidecar.json')
 assert sha(release/'prior-dropin.conf')==inst['admission']['prior_dropin_sha256'] and V11_SHA.encode() in prior_drop and V11_BACKEND.encode() in prior_drop
 cur=DROP.read_bytes();assert sha(DROP)==inst['dropin_sha256'],'current drop-in is not the v323 install'
 target=Path(inst['admission']['prior_sidecar']);assert target.is_file() and sha(target)==inst['admission']['prior_sidecar_sha256'] and read(target)==prior_side and prior_side['generation']['contract_sha256']==V11_SHA
 assert SIDECAR.is_symlink() and str(SIDECAR.resolve())==inst['sidecar_target']
 return inst,prior_drop,target
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--execute',action='store_true');a=ap.parse_args()
 inst,prior_drop,target=admit()
 if not a.execute:print(json.dumps(dict(status='rollback_admission_passed_no_service_change',restore_contract=V11_SHA,restore_sidecar=str(target))));return
 assert os.getuid()==0 and not REPORT.exists()
 key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key']
 def get(url,auth=False):
  with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {}),timeout=5) as f:return json.load(f)
 def state():return get('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097',True)
 r=dict(status='rolling_back',started=time.time(),source_sha256=sha(__file__),from_contract=inst['admission']['contract_sha256'],to_contract=V11_SHA)
 def save():REPORT.write_text(json.dumps(r,indent=2)+'\n')
 save();cfg=sha(ROOT/'data/ai/config_overlay.json');before=state()
 try:
  run(['systemctl','stop','ainvr-ai']);run(['systemctl','stop',UNIT])
  atomic(DROP,prior_drop,'.rollback-v324-incoming')
  link=SIDECAR.with_name('.'+SIDECAR.name+'.rollback-v324-link');assert not link.exists();link.symlink_to(target);link.replace(SIDECAR)
  run(['systemctl','daemon-reload']);run(['systemctl','start',UNIT]);run(['systemctl','start','ainvr-ai'])
  deadline=time.monotonic()+240
  while True:
   try:
    s=state();pub=s['stats'].get('publish',{})
    if s['state']=='running' and s['stats']['consecutive_errors']==0 and s['stats']['inference_count']>=4 and pub.get('sei_injected',0)>=4:break
   except (urllib.error.URLError,KeyError):pass
   assert time.monotonic()<deadline,'v11 results/SEI did not recover';time.sleep(.5)
  h=json.loads(run(['runuser','-u','sunrise','--','python3',str(HEALTH),'--contract-sha',V11_SHA],30))
  assert h['persistent_worker']['cached_models']==46 and sha(ROOT/'data/ai/config_overlay.json')==cfg and s['config']==before['config']
  r.update(status='rolled_back_to_v11_and_current_native_results_real_SEI_verified',after=s,health=h,user_configuration_unchanged=True)
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:r['finished']=time.time();save()
 print(json.dumps({k:r.get(k) for k in ['status','error']}))
if __name__=='__main__':main()
