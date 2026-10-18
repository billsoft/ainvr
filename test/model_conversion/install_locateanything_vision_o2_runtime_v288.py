"""Qualified same-output MoonViT27 O2 trial upgrade with rollback of owned files only.

Requires completed full160 and controlled image A/B reports, pinned by caller.
Never changes user configuration, ingress, recorder or SRS channel definitions.
Native AI restart is needed because its client retains the contract identity.
"""
from pathlib import Path
import argparse,ast,copy,fcntl,hashlib,json,os,re,signal,subprocess,sys,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
OLD=RUNTIME/'locateanything_bpu_prefill_all_executor_v10.py';NEW=RUNTIME/'locateanything_bpu_vision_o2_executor_v11.py';PYTHON=RUNTIME/'.venv-locateanything/bin/python';UNIT='ainvr-locateanything-official-bpu'
SIDECAR=ROOT/'ai-service/models/derived/s100p/locateanything-3b.hbm.ainvr.json';DROP=Path('/etc/systemd/system')/(UNIT+'.service.d')/'60-ainvr-runtime-reused-io.conf';UNITFILE=Path('/etc/systemd/system')/(UNIT+'.service')
CONTRACT=BASE/'official-full-family-w8a16-vision-o2-v284.json';CONTRACT_SHA=None;OLD_SHA=None;REPORT=ROOT/'test/results/locateanything-vision-o2-runtime-upgrade-v288.json'
Q=ROOT/'test/results/locateanything-vision-o2-full160-guard-v286.json';S=ROOT/'test/results/locateanything-vision-o2-full-image-A-B-v287-guard.json';HEALTH=CODE/'read_locateanything_prefill_three_groups_health_v216.py'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def encoded(v):return (json.dumps(v,indent=2,allow_nan=False)+'\n').encode()
def atomic(p,data):
 t=p.with_name('.'+p.name+'.vision-v288-incoming');assert not t.exists();t.write_bytes(data);os.chmod(t,0o644);t.replace(p)
def save(r):atomic(REPORT,encoded(r))
def run(a,timeout=30):return subprocess.check_output(a,text=True,timeout=timeout)
def pid(n):return int(run(['systemctl','show',n,'--property=MainPID','--value']).strip())
def ticks(p):return Path(f'/proc/{p}/stat').read_text().rsplit(')',1)[1].split()[19]
def health(new):
 p=HEALTH
 return json.loads(run(['runuser','-u','sunrise','--','python3',str(p),'--contract-sha',CONTRACT_SHA if new else OLD_SHA],10))
def qualify(qpin,spin):
 assert all(re.fullmatch('[0-9a-f]{64}',x) for x in [qpin,spin]) and sha(Q)==qpin and sha(S)==spin
 q=read(Q);s=read(S);assert q['status']=='completed_all160_runtime_equivalence_not_installed' and q['finished'] and q['runtime_equivalence_passed'] and q['original_backend_user_config_and_sei_output_restored'] and not q['restore_errors'] and not any(q['owned_ion_after_exit'].values())
 raw=BASE/'vision-o2-frozen160-v285/status.json';assert sha(raw)==q['raw_sha256'];a=read(raw)
 assert a['status']=='completed_all160_runtime_regression' and a['all160_operations_executed'] and a['runtime_equivalence_passed'] and not a['mismatch_indices'] and a['retained_failed_indices']==[117] and len(a['cases'])==160 and a['summary_exactly_equal_baseline'] and a['neural_calls']==25794
 assert q['conservative_backend_memory_bytes_maximum']<8_000_000_000 and a['summary']==q['summary']
 assert s['status']=='completed_full_image_AB_and_original_production_restored' and s['finished'] and s['original_current_configuration_and_real_SEI_restored'] and not s['restore_errors'] and not any(s['owned_ion_after_exit'].values())
 speedpath=BASE/'full-image-vision-o2-A-B-v287/status.json';assert sha(speedpath)==s['raw_sha256'];v=read(speedpath)
 assert v==s['proof'] and v['status']=='completed_controlled_full_image_prefill_A_B' and v['full_image_speed_screen_passed'] and v['same_generated_tokens_all_runs'] and v['all_models_released'] and len(v['cases'])==22 and len(v['pairs'])==10 and v['median_absolute_saved_ms']>=50
 assert sha(CODE/'compare_locateanything_vision_o2_full_image_v287.py')=='3345ea0017a9e194d30e9aab63a6ad4750b6b51aab31eb33109e03e3cf934046'
 sys.path.insert(0,str(CODE));import compare_locateanything_vision_o2_full_image_v287 as qualified
 qualified.CANDIDATE_SHA=CONTRACT_SHA;qualified.REGRESSION_SHA=q['raw_sha256'];qualified.GUARD_SHA=qpin;qualified.BASELINE_SHA=q['baseline_raw_sha256'];qualified.BASE_CONTRACT_SHA=OLD_SHA
 qualified.admit() # Rechecks all160 per-token semantics and component proof before services.
 assert v['source_sha256']=='3345ea0017a9e194d30e9aab63a6ad4750b6b51aab31eb33109e03e3cf934046'
 assert s['source_sha256']==v['source_sha256'] and s['candidate_contract_sha256']==CONTRACT_SHA
 assert s['full160_guard_sha256']==qpin and s['full160_raw_sha256']==q['raw_sha256']
 assert sha(CODE/'read_locateanything_prefill_runtime_health_v138.py')=='b3a9a198f4fde4a22d753c904dd021ed9eaabb8fbc41b77490c67296df108938'
 assert sha(HEALTH)=='708d24e4676509ed500d1f243c65a76b222fa9fb38981f750e222283496328dd'
 assert s['conservative_worker_memory_maximum']<8_000_000_000 and s['memory_samples']>0
 assert sha(OLD)=='78eed225bcde6ab9b04a2c81a2c6503ba656cd27f5d5bfd3358595aea211a11b' and sha(NEW)=='d4efa1bd5cca6bbc4b923fa7a467001b84ead18b1a87ebaf3f69f3246cdb1bcf' and sha(CONTRACT)==CONTRACT_SHA
 tree=ast.parse(NEW.read_text());extra=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SOURCE_PINS' for t in n.targets))
 for name,pin in extra.items():assert sha(ROOT/name)==pin,name
 assert sha(ROOT/'deploy/s100p/bin/ainvr_ai_service')=='d87c78d1a3f57f760baeda1a35a4d6f68bbc369fce34c4f0e816ea564fe9e7be'
 accept=ROOT/'test/results/locateanything-w8-trial-human-acceptance-v1.json';assert sha(accept)=='8fbb0e7c141a4d254231d03addbafbd9a6302a024252bd8ca208bf483c344622' and read(accept)['accepted_failed_indices']==[117]
 side=read(SIDECAR);assert SIDECAR.is_symlink() and SIDECAR.resolve().is_relative_to(BASE/'runtime-trial-releases') and side['generation']['contract_sha256']==OLD_SHA and side['validation']['original_frozen_quality']==a['summary'] and side['quality_override_accepted'] and side['evaluation_only'] and not side['release_approved'] and not side['production_approved'] and side['media_retention']['delay_seconds']==95
 drop=DROP.read_bytes();assert str(OLD).encode() in drop and OLD_SHA.encode() in drop and str(NEW).encode() not in drop
 assert sha(CODE/'locateanything_process_memory_v4.py')=='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
 sys.path.insert(0,str(CODE));sys.path.insert(0,str(RUNTIME));from locateanything_official_vision_o2_v284 import load_official_generator
 gen,_=load_official_generator(CONTRACT,CONTRACT_SHA);assert len(gen.specs)==76 and len({str(x.path.resolve()) for x in gen.specs})==46
 return dict(quality_report_sha256=qpin,quality_raw_sha256=q['raw_sha256'],controlled_speed_report_sha256=spin,controlled_speed_raw_sha256=s['raw_sha256'],contract_sha256=CONTRACT_SHA,backend_sha256=sha(NEW),dependency_pins=extra,prior_sidecar=str(SIDECAR.resolve()),prior_sidecar_sha256=sha(SIDECAR),prior_dropin_sha256=sha(DROP),base_unit_sha256=sha(UNITFILE),health_helper_sha256=sha(HEALTH),original_quality_unchanged=True,accepted_failed_indices=[117],median_saved_ms=v['median_absolute_saved_ms'],speed_scope=v['scope_limit'],trial_only=True),side,drop
def rewrite_dropin(drop, prior_contract, new_contract):
 # Current v10 already overrides both commands. Preserve reset directives and every
 # unrelated byte;do not append a second post-start command or edit base unit.
 assert drop.count(str(OLD).encode())==drop.count(prior_contract.encode())==1
 assert drop.count(OLD_SHA.encode())==2 and str(NEW).encode() not in drop
 lines=drop.decode().splitlines()
 assert len([x for x in lines if x.startswith('ExecStart=') and x!='ExecStart='])==1
 assert len([x for x in lines if x.startswith('ExecStartPost=') and x!='ExecStartPost='])==1
 for prefix in ['ExecStart=','ExecStartPost=']:
  line=next(x for x in lines if x.startswith(prefix) and x!=prefix)
  assert line.count('--contract-sha256 '+OLD_SHA)==1
 result=drop.replace(str(OLD).encode(),str(NEW).encode()).replace(OLD_SHA.encode(),CONTRACT_SHA.encode()).replace(prior_contract.encode(),new_contract.encode())
 assert OLD_SHA.encode() not in result and result.count(CONTRACT_SHA.encode())==2
 assert result.count(b'ExecStartPost=')==2 # one reset and one actual command
 return result

def main():
 global CONTRACT_SHA,OLD_SHA
 p=argparse.ArgumentParser();p.add_argument('--contract-sha',required=True);p.add_argument('--current-contract-sha',required=True);p.add_argument('--quality-sha',required=True);p.add_argument('--speed-sha',required=True);p.add_argument('--install',action='store_true');a=p.parse_args();assert re.fullmatch('[0-9a-f]{64}',a.contract_sha);CONTRACT_SHA=a.contract_sha;assert re.fullmatch('[0-9a-f]{64}',a.current_contract_sha);OLD_SHA=a.current_contract_sha;assert OLD_SHA!=CONTRACT_SHA;admission,side,drop=qualify(a.quality_sha,a.speed_sha)
 if not a.install:print(json.dumps(dict(status='admission_passed_zero_nn_no_service_mutation',admission=admission)));return
 assert os.getuid()==0 and not REPORT.exists();lease=(ROOT/'data/ai/runtime-validation.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key']
 def get(url,auth=False):
  with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {}),timeout=5) as f:return json.load(f)
 def state():return get('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097',True)
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');streams=get('http://127.0.0.1:1985/api/v1/streams')['streams'];s=next(x for x in streams if x['app']=='live' and x['name']=='xm');assert h['ok'] and h['storageHealthy'] and h['writeDegradedChannels']==0 and s['publish']['active'];return dict(recorder={k:h[k] for k in ['ok','storageHealthy','writeDegradedChannels','droppedMsLastHour']},frames=s['frames'],recv_bytes=s['recv_bytes'])
 def service(action,n):run(['systemctl',action,n],100)
 def restored_wait(expected_config):
  deadline=time.monotonic()+200
  while True:
   try:
    s=state();m=media();pub=s['stats'].get('publish',{})
    if s['state']=='running' and s['stats']['consecutive_errors']==0 and s['stats']['inference_count']>=4 and pub.get('running') and pub.get('sei_injected',0)>=4 and pub.get('au_pushed',0)>0:assert s['config']==expected_config;return s,m
   except urllib.error.URLError:pass
   assert time.monotonic()<deadline,'Current AI results and real delayed SEI did not recover';time.sleep(.5)
 r=dict(status='admitted',started=time.time(),source_sha256=sha(__file__),admission=admission,source_recording_stopped=False,user_config_changed=False,trial_only=True,release_approved=False,memory_samples=0,backend_conservative_memory_maximum=0,combined_native_backend_conservative_memory_maximum=0);changed=False;stopped=False;newdrop=None;oldlink=os.readlink(SIDECAR)
 def interrupted(*_):raise RuntimeError('Owned vision O2 upgrade interrupted; restore owned transaction')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  before=state();assert before['state']=='running' and before['stats']['consecutive_errors']==0;assert health(False)['persistent_worker']['cached_models']==46
  r.update(before=before,media_before=media(),config_sha256=sha(ROOT/'data/ai/config_overlay.json'),protected_units={n:dict(pid=pid(n),start_ticks=ticks(pid(n))) for n in ['ainvr-recorder','ainvr-ingest']})
  current_count=before['stats']['inference_count'];deadline=time.monotonic()+130
  while True:
   current=state()
   if current['stats']['inference_count']>current_count and not health(False)['busy']:break
   assert time.monotonic()<deadline,'No idle native request boundary observed';time.sleep(.1)
  release=BASE/'runtime-trial-releases'/hashlib.sha256(encoded(admission)).hexdigest();assert not release.exists();release.mkdir(mode=0o755)
  (release/'admission.json').write_bytes(encoded(admission));(release/'prior-dropin.conf').write_bytes(drop);(release/'prior-sidecar.json').write_bytes(SIDECAR.read_bytes());newcontract=CONTRACT;(release/'model-contract.json').write_bytes(CONTRACT.read_bytes());assert sha(newcontract)==CONTRACT_SHA # Loader deliberately admits this exact BASE path;release keeps an audit copy.
  updated=copy.deepcopy(side);updated['generation']['contract_sha256']=CONTRACT_SHA;updated['installation']['prior_runtime_sources']=copy.deepcopy(side['installation']['runtime_sources']);updated['installation']['runtime_sources'].pop(str(OLD.relative_to(ROOT)));updated['installation']['runtime_sources'][str(NEW.relative_to(ROOT))]=sha(NEW);updated['installation']['runtime_sources'].update(admission['dependency_pins']);updated['installation'].update(runtime_release=str(release),production_contract=str(newcontract),production_contract_sha256=CONTRACT_SHA)
  updated['validation']['vision_o2_runtime_equivalence']=dict(report=str(Q),sha256=a.quality_sha,cases=160,retained_failed_indices=[117],quality_unchanged=True);updated['vision_o2_upgrade']=dict(admission=admission,installed_by=str(Path(__file__).resolve()),source_sha256=sha(__file__),runtime_measurements=str(REPORT));newside=release/SIDECAR.name;newside.write_bytes(encoded(updated))
  prior_contract=side['installation']['production_contract'];newdrop=rewrite_dropin(drop,prior_contract,str(newcontract))
  assert sha(DROP)==admission['prior_dropin_sha256'] and sha(SIDECAR)==admission['prior_sidecar_sha256'] and os.readlink(SIDECAR)==oldlink and sha(UNITFILE)==admission['base_unit_sha256'] and sha(ROOT/'data/ai/config_overlay.json')==r['config_sha256'];r['release']=str(release);save(r)
  stopped=True;service('stop','ainvr-ai');service('stop',UNIT);assert sha(DROP)==admission['prior_dropin_sha256'] and os.readlink(SIDECAR)==oldlink and sha(SIDECAR)==admission['prior_sidecar_sha256'];atomic(DROP,newdrop);changed=True;link=SIDECAR.with_name('.'+SIDECAR.name+'.vision-v288-link');assert not link.exists();link.symlink_to(newside);link.replace(SIDECAR);run(['systemctl','daemon-reload']);service('start',UNIT);service('start','ainvr-ai');r['status']='checking_current_production_results_and_SEI';save(r)
  sys.path.insert(0,str(CODE));from locateanything_process_memory_v4 import sample_owned_process,IncompleteProcessSnapshot
  deadline=time.monotonic()+200;bp=pid(UNIT);npid=pid('ainvr-ai');r.update(backend_pid=bp,backend_start_ticks=ticks(bp),native_ai_pid=npid,native_ai_start_ticks=ticks(npid))
  while True:
   try:s=state()
   except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.5);continue
   m=media();assert s['config']==before['config'] and sha(ROOT/'data/ai/config_overlay.json')==r['config_sha256'] and s['stats']['consecutive_errors']==0
   assert s['state'] not in ['error','failed']
   for n,x in r['protected_units'].items():assert pid(n)==x['pid'] and ticks(x['pid'])==x['start_ticks']
   try:
    vals={}
    for label,v,arg in [('backend',bp,str(NEW)),('native',npid,str(ROOT/'deploy/s100p/bin/ainvr_ai_service'))]:
     z=sample_owned_process(v,ticks(v),os.getpgid(v),arg);vals[label]=z['rss_bytes']+sum(z['owned_heap_bytes'].values())
    total=sum(vals.values());assert total<8_000_000_000;r['memory_samples']+=1;r['backend_conservative_memory_maximum']=max(r['backend_conservative_memory_maximum'],vals['backend']);r['combined_native_backend_conservative_memory_maximum']=max(r['combined_native_backend_conservative_memory_maximum'],total)
   except (FileNotFoundError,IncompleteProcessSnapshot):r['incomplete_memory_samples']=r.get('incomplete_memory_samples',0)+1
   pub=s['stats'].get('publish',{})
   if s['state']=='running' and s['stats']['inference_count']>=4 and pub.get('sei_injected',0)>=4 and pub.get('au_pushed',0)>0:break
   assert time.monotonic()<deadline;save(r);time.sleep(.5)
  h=health(True);assert h['persistent_worker']['cached_models']==46 and h['persistent_worker']['completed_requests']>=4 and h['persistent_worker']['failed_requests']==0 and h['observed_peer_pid']==bp and str(NEW).encode() in Path(f'/proc/{bp}/cmdline').read_bytes().split(b'\0');assert m['frames']>r['media_before']['frames'] and m['recv_bytes']>r['media_before']['recv_bytes'] and m['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'];assert r['memory_samples']>10
  assert DROP.read_bytes()==newdrop and SIDECAR.resolve()==newside and sha(ROOT/'deploy/s100p/bin/ainvr_ai_service')=='d87c78d1a3f57f760baeda1a35a4d6f68bbc369fce34c4f0e816ea564fe9e7be';r.update(status='installed_vision_o2_trial_and_current_native_results_real_SEI_verified',after=s,media_after=m,health_after=h,user_configuration_unchanged=True,original_recording_continuous=True,sidecar_target=str(newside),sidecar_sha256=sha(newside),dropin_sha256=sha(DROP))
 except BaseException:
  r.update(status='failed',error=traceback.format_exc());save(r)
  if stopped:
   try:
    service('stop','ainvr-ai');service('stop',UNIT)
    if changed:
     assert DROP.read_bytes()==newdrop;atomic(DROP,drop)
     if os.readlink(SIDECAR)!=oldlink:
      assert SIDECAR.resolve()==newside;link=SIDECAR.with_name('.'+SIDECAR.name+'.vision-v288-rollback');assert not link.exists();link.symlink_to(oldlink);link.replace(SIDECAR)
    run(['systemctl','daemon-reload']);service('start',UNIT);service('start','ainvr-ai');s,m=restored_wait(before['config']);r.update(rolled_back_owned_files=True,rollback_after=s,rollback_media=m,rollback_health=health(False))
   except BaseException:r['rollback_error']=traceback.format_exc()
  raise
 finally:r['finished']=time.time();save(r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','backend_conservative_memory_maximum','combined_native_backend_conservative_memory_maximum','user_configuration_unchanged','original_recording_continuous']}))
if __name__=='__main__':main()
