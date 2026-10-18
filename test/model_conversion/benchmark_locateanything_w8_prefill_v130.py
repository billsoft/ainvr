"""Same-BC historical prefillO2 versus installed prefillO0;AR HBO unchanged.

192 fixed-input BPU calls,3648 byte-exact arrays,64timed counterbalanced pairs.
Component measurements do not approve a complete-model speed/quality change.
AI-only guard body derives from the pinned v124 harness;recording stays live.
"""
from pathlib import Path
import argparse,fcntl,gc,hashlib,json,os,signal,statistics,subprocess,sys,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');ORIGIN=BASE/'official-qwen-group-0-8-w8a16-ar2-pref0-v1-board-package';PACKAGE=BASE/'official-w8-prefill-o2-v130-board-package';OUT=BASE/'official-w8-prefill-o2-v130-benchmark';REPORT=ROOT/'test/results/locateanything-w8-prefill-o2-v130-board-guard.json';PYTHON=ROOT/'ai-service/runtime/.venv-locateanything/bin/python'
BASE_MANIFEST_SHA='4a23c4b34a9d25e1d702f731e6ec787f1ae5a265d48e9dfbca1ddee17bebf1f7';COMPILER_SHA='e3ed149369d804c110271b1b71ecbbe879498595084d7010c69c65a30bca3702'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def write(p,r):
 t=p.with_name('.'+p.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def admit(pin):
 assert sha(PACKAGE/'manifest.json')==pin and sha(ORIGIN/'manifest.json')==BASE_MANIFEST_SHA and not PACKAGE.is_symlink()
 m=read(PACKAGE/'manifest.json');old=read(ORIGIN/'manifest.json');assert m['schema']=='locateanything_same_bc_w8_prefill_board_v1' and m['baseline_manifest_sha256']==BASE_MANIFEST_SHA and m['baseline_package']==ORIGIN.name and m['compiler_source_sha256']==COMPILER_SHA and m['first']==0 and m['last']==8 and not m['release_approved'] and not m['whole_model_verified']
 assert m['baseline_profile_optimization']=={'1':2,'256':0} and m['candidate_profile_optimization']=={'1':2,'256':2};assert set(m['files'])=={'model.hbm','disas.json','source-status.json','baseline-status.json','same-bc-provenance.json','ports.json'}
 for name,v in m['files'].items():
  p=PACKAGE/name;assert p.resolve().is_relative_to(PACKAGE) and not p.is_symlink() and p.stat().st_size==v['bytes'] and sha(p)==v['sha256']
 a=read(PACKAGE/'source-status.json');b=read(PACKAGE/'baseline-status.json');assert sha(PACKAGE/'source-status.json')==m['source_status_sha256']=='54ae6c107703bec5a80781f8d442926e638ab710b79bb4c205774f080c75851c';assert sha(PACKAGE/'baseline-status.json')==m['baseline_status_sha256']=='8660122afa575b7eef04ee20770f8bb9623785c12fafa19849584f4e1522b61f' and b==old['source_status']
 assert a['status']==b['status']=='compiled_original_group_shared_profiles_bpu_only' and a['finished'] and a['source_sha256']==COMPILER_SHA and a['optimization']==2 and a['compile_jobs']==1 and a['bpu_only'] and not a['recalibration_executed'] and not a['weights_or_graph_changed'] and not a['neural_cpu_or_gpu_production_fallback']
 for k in ['origin_status_sha256','origin_hbm_sha256','first','last','layer_count','weight_bits','attention_activation_bits','calibration','original_parameter_hashes','original_model_code_sha256','calibration_source_status_sha256','calibration_provenance','ranges','range_hash','cache_input_layout','high_precision_qpp','original_norm_epsilon_preserved','quantized_io_removed']:assert a[k]==b[k],k
 assert sha(PACKAGE/'model.hbm')==a['hbm_sha256']==m['candidate_hbm_sha256']=='4005bf1615063153d1ad0a18706090791fde0116451b3a4173fc3a220adaca94' and sha(ORIGIN/'official-q8/model.hbm')==b['hbm_sha256']==m['baseline_hbm_sha256']=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399'
 profiles=read(PACKAGE/'ports.json');assert profiles==old['profiles'];provenance=read(PACKAGE/'same-bc-provenance.json');assert provenance['same_AR_hbo'] and provenance['same_quantization_and_original_parameters']
 for seq in [1,256]:
  pa=next(x for x in a['profiles'] if x['sequence_capacity']==seq);pb=next(x for x in b['profiles'] if x['sequence_capacity']==seq);v=provenance['components'][str(seq)]
  assert pa['converted_bc_sha256']==pb['converted_bc_sha256']==v['converted_bc_sha256'] and pa['ports_sha256']==pb['ports_sha256']==v['ports_sha256'] and pa['regression']==pb['regression'] and len(pa['regression'])==4 and pa['hbo_sha256']==v['hbo_sha256']
  if seq==1:assert pa['hbo_sha256']==pb['hbo_sha256']=='589141b70bc36fd24887c84dc6a16310bfbdb93cb588e5b5c1f86f6e9115fec8'
  else:assert pa['converted_bc_sha256']=='4b49df57829d582dcb61712f365087218e59cc49192e4cb75f30c5d2974e4b2d' and pa['hbo_sha256']=='3dd4c2895738964a501e0342d38cfabb287e4dbf16eaff070209bbc66258d780'
  for case in range(4):
   for stem,count in [('input',22),('compiler',19)]:
    for i in range(count):
     name=f's{seq}/case-{case:02d}/{stem}-{i:02d}.npy';p=ORIGIN/name;assert p.stat().st_size==old['files'][name]['bytes'] and sha(p)==old['files'][name]['sha256']==provenance['fixture_sha256'][name]
 disas=read(PACKAGE/'disas.json');assert len(disas['graphs'])==2 and {g['name'] for g in disas['graphs']}=={p['name'] for p in profiles} and all(n['device']=='DEVICE_CATEGORY_BPU' for g in disas['graphs'] for n in g['nodes'])
 return m,profiles
def worker(pin):
 assert os.getuid()==1000 and OUT.is_dir() and not (OUT/'status.json').exists();m,profiles=admit(pin);sys.path.insert(0,str(CODE));import numpy as np
 assert sha(CODE/'locateanything_reused_io_adapter_v1.py')=='6e2d838bc8821c330d5660363acb76b07d9c26a08ebe832d30526addfadf0885';from locateanything_reused_io_adapter_v1 import runtime_api
 r=dict(status='running',started=time.time(),source_sha256=sha(__file__),manifest_sha256=pin,pid=os.getpid(),start_ticks=ticks(os.getpid()),calls=0,comparisons=0,all_outputs_compiler_byte_exact=True,runs=[],all_models_released=False,scope=__doc__,primary_metric='Prefill median paired baseline/candidate run+hostcopy ratio>=1.03,eachprefillcase>=.99;unchangedAR overall>=.98;8timedpairs/case after4warmups',whole_model_verified=False,release_approved=False)
 runtimes={}
 def phase(s):write(OUT/'phase.json',dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),stage=s))
 try:
  phase('load_both')
  for name,path in [('baseline',ORIGIN/'official-q8/model.hbm'),('candidate',PACKAGE/'model.hbm')]:
   rt=runtime_api.HB_HBMRuntime(str(path));rt.set_scheduling_params(bpu_cores={n:[0] for n in rt.model_names});assert set(rt.model_names)=={p['name'] for p in profiles};runtimes[name]=rt
  for profile in profiles:
   seq=profile['sequence']
   for case in range(4):
    d=ORIGIN/f's{seq}/case-{case:02d}';feed={p['name']:np.load(d/f'input-{i:02d}.npy',allow_pickle=False) for i,p in enumerate(profile['inputs'])};gold=[np.load(d/f'compiler-{i:02d}.npy',allow_pickle=False) for i in range(19)];assert all(np.isfinite(x).all() for x in list(feed.values())+gold)
    for repeat in range(12):
     phase(f's{seq}-case{case}-repeat{repeat}');times={};order=['baseline','candidate'] if (case+repeat)%2==0 else ['candidate','baseline']
     for mode in order:
      before=time.perf_counter();answer=runtimes[mode].run({profile['name']:feed})[profile['name']];elapsed=(time.perf_counter()-before)*1000;r['calls']+=1;times[mode]=elapsed
      for p,expected in zip(profile['outputs'],gold):
       actual=answer[p['name']];assert actual.dtype==expected.dtype and actual.shape==expected.shape and actual.tobytes()==expected.tobytes(),'Same BC prefill optimization changed compiler reference output';r['comparisons']+=1
     r['runs'].append(dict(sequence=seq,case=case,repeat=repeat,warmup=repeat<4,order=order,timing_ms=times,paired_ratio=times['baseline']/times['candidate']));write(OUT/'status.json',r)
  assert r['calls']==192 and r['comparisons']==3648;byprofile={}
  for seq in [1,256]:
   rows=[x for x in r['runs'] if x['sequence']==seq and not x['warmup']];cases=[]
   for c in range(4):
    subset=[x for x in rows if x['case']==c];cases.append(dict(case=c,median_paired_ratio=statistics.median(x['paired_ratio'] for x in subset),baseline_median_ms=statistics.median(x['timing_ms']['baseline'] for x in subset),candidate_median_ms=statistics.median(x['timing_ms']['candidate'] for x in subset)))
   byprofile[str(seq)]=dict(timed_pairs=len(rows),median_paired_ratio=statistics.median(x['paired_ratio'] for x in rows),cases=cases)
  eligible=byprofile['256']['median_paired_ratio']>=1.03 and all(c['median_paired_ratio']>=.99 for c in byprofile['256']['cases']) and byprofile['1']['median_paired_ratio']>=.98
  r.update(status='completed_same_bc_component_measurement_not_fullmodel_approval',profile_timings=byprofile,component_speed_screen_passed=eligible,native_stats={name:rt.reuse_stats for name,rt in runtimes.items()})
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  for rt in runtimes.values():rt.close()
  runtimes.clear();gc.collect();r.update(all_models_released=True,finished=time.time());write(OUT/'status.json',r);phase('released')

# Guard source provenance:immutable v124 SHA611997c2...,only call/comparison totals changed.
def guard(pin,check):
 assert os.getuid()==0;m,profile=admit(pin)
 if check:print(json.dumps(dict(status='admitted_same_bc_candidate_zero_nn_calls',manifest_sha256=pin)));return
 assert not OUT.exists() and not REPORT.exists();sys.path.insert(0,str(CODE));assert sha(CODE/'locateanything_process_memory_v4.py')=='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
 from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap,IncompleteProcessSnapshot
 lease=(ROOT/'data/ai/runtime-validation.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB);key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key'];url='http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097'
 def get(path,auth=False):
  with urllib.request.urlopen(urllib.request.Request(path,headers={'X-Api-Key':key} if auth else {}),timeout=5) as res:return json.load(res)
 def state():return get(url,True)
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');s=next(x for x in get('http://127.0.0.1:1985/api/v1/streams')['streams'] if x['app']=='live' and x['name']=='xm');return dict(recorder={k:h.get(k) for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},frames=s['frames'],recv_bytes=s['recv_bytes'],publish_active=s['publish']['active'])
 def active(n):return subprocess.run(['systemctl','is-active',n],capture_output=True,text=True,timeout=8).stdout.strip()
 def unit(action,n):subprocess.run(['systemctl',action,n],check=True,timeout=45)
 services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest'];r=dict(status='checking',started=time.time(),source_sha256=sha(__file__),manifest_sha256=pin,scope=__doc__,source_recording_stopped=False,release_approved=False,memory_samples=0,incomplete_memory_samples=0,conservative_owned_memory_maximum=0);child=None;start=None;restore=[];tids=set()
 def stop(*_):raise RuntimeError('Owned component guard interrupted')
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
 try:
  assert all(active(n)=='active' for n in services);r['before']=state();r['media_before']=media();r['protected_before']={n:sha(ROOT/n) for n in ['data/ai/config_overlay.json','deploy/s100p/bin/ainvr_ai_service']};assert r['before']['state']=='running' and r['before']['stats']['consecutive_errors']==0 and r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy']
  r['units_before']={n:int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True)) for n in services};restore=['ainvr-locateanything-official-bpu','ainvr-ai'];write(REPORT,r);unit('stop','ainvr-ai');unit('stop','ainvr-locateanything-official-bpu');assert all(active(n)=='inactive' for n in restore)
  OUT.mkdir(mode=0o750);os.chown(OUT,1000,1000);env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib');env.pop('_HB_UCP_PROFILER_LOG_PATH_',None)
  with (OUT/'worker.log').open('xb') as log:child=subprocess.Popen(['runuser','-u','sunrise','--',str(PYTHON),str(Path(__file__).resolve()),'--worker','--manifest-sha',pin],stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True,env=env)
  start=ticks(child.pid);r.update(status='running192_same_inputs_counterbalanced',child_pid=child.pid,child_start_ticks=start);write(REPORT,r);frequencies=set()
  while child.poll() is None:
   phase=OUT/'phase.json'
   if phase.exists():
    v=read(phase)
    try:
     sample=sample_owned_process(v['pid'],v['start_ticks'],child.pid,str(Path(__file__).resolve()));tids.update(map(int,sample['owned_task_start_ticks']));memory=sample['rss_bytes']+sum(sample['owned_heap_bytes'].values());assert memory<4_000_000_000;r['conservative_owned_memory_maximum']=max(r['conservative_owned_memory_maximum'],memory);r['memory_samples']+=1
    except (FileNotFoundError,ProcessLookupError,IncompleteProcessSnapshot):r['incomplete_memory_samples']+=1
   assert int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024>2*1024**3;frequencies.add(int(Path('/sys/devices/system/bpu/bpu0/devfreq/28108000.bpu/cur_freq').read_text()));time.sleep(.1)
  proof=read(OUT/'status.json');assert child.returncode==0 and proof['status']=='completed_same_bc_component_measurement_not_fullmodel_approval' and proof['calls']==192 and proof['comparisons']==3648 and proof['all_models_released'];r.update(status='completed_component_measurement_waiting_restore',proof=proof,hardware_report_sha256=sha(OUT/'status.json'),frequencies=sorted(frequencies));write(REPORT,r)
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
    m=media();assert m['recorder']['ok'] and m['recorder']['storageHealthy'] and m['publish_active'];pub=s['stats'].get('publish',{})
    if s['state']=='running' and s['stats']['consecutive_errors']==0 and s['stats']['inference_count']>0 and pub.get('sei_injected',0)>0 and pub.get('au_pushed',0)>0:break
    assert time.monotonic()<deadline;time.sleep(.5)
   assert s['config']==r['before']['config'] and all(sha(ROOT/n)==pin for n,pin in r['protected_before'].items());assert m['frames']>r['media_before']['frames'] and m['recv_bytes']>r['media_before']['recv_bytes'] and m['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'];assert all(int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True))==r['units_before'][n] for n in ['ainvr-recorder','ainvr-ingest']);r.update(after=s,media_after=m,original_current_user_configuration_and_real_SEI_restored=True)
   if r['status']=='completed_component_measurement_waiting_restore':r['status']='completed_component_parity_and_timing_not_fullmodel_admission'
  except BaseException:r.update(status='failed',restore_postcheck_error=traceback.format_exc())
  r['finished']=time.time();write(REPORT,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','hardware_report_sha256','original_current_user_configuration_and_real_SEI_restored','error','cleanup_error','restore_postcheck_error']}));assert r['status']=='completed_component_parity_and_timing_not_fullmodel_admission'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--manifest-sha',required=True);p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.worker:worker(a.manifest_sha)
 else:guard(a.manifest_sha,a.check_only)
