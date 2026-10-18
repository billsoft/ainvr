#!/usr/bin/env python3
"""Install the user-authorized full76-program W8 BPU trial with rollback.

The immutable failed160 guard and actual SEI/archive proof are mandatory. Inspection never grants the pending single-failure trial exception.
Default is read-only preflight. Preserve the exact evaluation artifact contract
and evaluation-only metadata: this is a trial,never formal product approval.
Neither source existence nor preflight proves installation/media/UI acceptance.
"""
from pathlib import Path
import argparse,ast,hashlib,json,math,os,pwd,signal,stat,subprocess,sys,time
ROOT=Path('/home/sunrise/ainvr');RESULTS=ROOT/'test/results';CODE=ROOT/'test/model_conversion'
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
UNIT='ainvr-locateanything-official-bpu.service'
BACKEND_SHA='0ed693df99b3597d927bc0224b8ce02fb22f5b41c49853b651b08a3c743a360d'
HEALTH_SHA='dfdcb83fc1b5a753543fc4f4cb0102a4bbc1fd06ed40fd2fc02043ca717926fb'
TOKENIZER_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
EVALUATOR_SHA='f676d759f87aae8e2eee3d2148d26791af96217b88380254aac5a36864bf8efb'
SCORER_SHA='69e88a0202aad9ee9ec45150607c885d44810cba2970c26dcd9be1cdaafc0093'
CONTRACT_SHA='fd3e01f51bc36edaa62b3f5f45fc8507f03ae263ed53420fbc3df3cfb1fed042'
REFERENCE_SHA='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253'
BINDING_SHA='4d50c247a0898c527d9b00ff194f972a70046716dc301999928b27738a79e3c1'
NATIVE_SOURCE_SHA='58f7423fffb9b3dca084ef34175bc9de34d490465caf7152080c84285274eaa6'
MARKER='# Managed by AINVR install-locateanything-official-family-s100p-v2.py\n'
def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for block in iter(lambda:f.read(4*1024**2),b''):h.update(block)
 return h.hexdigest()
def encoded(value):return (json.dumps(value,indent=2,allow_nan=False)+'\n').encode()
def read(path):return json.loads(Path(path).read_text())
def checked(path,parent):
 path=Path(path).resolve(strict=True)
 if not path.is_relative_to(parent.resolve()):raise ValueError('Evidence outside declared root')
 return path

QUALITY_GUARD_SHA='602fefa02a63457f52199294f0a605ef1511ff26de114c3d103421eb9d5a59b3'
FINAL_RAW_SHA='8dfbecd5c9031e113c774cdd7478e80a2e9bef28ec92a073cfc0d3dd509665e8'
SEI_GUARD_SHA='eaa76c3c2f6c07bb69ba517c0cb04bdbb20e00631cdd288710e71972250f3e56'
POINT_ADMISSION_SHA='1279cf4e0dba0d207f4d7b7b1d91d701969bbc662758ef1388053f190985471f'
MANIFEST_BUILDER_SHA='1b6a2a6ba3ad9c3a32d8534356cd3ba064f0ce7a14ec5d9170b971f1cfd7d829'
SERVICE_CANDIDATE_SHA='ac172c7210b0208844c7b6eae757cc7c006a36aae849947c5a21a583b4ca8218'
ADAPTER_SHA='4be5fdbabf3824ec4395a93958c4855bd05e25d216209299f3ee4f1270760e68'
WORKER_SHA='715f21205a8fc03c4cc65791191a57954083b7bf8cc2858e08533a73d2876c47'

def require_quality_guard(d,contract_sha,known_failure_plan=False):
 if not known_failure_plan:
  raise ValueError('Frozen all160 gate failed;known nonterminal117 trial exception is pending. Read-only --inspect-known-failure-plan is available;installation requires explicit --accept-known-failure-117 after human acceptance.')
 expected={'status':'completed_all160_operations_guard','source_sha256':EVALUATOR_SHA,'contract_sha256':contract_sha,'candidate_quality_passed':False,'neural_calls_exact':True,'production_unchanged_and_fresh':True,'owned_backend_stopped':True,'private_socket_removed':True,'binding_sha256':BINDING_SHA,'reference_index_sha256':REFERENCE_SHA,'backend_sha256':BACKEND_SHA,'raw_sha256':FINAL_RAW_SHA}
 for key,value in expected.items():
  if d.get(key)!=value:raise ValueError('Frozen final guard mismatch:'+key)
 if not d.get('owned_ion_after_exit') or sum(d['owned_ion_after_exit'].values())!=0:raise ValueError('Final allocations not released')
 for key in ['conservative_backend_memory_bytes_maximum','conservative_experiment_process_memory_bytes_maximum']:
  v=d.get(key)
  if type(v) is not int or not 0<v<=10400000000:raise ValueError('Actual final memory missing/over limit')
 if type(d.get('neural_calls')) is not int or d['neural_calls']!=25794:raise ValueError('Exact actual final BPU call count required')
 summary=d['summary']
 for key,value in {'trial_quality_passed':False,'candidate_coverage_complete':True,'all_candidate_outputs_terminal_well_formed_and_typevalid':False,'observed_candidate_cases':160,'eligible_reference_cases':157,'native_failure_indices':[52,105,117],'valid_candidate_count':159,'iou_threshold':.9,'matched_boxes':137,'candidate_boxes':231,'reference_boxes':219}.items():
  if summary.get(key)!=value:raise ValueError('Frozen failed summary mismatch:'+key)
 for key in ['precision','recall']:
  v=summary.get(key)
  if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not .45<=v<=1:raise ValueError('Below user numeric trial floor')

def require_actual_sei_archive(native_path):
 from collections import Counter
 if native_path!=RESULTS/'official-native-sei-archive-v2.json' or digest(native_path)!=SEI_GUARD_SHA:raise ValueError('Exact actual SEI guard required')
 d=read(native_path)
 expected={'status':'completed','contract_sha256':CONTRACT_SHA,'backend_sha256':BACKEND_SHA,'native_completed_requests':2,'neural_calls':430,'production_unchanged_and_fresh':True,'owned_backend_stopped':True,'private_socket_removed':True,'model_adapter_sha256':ADAPTER_SHA,'worker_source_sha256':WORKER_SHA,'runtime_manifest_builder_sha256':MANIFEST_BUILDER_SHA,'quality_override_accepted':False}
 for k,v in expected.items():
  if d.get(k)!=v:raise ValueError('Actual SEI proof mismatch:'+k)
 if not d.get('owned_ion_after_exit') or sum(d['owned_ion_after_exit'].values())!=0:raise ValueError('SEI resources not released')
 memory=d['native_plus_backend_sampled_memory_bytes_maximum']
 if type(memory) is not int or not 0<memory<=10400000000:raise ValueError('Actual SEI/archive memory missing/over limit')
 client_path=RESULTS/'official-native-sei-archive-v2/client.json'
 if digest(client_path)!=d['client_sha256']:raise ValueError('Actual SEI client report changed')
 client=read(client_path)
 if client!=d['client'] or client['status']!='completed' or client['actual_model_requests']!=2 or client['retained_contexts']!=46 or not client['archive_verified'] or not client['actual_sei_readback_verified'] or not client['stream_published']:raise ValueError('Actual full-model publication evidence required')
 raw_path=BASE/'official-native-sei-archive-v2/hardware-history/summary.json'
 if digest(raw_path)!=client['native_report_sha256']:raise ValueError('Actual native SEI trace changed')
 raw=read(raw_path)
 if raw!=client['native'] or not raw['passed'] or raw['metadata_injected_by_observer'] or raw['video_reencoded'] or raw['cpu_neural_fallback'] or raw['complete_model_inferences']!=2 or raw['jpeg_jpu']!=11 or raw['jpeg_cpu']!=0 or raw['records_verified']!=11:raise ValueError('Actual native frame/archive result differs')
 count=0
 for index,trace in enumerate(client['traces']):
  parent=BASE/'official-native-sei-archive-v2/backend-inputs'/f'request-{index:03d}'
  if Path(trace['request'])!=parent/'request.json' or Path(trace['result'])!=parent/'result.json' or digest(trace['request'])!=trace['request_sha256'] or digest(trace['result'])!=trace['result_sha256']:raise ValueError('Exact private backend traces required')
  request=read(trace['request']);answer=read(trace['result'])
  if request['tokens']!=256 or request['contract_sha256']!=CONTRACT_SHA or not answer['terminal'] or answer['neural_cpu_fallback'] or answer['bpu_calls']!=trace['bpu_calls']:raise ValueError('Backend trace differs')
  if digest(parent/'pixel_values.npy')!=request['prepared_pixels_sha256'] or digest(parent/'input_ids.npy')!=request['input_ids_sha256']:raise ValueError('Actual private inputs changed')
  if answer['executor_stats']['loads']!=0 or answer['executor_stats']['evictions']!=0:raise ValueError('Model was reloaded between requests')
  count+=answer['bpu_calls']
 if len(client['traces'])!=2 or count!=430:raise ValueError('Actual private BPU coverage differs')
 points=Counter()
 if len(raw['actual_sei_readback'])!=2:raise ValueError('Two actual published frames required')
 for pair in raw['actual_sei_readback']:
  frame=pair['actual_result'];wire=pair['readback']['metadata']
  if frame['model']['provider']!='bpu' or frame['model']['name']!='locateanything-3b' or frame['model']['input_size']!=[224,448] or frame['frame_width']!=3840 or frame['frame_height']!=1920:raise ValueError('Actual4K own-model result required')
  if pair['timestamp_offset_ns']!=0 or wire['pts']!=frame['frame_pts_ns'] or wire['pts']!=pair['readback']['packet_pts_ns'] or wire['ch']!=frame['channel_id'] or wire['model_extra']!=frame['model_extra'] or wire['det'] or frame['detections']:raise ValueError('SEI/frame content or timestamps differ')
  grounding=wire['model_extra']['grounding']
  if not grounding['complete'] or grounding['neural_provider']!='bpu' or grounding['neural_cpu_fallback'] or grounding['coordinate_space']!='normalized_full_frame':raise ValueError('Invalid native point metadata')
  for point in grounding['points']:
   points[(wire['pts'],round(point['x'],12),round(point['y'],12),point['label_id'])]+=1
 actual=Counter()
 for item in raw['sample_records']['items']:
  if item['bbox'] is not None or item['geometry_type']!='point' or item['context_image']!='full_frame' or item['model_name']!='locateanything-3b':raise ValueError('Point archive geometry corrupted')
  point=item['point']
  if point['coordinate_space']!='normalized_full_frame' or any(not math.isfinite(point[k]) or not 0<=point[k]<=1 for k in ['x','y']):raise ValueError('Invalid archived point')
  actual[(item['frame_pts_ns'],round(point['x'],12),round(point['y'],12),item['label_id'])]+=1
 if actual!=points or sum(points.values())!=11:raise ValueError('Complete actual point archive multiset differs')
 delivery=raw['archive_stats']['delivery']
 if delivery['accepted']!=11 or delivery['committed']!=11 or delivery['outstanding']!=0 or delivery['quarantined']!=0 or raw['archive_stats']['write_error_count']!=0:raise ValueError('Archive did not commit/drain')
 admission=RESULTS/'locateanything-private-sei-point-archive-admission-v1.json'
 if digest(admission)!=POINT_ADMISSION_SHA:raise ValueError('Independent point admission changed')
 return memory,raw

def preflight(a):
 contract=checked(a.contract,BASE);quality_path=checked(a.quality_report,RESULTS)
 if contract!=BASE/'official-full-family-w8a16-o2-all-ar-head-v1.json' or a.contract_sha256!=CONTRACT_SHA or digest(contract)!=CONTRACT_SHA or quality_path!=RESULTS/'locateanything-independent-final-ar2-pref0-head2-v2-guard.json' or a.quality_sha256!=QUALITY_GUARD_SHA or digest(quality_path)!=QUALITY_GUARD_SHA:raise ValueError('Exact frozen candidate and failed evidence identities required')
 accepted=bool(a.accept_known_failure_117);inspect_only=bool(a.inspect_known_failure_plan)
 if a.install and (not accepted or inspect_only):raise ValueError('Inspect plan cannot install; explicit accepted117 flag required for trial installation')
 guard=read(quality_path);require_quality_guard(guard,CONTRACT_SHA,accepted or inspect_only)
 for path,pin in [(CODE/'evaluate_locateanything_independent_final_v2.py',EVALUATOR_SHA),(CODE/'score_locateanything_independent_final_v2.py',SCORER_SHA),(ROOT/'ai-service/runtime/locateanything_bpu_official_executor_v5.py',BACKEND_SHA),(ROOT/'ai-service/runtime/locateanything_official_family_health_v1.py',HEALTH_SHA),(CODE/'locateanything_runtime_manifest_v1.py',MANIFEST_BUILDER_SHA),(ROOT/'ai-service/src/adapters/locateanything_bpu_adapter.hpp',ADAPTER_SHA),(ROOT/'ai-service/src/pipeline/reused_channel_worker.cpp',WORKER_SHA)]:
  if digest(path)!=pin:raise ValueError('Accepted source identity changed:'+str(path))
 sys.path.insert(0,str(ROOT/'ai-service/runtime'));sys.path.insert(0,str(CODE))
 import evaluate_locateanything_independent_final_v2 as final
 from score_locateanything_independent_final_v2 import summarize
 from locateanything_bpu_official_executor_v5 import verify_sources
 from locateanything_official_family_dispatch_v3 import load_official_generator
 from locateanything_prompt import LocateAnythingPrompt
 from locateanything_runtime_manifest_v1 import build_runtime_manifest
 final.REF_SHA=REFERENCE_SHA;final.check_binding(contract,CONTRACT_SHA,BINDING_SHA);verify_sources()
 begin=time.monotonic();generator,model=load_official_generator(contract,CONTRACT_SHA);constructor_seconds=time.monotonic()-begin
 if len(generator.specs)!=76 or len({str(s.path.resolve()) for s in generator.specs})!=46 or model['evaluation_only'] is not True or model['release_approved'] is not False:raise ValueError('Full frozen architecture required')
 raw_path=BASE/'independent-final-bpu-ar2-pref0-head2-trial-v2/status.json'
 if digest(raw_path)!=FINAL_RAW_SHA:raise ValueError('Original failed final report changed')
 raw=read(raw_path);reference=read(BASE/'independent-final-native-reference-v2-head-o2/reference-index-v3.json')
 if raw['status']!='completed_all160_candidate_operations' or len(raw['cases'])!=160 or raw['source_sha256']!=EVALUATOR_SHA or raw['binding_sha256']!=BINDING_SHA or raw['reference_index_sha256']!=REFERENCE_SHA or raw['contract_sha256']!=CONTRACT_SHA or raw['failed_rpc_count']!=0:raise ValueError('Actual complete final operations required')
 funcs=final.parser_functions();prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKENIZER_SHA)
 calls=0;decode_tokens=0;decode_seconds=0.;maximum=0.;failed=[]
 for c in raw['cases']:
  answer=c['answer']
  if answer.get('ok') is not True or answer.get('contract_sha256')!=CONTRACT_SHA or answer.get('neural_cpu_fallback') is not False or prompt.decode(answer['generated_ids'])!=answer['response'] or funcs['parse_response'](answer['response'])!=c['candidate']:raise ValueError('Generated result or parser evidence changed')
  if c['index']==117:
   if answer['terminal'] is not False or c['terminal'] is not False or c['reference_eligible'] is not False or answer['stopped_at_token_limit'] is not True or len(answer['generated_ids'])!=256 or c['candidate']['malformed_blocks']!=['unclosed_box'] or c['candidate']['points']:raise ValueError('Known failed117 output differs')
   failed.append(117)
  elif answer['terminal'] is not True or c['terminal'] is not True or c['candidate']['malformed_blocks'] or (c['kind']=='box' and c['candidate']['points']) or (c['kind']=='point' and c['candidate']['boxes']):raise ValueError('Unexpected operational failure')
  if answer.get('models_retained_for_next_request') is not True or answer.get('generation_state_retained') is not False or answer.get('image_features_retained') is not False or answer['executor_stats']['loads']!=0 or answer['executor_stats']['evictions']!=0 or answer['executor_stats']['calls']!=answer['bpu_calls']:raise ValueError('Complete persistent runtime evidence differs')
  calls+=answer['bpu_calls'];decode_tokens+=len(answer['generated_ids'])-1;decode_seconds+=sum(s['seconds'] for s in answer['steps'][1:]);maximum=max(maximum,c['rpc_seconds'])
 summary=summarize(raw['cases'],funcs['parse_response'],funcs['iou'],funcs['maximum_matches'],reference)
 if summary!=raw['summary'] or summary!=guard['summary'] or calls!=raw['neural_calls'] or calls!=guard['neural_calls'] or failed!=[117]:raise ValueError('Recomputed frozen failure/quality/calls differ')
 tps=decode_tokens/decode_seconds if decode_seconds>0 else 0
 if not math.isfinite(tps) or tps<5:raise ValueError('Native decode below5 token/s')
 native_path=checked(a.native_proof,RESULTS)
 if a.native_proof_sha256!=SEI_GUARD_SHA:raise ValueError('Actual SEI digest required')
 memory,native=require_actual_sei_archive(native_path)
 candidate=BASE/'official76-service-candidate-v3/ainvr_s100p_control_service'
 candidate_manifest=candidate.parent/'source-and-runtime-manifest.json';current=read(candidate_manifest)
 if digest(candidate)!=SERVICE_CANDIDATE_SHA or current['candidate_sha256']!=SERVICE_CANDIDATE_SHA or current['runtime']['ffmpeg']['version']!='8.1.2':raise ValueError('Verified service candidate required')
 for rel,pin in current['source_files_sha256'].items():
  if digest(ROOT/rel)!=pin:raise ValueError('Candidate source changed:'+rel)
 account=pwd.getpwnam('sunrise');python=ROOT/'ai-service/runtime/.venv-locateanything/bin/python'
 if not python.is_file() or (ROOT/'data/ai').stat().st_uid!=account.pw_uid:raise ValueError('Runtime service account unavailable')
 bound=max(90,math.ceil(maximum*1.5+10))
 if bound!=90:raise ValueError('New request/retention bound needs matching actual SEI proof')
 backend=ROOT/'ai-service/runtime/locateanything_bpu_official_executor_v5.py';health=ROOT/'ai-service/runtime/locateanything_official_family_health_v1.py'
 sources={str(p.relative_to(ROOT)):digest(p) for p in [backend,health,ROOT/'ai-service/runtime/locateanything_prompt.py',ROOT/'ai-service/runtime/locateanything_request_server.py',ROOT/'ai-service/runtime/locateanything_persistent_request_worker_v1.py']}
 exception=dict(indices=[117],valid_candidate_count=159,required_candidate_count=160,frozen_trial_quality_passed=False,numeric_floor_passed=True,acceptance_pending=not accepted,accepted_for_trial_by_explicit_caller_flag=accepted,failed_output_policy='Reject entire unfinished output; no truncated boxes/SEI/archive; expose perrequest failure and respect cadence; later success clears error',failure_recovery_proof_sha256=digest(RESULTS/'locateanything-generation-worker-recovery-v1.json'))
 fingerprint=hashlib.sha256(encoded(dict(contract=CONTRACT_SHA,quality=QUALITY_GUARD_SHA,native=SEI_GUARD_SHA,sources=sources,bound=bound,trial_exception=exception))).hexdigest();release=BASE/'official-trial-releases'/fingerprint
 plan=dict(release=str(release),production_contract=str(release/'model-contract.json'),production_contract_sha256=CONTRACT_SHA,socket=str(ROOT/'data/ai/locateanything-official-bpu.sock'),mode='slow',maximum_seconds=bound,resident_models=46,startup_seconds=600,service_account=account.pw_name,service_uid=account.pw_uid,component_count=76,physical_hbms=46,observed_maximum_case_wall_seconds=maximum,recommended_minimum_interval_ms=max(120000,math.ceil(maximum*1.25*1000)),quality=summary,quality_report=str(quality_path),quality_sha256=QUALITY_GUARD_SHA,native_proof=str(native_path),native_proof_sha256=SEI_GUARD_SHA,aggregate_native_decode_tokens_per_second=tps,native_plus_backend_memory_bytes=memory,runtime_sources=sources,trial_evaluation_only=True,constructor_seconds=constructor_seconds,trial_exception=exception,service_candidate=str(candidate),service_candidate_sha256=SERVICE_CANDIDATE_SHA,backend_health_readiness_does_not_prove_preloaded=True,video_startup_delay_seconds=95)
 anchor=BASE/'vision-fp32-prefix-v4/model.hbm';manifest=build_runtime_manifest(anchor,plan['socket'],CONTRACT_SHA,bound)
 plan['media_retention']=manifest['media_retention']
 manifest.update(precision='W8/mixed-A16;not compact INT4',quality_override_accepted=accepted,validation=dict(original_frozen_quality=summary,quality_sha256=QUALITY_GUARD_SHA,native_proof_sha256=SEI_GUARD_SHA,trial_exception=exception),installation=plan,lifecycle='Proposed or explicitly accepted BPU trial; original frozen failure is preserved. Native service installation and actual UI acceptance remain required.')
 return plan,contract.read_bytes(),encoded(manifest),anchor


# Transactional publication/rollback retained from compact installer SHAa881297afc318eace4c9c4995bbabc15998a44fc90e175b0f649454e3a506687
def state(path):
 try:s=path.lstat()
 except FileNotFoundError:return ('absent',None)
 if stat.S_ISLNK(s.st_mode):return ('link',os.readlink(path))
 if stat.S_ISREG(s.st_mode):return ('file',path.read_bytes(),stat.S_IMODE(s.st_mode))
 raise ValueError('Unexpected deployment path type')
def write_atomic(path,data,mode=0o644):
 temp=path.with_name('.'+path.name+'.install-'+str(os.getpid()))
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(temp,path)
  directory=os.open(path.parent,os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:
  if temp.exists():temp.unlink()
def replace_state(path,value):
 kind,data=value[:2]
 if kind=='file':write_atomic(path,data,value[2])
 elif kind=='link':
  temp=path.with_name('.'+path.name+'.install-'+str(os.getpid()));temp.symlink_to(data)
  try:os.replace(temp,path)
  finally:
   if temp.is_symlink():temp.unlink()
 elif kind=='absent':path.unlink(missing_ok=True)
 else:raise ValueError('Invalid deployment state')
class Publication:
 def __init__(self):self.changes=[]
 def publish(self,path,new):
  old=state(path)
  if old==new:return
  if state(path)!=old:raise RuntimeError('Deployment path changed before publication')
  self.changes.append((path,old,new));replace_state(path,new)
 def rollback(self):
  conflicts=[]
  for path,old,new in reversed(self.changes):
   current=state(path)
   if current==old:continue
   if current!=new:conflicts.append(str(path));continue
   try:replace_state(path,old)
   except Exception:conflicts.append(str(path))
  if conflicts:raise RuntimeError('Concurrent edit or failed restoration;other owned entries recovered;manual recovery required: '+', '.join(conflicts))
def run(*args,timeout=60):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout).stdout
def service_state():
 result=subprocess.run(['systemctl','is-active',UNIT],capture_output=True,text=True,timeout=10)
 value=result.stdout.strip()
 if value not in ('active','inactive','unknown','activating','deactivating','failed'):raise RuntimeError('Unknown backend service state')
 return value
def render_unit(plan):
 python=ROOT/'ai-service/runtime/.venv-locateanything/bin/python';backend=ROOT/'ai-service/runtime/locateanything_bpu_official_executor_v5.py';helper=ROOT/'ai-service/runtime/locateanything_official_family_health_v1.py'
 args=[str(python),str(backend),'--contract',plan['production_contract'],'--contract-sha256',plan['production_contract_sha256'],'--tokenizer',str(BASE/'tokenizer-original-v1.json'),'--tokenizer-sha256',TOKENIZER_SHA,'--socket',plan['socket'],'--mode','slow','--maximum-seconds',str(plan['maximum_seconds'])]
 health=[str(python),str(helper),'--socket',plan['socket'],'--contract-sha256',plan['production_contract_sha256'],'--mode','slow','--maximum-seconds',str(plan['maximum_seconds']),'--wait-seconds',str(plan['startup_seconds'])]
 data=(MARKER+'[Unit]\nDescription=AINVR complete LocateAnything76 BPU trial backend\nAfter=local-fs.target\n\n[Service]\nType=exec\nEnvironment=LD_LIBRARY_PATH=/usr/hobot/lib\nEnvironment=GSETTINGS_BACKEND=memory\nUser=sunrise\nGroup=sunrise\nWorkingDirectory='+str(ROOT/'ai-service')+'\nExecStart='+' '.join(args)+'\nExecStartPost='+' '.join(health)+'\nRestart=on-failure\nRestartSec=3\nTimeoutStartSec='+str(plan['startup_seconds']+10)+'\nTimeoutStopSec=30\nKillSignal=SIGTERM\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nLimitNOFILE=4096\n').encode()
 return data,health
def install(plan,production,manifest,anchor):
 if os.geteuid()!=0:raise PermissionError('Installation requires root on the S100P')
 account=pwd.getpwnam(plan['service_account']);python=ROOT/'ai-service/runtime/.venv-locateanything/bin/python'
 helper=ROOT/'ai-service/runtime/locateanything_official_family_health_v1.py'
 unit=ROOT/'deploy/s100p'/UNIT;system=Path('/etc/systemd/system')/UNIT
 dropin=ROOT/'deploy/s100p/ainvr-ai-locateanything-official.conf'
 system_dropin=Path('/etc/systemd/system/ainvr-ai.service.d/45-locateanything-official-bpu.conf')
 entries=ROOT/'ai-service/models/derived/s100p'
 for path,target in [(system,unit),(system_dropin,dropin)]:
  if state(path) not in [('absent',None),('link',str(target))]:raise ValueError('Unmanaged system service entry preserved')
 for path in [unit,dropin]:
  if path.exists() and (path.is_symlink() or not path.read_text().startswith(MARKER)):raise ValueError('Unmanaged repository service file preserved')
 for path in [entries/'locateanything-3b.hbm',entries/'locateanything-3b.hbm.ainvr.json']:
  if state(path)[0]!='absent' and (not path.is_symlink() or not path.resolve().is_relative_to(BASE/'official-trial-releases')):
   raise ValueError('Unmanaged LocateAnything model entry preserved')
 protected={ROOT/rel:digest(ROOT/rel) for rel in ['data/ai/config_overlay.json','deploy/s100p/runtime/ai-service.json','deploy/s100p/runtime/ai-service.env']}
 own_names={'locateanything-3b.hbm','locateanything-3b.hbm.ainvr.json'}
 other_models={p.name:(p.lstat().st_size,p.lstat().st_mtime_ns,os.readlink(p) if p.is_symlink() else None) for p in entries.iterdir() if p.name not in own_names}
 release=Path(plan['release'])
 for directory in [release.parent,release]:
  if directory.is_symlink():raise ValueError('Release directory must not be a symlink')
  if not directory.exists():directory.mkdir(mode=0o755);directory.chmod(0o755)
 for path,data in [(release/'model-contract.json',production),(release/'locateanything-3b.hbm.ainvr.json',manifest)]:
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=data:raise ValueError('Immutable trial release changed')
  else:write_atomic(path,data)
 model=release/'locateanything-3b.hbm'
 if state(model)==('absent',None):model.symlink_to(anchor)
 if not model.is_symlink() or model.resolve()!=anchor.resolve():raise ValueError('Immutable prefix anchor changed')
 unit_data,health=render_unit(plan)
 publication=Publication();initial=service_state()
 if initial not in ('active','inactive','unknown'):raise RuntimeError('Existing backend service is not in a stable state')
 was_active=initial=='active';touched=False
 handlers={s:signal.getsignal(s) for s in [signal.SIGTERM,signal.SIGHUP]}
 def interrupted(signum,_frame):raise RuntimeError('Installation interrupted: '+str(signum))
 for s in handlers:signal.signal(s,interrupted)
 try:
  if was_active:touched=True;run('systemctl','stop',UNIT)
  publication.publish(unit,('file',unit_data,0o644));publication.publish(system,('link',str(unit)))
  publication.publish(dropin,('file',(MARKER+'[Unit]\nWants='+UNIT+'\nAfter='+UNIT+'\n').encode(),0o644))
  system_dropin.parent.mkdir(exist_ok=True);publication.publish(system_dropin,('link',str(dropin)))
  run('systemctl','daemon-reload');touched=True;run('systemctl','start','--no-block',UNIT)
  probe=subprocess.run(health,check=True,capture_output=True,text=True,timeout=plan['startup_seconds']+5,
   user=account.pw_uid,group=account.pw_gid,extra_groups=os.getgrouplist(account.pw_name,account.pw_gid))
  response=json.loads(probe.stdout.strip());deadline=time.monotonic()+10
  while service_state()!='active':
   if time.monotonic()>deadline:raise RuntimeError('Backend unit did not enter active state')
   time.sleep(.1)
  publication.publish(entries/'locateanything-3b.hbm',('link',str(model)))
  publication.publish(entries/'locateanything-3b.hbm.ainvr.json',('link',str(release/'locateanything-3b.hbm.ainvr.json')))
  if any(digest(p)!=sha for p,sha in protected.items()):raise RuntimeError('Existing production configuration changed')
  current={p.name:(p.lstat().st_size,p.lstat().st_mtime_ns,os.readlink(p) if p.is_symlink() else None) for p in entries.iterdir() if p.name not in own_names}
  if current!=other_models:raise RuntimeError('Existing other model entries changed')
  return dict(backend_ready=response,backend_active=True,model_entry_published=True,other_model_entries_preserved=True,
   production_configuration_preserved=True,native_service_restarted=False,recorder_or_ingest_or_miners_signalled=False,
   native_binary_and_camera_media_archive_ui_acceptance_pending=True,memory_and_speed_acceptance_pending=False,formal_native_service_stream_archive_ui_acceptance_pending=True)
 except BaseException:
  for s in handlers:signal.signal(s,signal.SIG_IGN)
  recovery_errors=[]
  if touched:
   try:run('systemctl','stop',UNIT)
   except Exception:recovery_errors.append('Backend stop failed during rollback')
  try:publication.rollback();run('systemctl','daemon-reload')
  except Exception:recovery_errors.append('Deployment publication rollback failed;concurrent changes preserved')
  if was_active and not recovery_errors:
   try:
    run('systemctl','start','--no-block',UNIT);deadline=time.monotonic()+600
    while service_state()!='active':
     if service_state()=='failed' or time.monotonic()>=deadline:raise RuntimeError('Original backend readiness was not recovered')
     time.sleep(.25)
   except Exception:recovery_errors.append('Original backend restart failed')
  if recovery_errors:raise RuntimeError('; '.join(recovery_errors))
  raise
 finally:
  for s,handler in handlers.items():signal.signal(s,handler)

def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['contract','quality-report','native-proof','report']:p.add_argument('--'+name,type=Path,required=True)
 for name in ['contract-sha256','quality-sha256','native-proof-sha256']:p.add_argument('--'+name,required=True)
 p.add_argument('--install',action='store_true');p.add_argument('--inspect-known-failure-plan',action='store_true');p.add_argument('--accept-known-failure-117',action='store_true');a=p.parse_args()
 if a.report.parent.resolve()!=RESULTS.resolve() or a.report.exists():raise ValueError('Use a new canonical task report')
 r=dict(status='preflight_running',time=time.time(),model_installed=False,ui_enabled=False,neural_calls=0,
  source_sha256=digest(Path(__file__)),installation_requested=a.install,whole_model_quality_certified_by_this_script=False)
 try:
  plan,production,manifest,anchor=preflight(a);r['plan']=plan
  if a.install:r.update(installation=install(plan,production,manifest,anchor),status='backend_and_model_installed_ui_pending',model_installed=True)
  else:r['status']='exception_plan_preflight_passed_not_installed' if a.inspect_known_failure_plan else 'preflight_passed_not_installed'
 except BaseException as error:
  r.update(status='failed',error_type=type(error).__name__,error=str(error));raise
 finally:
  r['finished']=time.time()
  with a.report.open('x') as f:f.write(json.dumps(r,indent=2,allow_nan=False)+'\n')
  print(json.dumps({k:r[k] for k in ['status','model_installed','ui_enabled','neural_calls']}))

if __name__=='__main__':main()
