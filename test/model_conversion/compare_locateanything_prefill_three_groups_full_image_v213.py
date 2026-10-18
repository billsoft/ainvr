"""Controlled full-model prepared-image prefillO2 A/B,after actual current-v8/all160 equivalence.

Share45unchanged physical contexts and retain both third-group alternatives on
one SDK owner thread (47testcontexts,not production46). Two global warmups then
two counterbalanced pairs per fixed index0,1,5,79,159:22requests/10timedpairs.
Primary screen:median absolute saving>=50ms and no case median slowdown>2%.
All generated tokens/logprobs/termination must equal the original current W8.
"""
from pathlib import Path
import argparse,re,fcntl,gc,hashlib,json,os,signal,statistics,subprocess,sys,time,traceback,urllib.request,threading
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');OUT=BASE/'full-image-prefill-g0-g9-g18-A-B-v213';REPORT=ROOT/'test/results/locateanything-prefill-three-groups-full-image-A-B-v213-guard.json';PYTHON=RUNTIME/'.venv-locateanything/bin/python';BASE_CONTRACT=BASE/'official-full-family-w8a16-prefill-g0-g9-v169.json';CANDIDATE=BASE/'official-full-family-w8a16-prefill-g0-g9-g18-v204.json'
CANDIDATE_SHA=REGRESSION_SHA=GUARD_SHA=None

BACKEND=RUNTIME/'locateanything_bpu_prefill_groups_executor_v8.py'

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name('.'+p.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
SEMANTIC_FIELDS=['generated_ids','response','token_logprobs','terminal','stopped_at_token_limit','generation_mode','neural_cpu_fallback','limits','bpu_calls','model_loads']


def require_full160(raw, guard, baseline, candidate_sha, raw_sha):
 assert raw['status']=='completed_all160_runtime_regression' and raw['all160_operations_executed'] is True
 assert raw['runtime_equivalence_passed'] is True and raw['summary_exactly_equal_baseline'] is True
 assert raw['contract_sha256']==candidate_sha and raw['baseline_bpu_sha256']=='8a9e35dfe7203c9e982b0edee8546e907bb0e988d137d2f13b18e839d5ca1b13'
 assert raw['source_sha256']=='61682a5cca043ec937882f330deb516ee5afaf19865f8510de1c2ad89660b90e'
 assert raw['reference_index_sha256']=='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253'
 assert len(raw['cases'])==len(baseline['cases'])==160 and [c['index'] for c in raw['cases']]==list(range(160))
 assert raw['summary']==baseline['summary'] and raw['retained_failed_indices']==[117] and raw['mismatch_indices']==[]
 calls=0
 for current, old in zip(raw['cases'],baseline['cases']):
  assert current['rpc_ok'] is True and current['runtime_equivalent'] is True and current['different_fields']==[]
  assert all(current[k]==old[k] for k in ['index','image_id','query','kind','reference','reference_eligible','reference_terminal','candidate','terminal','neural_cpu_fallback'])
  a,b=current['answer'],old['answer']
  assert all(a[k]==b[k] for k in SEMANTIC_FIELDS)
  assert [{k:v for k,v in step.items() if k!='seconds'} for step in a['steps']]==[{k:v for k,v in step.items() if k!='seconds'} for step in b['steps']]
  assert a['neural_cpu_fallback'] is False and a['model_loads']==0
  calls+=a['bpu_calls']
 assert calls==raw['neural_calls']==25794 and [c['index'] for c in raw['cases'] if not c['terminal']]==[117]
 assert guard['status']=='completed_all160_runtime_equivalence_not_installed'
 assert guard['raw_sha256']==raw_sha and guard['client_sha256']==raw['source_sha256']
 assert guard['backend_sha256']=='a5f903f4674a2d0af973b8c36bce591ce279ccdb273b1dc702e67c2474b7487e'
 assert guard['runtime_equivalence_passed'] is True and guard['neural_calls']==calls and guard['retained_failed_indices']==[117]
 assert guard['source_recording_stopped'] is False and guard['production_candidate_installed'] is False
 assert guard['original_backend_user_config_and_sei_output_restored'] is True and guard['restore_errors']==[]
 assert guard['config_after']==guard['config_before'] and guard['binary_after']==guard['binary_before']
 assert guard['memory_sample_count']>0 and 0<guard['conservative_experiment_memory_bytes_maximum']<=10_400_000_000
 assert guard['owned_ion_after_exit'] and not any(guard['owned_ion_after_exit'].values())
 assert guard['media_after']['original_unit_processes']==guard['media_before']['original_unit_processes']
 assert not any(k in guard for k in ['error','cleanup_error','restore_postcheck_error'])


def qualify_full160(baseline):
 raw_path=BASE/'prefill-g0-g9-g18-frozen160-v205/status.json'
 guard_path=ROOT/'test/results/locateanything-prefill-three-groups-full160-guard-v205.json'
 assert sha(raw_path)==REGRESSION_SHA and sha(guard_path)==GUARD_SHA
 guard=read(guard_path)
 assert guard['source_sha256']==sha(CODE/'guard_locateanything_prefill_groups_v205.py')=='e382d248704e0b467563515f5e4d23037be3e94da6deb1149e998069d88799ef'
 require_full160(read(raw_path),guard,baseline,CANDIDATE_SHA,REGRESSION_SHA)


def admit():
 assert sha(BACKEND)=='99feed9f59c5d8496b0ec3e1403751cfc9c40b6ffc050340b944f143fa266cbb'
 assert sha(CODE/'regress_locateanything_prefill_groups_v205.py')=='61682a5cca043ec937882f330deb516ee5afaf19865f8510de1c2ad89660b90e';sys.path.insert(0,str(CODE));sys.path.insert(0,str(RUNTIME))
 import regress_locateanything_prefill_groups_v205 as frozen
 frozen.CONTRACT_SHA=CANDIDATE_SHA
 reference,baseline,_,_=frozen.admission()
 qualify_full160(baseline)
 from locateanything_official_prefill_groups_v169 import load_official_generator as load_base
 from locateanything_official_prefill_groups_v204 import load_official_generator as load_candidate
 a,_=load_base(BASE_CONTRACT,'ddf40b566faa841b3ff3aa658d7beb31b44576f7895db93adb3476b41fe6d101');b,_=load_candidate(CANDIDATE,CANDIDATE_SHA)
 sa={x.key:x for x in a.specs};sb={x.key:x for x in b.specs};changed={k for k in sa if sa[k]!=sb[k]};assert changed=={'decoder-group-18-26-ar','decoder-group-18-26-prefill'} and len(sa)==len(sb)==76;assert len({str(x.path.resolve()) for x in list(sa.values())+list(sb.values())})==47
 for k in set(sa)-changed:assert sa[k]==sb[k]
 return reference,baseline,a,b,changed
def worker():
 assert os.getuid()==1000 and OUT.is_dir() and not (OUT/'status.json').exists();reference,baseline,ga,gb,changed=admit();import numpy as np
 assert sha(CODE/'locateanything_official_program_executor_reused_io_v1.py')=='f3e4770da36a491e6b5065646a798f285bdd593617ba89e7d14ccdb101121f37'
 from locateanything_official_program_executor_reused_io_v1 import ReusedIOProgramExecutor
 from locateanything_prompt import LocateAnythingPrompt
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json','f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40')
 r=dict(status='running_controlled_full_model_A_B',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),scope=__doc__,cases=[],pairs=[],all_selected_outputs_identical=True,all_models_released=False,test_physical_contexts=47,production_physical_contexts=46,shared_unchanged_contexts=45,production_installed=False,release_approved=False,neural_calls=0)
 engines={}
 def phase(s):save(OUT/'phase.json',dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),stage=s))
 class Joint:
  def __init__(self):self.mode='baseline';self.specs=dict(engines['baseline'].specs);self.specs.update(engines['candidate_group'].specs);self.owner=threading.get_ident()
  @property
  def stats(self):return {k:sum(e.stats[k] for e in engines.values()) for k in ['calls','loads','evictions','load_ms','inference_ms']}
  def run_ordered(self,key,values):
   assert threading.get_ident()==self.owner
   engine=engines['candidate_group'] if self.mode=='candidate' and key in changed else engines['baseline'];return engine.run_ordered(key,values)
 try:
  phase('preload47_diagnostic_contexts');engines['baseline']=ReusedIOProgramExecutor(ga.specs,budget_bytes=7*1024**3,minimum_available_bytes=2*1024**3,maximum_models=46,experimental_residency=True);engines['baseline'].preload_all();extras=[x for x in gb.specs if x.key in changed];engines['candidate_group']=ReusedIOProgramExecutor(extras,budget_bytes=2*1024**3,minimum_available_bytes=2*1024**3,maximum_models=1);engines['candidate_group'].preload_all();assert sum(len(e.loaded) for e in engines.values())==47;executor=Joint()
  def run(mode,index,warmup,pair=None):
   native=reference['cases'][index];gold=baseline['cases'][index]['answer'];pixels=np.load(BASE/'independent-final-native-reference-v2-head-o2'/native['pixels'],allow_pickle=False);ids=np.load(BASE/'independent-final-native-reference-v2-head-o2'/native['ids'],allow_pickle=False);assert np.array_equal(prompt.encode(native['query'],256,'slow'),ids);executor.mode=mode;gen=ga if mode=='baseline' else gb;before=executor.stats;phase(f'{mode}-index{index}-pair{pair}');begin=time.perf_counter();answer=gen.generate(executor,pixels,np.asarray([[16,32]],np.int64),ids,mode='slow',max_new_tokens=256,model_max_length=512,temperature=0.,maximum_seconds=900,cancelled=lambda:False);elapsed=time.perf_counter()-begin;answer['generated_ids']=answer['generated_ids'].tolist();answer['response']=prompt.decode(answer['generated_ids'])
   for k in ['generated_ids','response','token_logprobs','terminal','stopped_at_token_limit','generation_mode','neural_cpu_fallback','limits','bpu_calls','model_loads']:assert answer[k]==gold[k],(mode,index,k)
   sem=lambda a:[{k:v for k,v in x.items() if k!='seconds'} for x in a['steps']];assert sem(answer)==sem(gold) and executor.stats['calls']-before['calls']==answer['bpu_calls'] and executor.stats['loads']==before['loads'] and executor.stats['evictions']==0
   item=dict(mode=mode,index=index,pair=pair,warmup=warmup,seconds=elapsed,complete_output_identical=True,answer=answer);r['cases'].append(item);r['neural_calls']+=answer['bpu_calls'];return item
  run('baseline',1,True);run('candidate',1,True);save(OUT/'status.json',r)
  for repeat in range(2):
   for position,index in enumerate([0,1,5,79,159]):
    order=['baseline','candidate'] if (repeat+position)%2==0 else ['candidate','baseline'];items={mode:run(mode,index,False,repeat) for mode in order};a=items['baseline']['seconds'];b=items['candidate']['seconds'];r['pairs'].append(dict(index=index,repeat=repeat,order=order,baseline_seconds=a,candidate_seconds=b,saved_ms=(a-b)*1000,ratio=a/b));save(OUT/'status.json',r)
  assert len(r['cases'])==22 and len(r['pairs'])==10;percase=[]
  for index in [0,1,5,79,159]:
   rows=[p for p in r['pairs'] if p['index']==index];percase.append(dict(index=index,baseline_median_seconds=statistics.median(x['baseline_seconds'] for x in rows),candidate_median_seconds=statistics.median(x['candidate_seconds'] for x in rows),median_saved_ms=statistics.median(x['saved_ms'] for x in rows)))
  median=statistics.median(p['saved_ms'] for p in r['pairs']);r.update(status='completed_controlled_full_image_prefill_A_B',median_absolute_saved_ms=median,per_case=percase,full_image_speed_screen_passed=median>=50 and all(x['candidate_median_seconds']<=x['baseline_median_seconds']*1.02 for x in percase),same_generated_tokens_all_runs=True,scope_limit='Prepared-image5frozen cases with22requests,47diagnostic contexts;not a4K live-stream end-to-end claim or production memory measurement')
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  for e in engines.values():e.close()
  engines.clear();gc.collect();r.update(all_models_released=True,finished=time.time());save(OUT/'status.json',r);phase('released')

def guard(check):
 assert os.getuid()==0;admit()
 if check:print(json.dumps(dict(status='admitted_prefill_full_image_AB_zero_nn_calls',selected_indices=[0,1,5,79,159],requests=22)));return
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
 services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest'];r=dict(status='admitted',scope=__doc__,source_sha256=sha(__file__),started=time.time(),source_recording_stopped=False,production_model_changed=False,release_approved=False,candidate_contract_sha256=CANDIDATE_SHA,full160_raw_sha256=REGRESSION_SHA,full160_guard_sha256=GUARD_SHA,memory_samples=0,incomplete_memory_samples=0,conservative_worker_memory_maximum=0);child=None;start=None;tids=set();restore=[]
 def interrupted(*_):raise RuntimeError('Owned full-image A/B interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  assert all(active(n)=='active' for n in services);r['before']=state();r['media_before']=media();r['protected_before']={str(p):sha(p) for p in [ROOT/'data/ai/config_overlay.json',ROOT/'deploy/s100p/bin/ainvr_ai_service',BACKEND,BASE_CONTRACT]};r['units_before']={n:int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True)) for n in services};assert r['before']['state']=='running' and r['before']['stats']['consecutive_errors']==0 and r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy'] and r['media_before']['active']
  restore=['ainvr-locateanything-official-bpu','ainvr-ai'];save(REPORT,r);unit('stop','ainvr-ai');unit('stop','ainvr-locateanything-official-bpu');assert all(active(n)=='inactive' for n in restore);OUT.mkdir(mode=0o750);os.chown(OUT,1000,1000)
  with (OUT/'worker.log').open('xb') as log:child=subprocess.Popen(['runuser','-u','sunrise','--',str(PYTHON),str(Path(__file__).resolve()),'--worker','--contract-sha',CANDIDATE_SHA,'--regression-sha',REGRESSION_SHA,'--guard-sha',GUARD_SHA],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),start_new_session=True)
  start=ticks(child.pid);r.update(status='running22_controlled_full_image_requests',child_pid=child.pid,child_start_ticks=start);save(REPORT,r);next_save=time.monotonic()+2
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
  proof=read(OUT/'status.json');r.update(worker_returncode=child.returncode,proof=proof,raw_sha256=sha(OUT/'status.json'));assert child.returncode==0 and proof['status']=='completed_controlled_full_image_prefill_A_B' and len(proof['cases'])==22 and len(proof['pairs'])==10 and proof['same_generated_tokens_all_runs'] and proof['all_models_released'];r['status']='AB_completed_waiting_restore';save(REPORT,r)
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
   if r['status']=='AB_completed_waiting_restore':r['status']='completed_full_image_AB_and_original_production_restored'
  except BaseException:r.update(status='failed',restore_postcheck_error=traceback.format_exc())
  r['finished']=time.time();save(REPORT,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','raw_sha256','original_current_configuration_and_real_SEI_restored','error','cleanup_error','restore_postcheck_error']}));assert r['status']=='completed_full_image_AB_and_original_production_restored'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--contract-sha',required=True);p.add_argument('--regression-sha',required=True);p.add_argument('--guard-sha',required=True);p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 assert all(re.fullmatch('[0-9a-f]{64}',v) for v in [a.contract_sha,a.regression_sha,a.guard_sha]);CANDIDATE_SHA=a.contract_sha;REGRESSION_SHA=a.regression_sha;GUARD_SHA=a.guard_sha
 if a.worker:worker()
 else:guard(a.check_only)
