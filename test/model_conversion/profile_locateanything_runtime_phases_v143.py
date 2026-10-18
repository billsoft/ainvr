"""Measure unchanged current v7 model runtime stages with existing native counters.

Eleven requests:one warmup then two rounds of frozen indices0,1,5,79,159.
Private process instrumentation only;no model/runtime source replacement. Native
submit/wait/release includes scheduler/device service,not pure MAC busy cycles.
"""
from pathlib import Path
import argparse,fcntl,gc,hashlib,json,os,signal,statistics,subprocess,sys,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');OUT=BASE/'full-runtime-phase-profile-v143';REPORT=ROOT/'test/results/locateanything-runtime-phase-profile-v143-guard.json';PYTHON=RUNTIME/'.venv-locateanything/bin/python';BACKEND=RUNTIME/'locateanything_bpu_prefill_o2_executor_v7.py';CONTRACT=BASE/'official-full-family-w8a16-prefill-o2-g0-v130.json';CONTRACT_SHA='04fe2aea85d8a3467cb98747a9c10c2d0d9d04cae22417527107e29694b39e26'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name('.'+p.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def admit():
 assert sha(BACKEND)=='c918ba39fa40a6f22a55e096bb2bd6d3457ce2db7345c5f20107c1b2472de181' and sha(CONTRACT)==CONTRACT_SHA and sha(CODE/'regress_locateanything_prefill_o2_v135.py')=='f0227828e1098b493d27384987b5a4560bcf3905e6ea1e0a63491ff2bab0dfb8'
 sys.path.insert(0,str(CODE));sys.path.insert(0,str(RUNTIME));import regress_locateanything_prefill_o2_v135 as frozen
 reference,_,_,_=frozen.admission();p=BASE/'prefill-o2-g0-frozen160-v135/status.json';assert sha(p)=='f76feb4852c5b904a091784bc05c266f40412dda01a11c893874c7f50f64c790';old=read(p);assert old['runtime_equivalence_passed'] and old['retained_failed_indices']==[117] and len(old['cases'])==160;return reference,old
def worker():
 assert os.getuid()==1000 and OUT.is_dir() and not (OUT/'status.json').exists();reference,old=admit();import numpy as np
 import locateanything_bpu_prefill_o2_executor_v7 as backend_module
 import locateanything_official_family_v1 as family
 import locateanything_bpu_generation_v1 as generation
 original_executor=backend_module.OfficialProgramExecutor;control_rows=[]
 def wrapped(label,fn):
  def timed(*args,**kwargs):
   start=time.perf_counter();result=fn(*args,**kwargs);control_rows.append(dict(kind=label,ms=(time.perf_counter()-start)*1000));return result
  return timed
 family.prepare_official_group_arrays=wrapped('prepare_KV_and_inputs',family.prepare_official_group_arrays);family.commit_official_group_arrays=wrapped('commit_KV_outputs',family.commit_official_group_arrays);generation.select_tokens=wrapped('original_token_selection_control',generation.select_tokens)
 class TimedExecutor(original_executor):
  def __init__(self,*a,**k):super().__init__(*a,**k);self.profile_rows=[]
  def run_ordered(self,key,values):
   s=self.specs[key];rt=self.loaded[str(s.path.resolve())]['runtime'];before=dict(rt.reuse_stats);begin=time.perf_counter();answer=super().run_ordered(key,values);checked=(time.perf_counter()-begin)*1000;after=rt.reuse_stats
   fields=['calls','allocation_ms','copy_clean_ms','submit_wait_release_ms','invalidate_host_copy_ms','total_ms'];delta={k:after.get(k,0)-before.get(k,0) for k in fields};assert delta['calls']==1 and all(x>=0 for x in delta.values());assert abs(sum(delta[k] for k in fields[1:-1])-delta['total_ms'])<1e-6
   self.profile_rows.append(dict(key=key,program=s.program,checked_run_ms=checked,native=delta,input_valid_bytes=sum(x.nbytes for x in values),output_valid_bytes=sum(x.nbytes for x in answer)));return answer
 backend_module.OfficialProgramExecutor=TimedExecutor
 r=dict(status='running_private_full_model_runtime_phase_profile',started=time.time(),pid=os.getpid(),start_ticks=ticks(os.getpid()),source_sha256=sha(__file__),scope=__doc__,cases=[],total_neural_calls=0,all_selected_outputs_identical=True,all_models_released=False,production_source_modified=False,whole160_qualification=False,release_approved=False)
 save(OUT/'phase.json',dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),stage='construct_and_preload'));save(OUT/'status.json',r);backend=None
 try:
  backend=backend_module.OfficialEvaluationBackend(CONTRACT,CONTRACT_SHA,BASE/'tokenizer-original-v1.json','f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40',maximum_seconds=900)
  for run,index in enumerate([1]+[0,1,5,79,159]*2):
   native=reference['cases'][index];gold=old['cases'][index]['answer'];arrays={k:np.load(BASE/'independent-final-native-reference-v2-head-o2'/native[k],allow_pickle=False) for k in ['pixels','ids']};assert gold['terminal']
   def clear(e):e.profile_rows.clear();control_rows.clear()
   backend._worker.execute(clear,lambda:False,900);save(OUT/'phase.json',dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),stage=f'run{run}-index{index}'));begin=time.perf_counter();answer=backend.generate(arrays['pixels'],arrays['ids'],256,lambda:False);wall=time.perf_counter()-begin;rows,control=backend._worker.execute(lambda e:(list(e.profile_rows),list(control_rows)),lambda:False,900)
   for k in ['generated_ids','response','token_logprobs','terminal','stopped_at_token_limit','generation_mode','neural_cpu_fallback','limits','bpu_calls','model_loads']:assert answer[k]==gold[k],(index,k)
   sem=lambda a:[{k:v for k,v in x.items() if k!='seconds'} for x in a['steps']];assert sem(answer)==sem(gold);assert len(rows)==answer['bpu_calls']==answer['executor_stats']['calls'] and answer['model_loads']==answer['executor_stats']['loads']==answer['executor_stats']['evictions']==0 and answer['models_retained_for_next_request'] and not answer['generation_state_retained'] and not answer['image_features_retained'];assert sum(x['kind']=='original_token_selection_control' for x in control)==len(answer['steps'])
   r['cases'].append(dict(run=run,index=index,warmup=run==0,complete_output_semantics_identical=True,wall_seconds=wall,program_rows=rows,control_rows=control,answer=answer));r['total_neural_calls']+=answer['bpu_calls'];save(OUT/'status.json',r)
  assert len(r['cases'])==11;r.update(status='completed_current_family_runtime_phase_profile',timed_request_count=10,same_generated_tokens_all11=True,latency_is_instrumented_not_speedup_benchmark=True)
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  if backend is not None:backend.close();backend=None;gc.collect();r['all_models_released']=True
  r['finished']=time.time();save(OUT/'status.json',r);save(OUT/'phase.json',dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),stage='released'))

def guard(check):
 assert os.getuid()==0;admit()
 if check:print(json.dumps(dict(status='admitted_current_family_runtime_phase_profile_zero_nn_calls',selected_indices=[0,1,5,79,159],requests=11)));return
 assert not OUT.exists() and not REPORT.exists();sys.path.insert(0,str(CODE));assert sha(CODE/'locateanything_process_memory_v4.py')=='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
 from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap,IncompleteProcessSnapshot
 lease=(ROOT/'data/ai/runtime-validation.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB);key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key']
 def get(url,auth=False):
  with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {}),timeout=5) as res:return json.load(res)
 def state():return get('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097',True)
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');s=next(x for x in get('http://127.0.0.1:1985/api/v1/streams')['streams'] if x['app']=='live' and x['name']=='xm');return dict(recorder={k:h.get(k) for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},frames=s['frames'],recv_bytes=s['recv_bytes'],active=s['publish']['active'])
 def active(n):return subprocess.run(['systemctl','is-active',n],capture_output=True,text=True,timeout=8).stdout.strip()
 def unit(action,n):subprocess.run(['systemctl',action,n],check=True,timeout=45)
 services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest'];r=dict(status='admitted',scope=__doc__,source_sha256=sha(__file__),started=time.time(),source_recording_stopped=False,production_model_changed=False,release_approved=False,memory_samples=0,incomplete_memory_samples=0,conservative_worker_memory_maximum=0);child=None;start=None;tids=set();restore=[]
 def interrupted(*_):raise RuntimeError('Owned full-program profile interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  assert all(active(n)=='active' for n in services);r['before']=state();r['media_before']=media();r['protected_before']={str(p):sha(p) for p in [ROOT/'data/ai/config_overlay.json',ROOT/'deploy/s100p/bin/ainvr_ai_service',BACKEND]};r['units_before']={n:int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True)) for n in services};assert r['before']['state']=='running' and r['before']['stats']['consecutive_errors']==0 and r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy'] and r['media_before']['active']
  restore=['ainvr-locateanything-official-bpu','ainvr-ai'];save(REPORT,r);unit('stop','ainvr-ai');unit('stop','ainvr-locateanything-official-bpu');assert all(active(n)=='inactive' for n in restore);OUT.mkdir(mode=0o750);os.chown(OUT,1000,1000)
  with (OUT/'worker.log').open('xb') as log:child=subprocess.Popen(['runuser','-u','sunrise','--',str(PYTHON),str(Path(__file__).resolve()),'--worker'],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),start_new_session=True)
  start=ticks(child.pid);r.update(status='running11_frozen_requests_runtime_phases',child_pid=child.pid,child_start_ticks=start);save(REPORT,r);next_save=time.monotonic()+2
  while child.poll() is None:
   p=OUT/'phase.json'
   if p.exists():
    phase=read(p)
    try:
     s=sample_owned_process(phase['pid'],phase['start_ticks'],child.pid,str(Path(__file__).resolve()));tids.update(map(int,s['owned_task_start_ticks']));value=s['rss_bytes']+sum(s['owned_heap_bytes'].values());assert value<8_000_000_000;r['memory_samples']+=1;r['conservative_worker_memory_maximum']=max(r['conservative_worker_memory_maximum'],value)
    except (FileNotFoundError,ProcessLookupError,IncompleteProcessSnapshot):r['incomplete_memory_samples']+=1
   assert int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024>2*1024**3
   if time.monotonic()>=next_save:
    m=media();assert m['recorder']['ok'] and m['recorder']['storageHealthy'] and m['recorder']['writeDegradedChannels']==0 and m['active'];r['media_latest']=m;save(REPORT,r);next_save=time.monotonic()+2
   time.sleep(.2)
  proof=read(OUT/'status.json');r.update(worker_returncode=child.returncode,proof=proof,raw_sha256=sha(OUT/'status.json'));assert child.returncode==0 and proof['status']=='completed_current_family_runtime_phase_profile' and len(proof['cases'])==11 and proof['same_generated_tokens_all11'] and proof['all_models_released'];r['status']='profile_completed_waiting_restore';save(REPORT,r)
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  try:
   if child is not None and child.poll() is None:
    assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=15)
    except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
   heaps={}
   for name in ['cma_reserved','carveout','ion_cma']:
    p=Path('/sys/kernel/debug/ion/heaps')/name
    if p.exists():heaps[name]=sum(parse_owned_tasks_heap(p.read_text(),name,tids).values())
   assert tids and r['memory_samples'] and not any(heaps.values());r['owned_ion_after_exit']=heaps
  except BaseException:r.update(status='failed',cleanup_error=traceback.format_exc())
  r['restore_errors']=[]
  for n in restore:
   try:unit('start',n)
   except BaseException:r['restore_errors'].append(dict(unit=n,error=traceback.format_exc()))
  try:
   assert not r['restore_errors'] and all(active(n)=='active' for n in services);deadline=time.monotonic()+190
   while True:
    try:s=state()
    except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.5);continue
    m=media();pub=s['stats'].get('publish',{});assert m['recorder']['ok'] and m['recorder']['storageHealthy'] and m['active']
    if s['state']=='running' and s['stats']['consecutive_errors']==0 and s['stats']['inference_count']>0 and pub.get('sei_injected',0)>0 and pub.get('au_pushed',0)>0:break
    assert time.monotonic()<deadline;time.sleep(.5)
   assert s['config']==r['before']['config'] and all(sha(p)==pin for p,pin in r['protected_before'].items()) and m['frames']>r['media_before']['frames'] and m['recv_bytes']>r['media_before']['recv_bytes'] and m['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'] and m['recorder']['writeDegradedChannels']==0;assert all(int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True))==r['units_before'][n] for n in ['ainvr-recorder','ainvr-ingest']);r.update(after=s,media_after=m,original_current_configuration_and_real_SEI_restored=True)
   if r['status']=='profile_completed_waiting_restore':r['status']='completed_runtime_phase_profile_and_current_production_restored'
  except BaseException:r.update(status='failed',restore_postcheck_error=traceback.format_exc())
  r['finished']=time.time();save(REPORT,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','raw_sha256','original_current_configuration_and_real_SEI_restored','error','cleanup_error','restore_postcheck_error']}));assert r['status']=='completed_runtime_phase_profile_and_current_production_restored'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.worker:worker()
 else:guard(a.check_only)
