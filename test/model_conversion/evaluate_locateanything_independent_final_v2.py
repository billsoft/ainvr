"""Frozen all160 final operations via actual complete persistent BPU backend.

Bind all four actually board-qualified AR2/pref0 artifacts before generation.
No partial/subset mode,case replacement,threshold tuning,production install,
recording stop,neural fallback or overall elapsed experiment cap.
"""
from pathlib import Path
import argparse,ast,hashlib,json,os,re,signal,socket,struct,subprocess,sys,time,traceback
import numpy as np
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
REF=BASE/'independent-final-native-reference-v2-head-o2';OUT=BASE/'independent-final-bpu-ar2-pref0-head2-trial-v2';BINDING=BASE/'independent-final-ar2-pref0-head2-trial-v2-artifact-binding.json'
BACKEND=RUNTIME/'locateanything_bpu_official_executor_v5.py';BACKEND_SHA='0ed693df99b3597d927bc0224b8ce02fb22f5b41c49853b651b08a3c743a360d'
REF_SHA=None;FREEZE_SHA='36a738d86f0a2f082d877544f14399f725b52fe585d1f87f79b7769cd1e1d2fb';TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40';SCORE_SHA='69e88a0202aad9ee9ec45150607c885d44810cba2970c26dcd9be1cdaafc0093';SAMPLE_SHA='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
PYTHON=RUNTIME/'.venv-locateanything/bin/python';SOCKET=ROOT/'data/ai/locate-final-ar2-pref0-head2-v2.sock';REPORT=ROOT/'test/results/locateanything-independent-final-ar2-pref0-head2-v2-guard.json'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def save(path,r):
 tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');tmp.replace(path)
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def check_contract(contract,pin):
 assert contract.parent.resolve()==BASE and contract.suffix=='.json' and not contract.is_symlink() and sha(contract)==pin
 sys.path.insert(0,str(CODE));sys.path.insert(0,str(RUNTIME))
 assert sha(CODE/'locateanything_official_family_dispatch_v3.py')=='ac1c51e1c6f4f2bc58ce7194d5b29258bc6483f42f77b39985037b65d63189e3'
 from locateanything_official_family_dispatch_v3 import load_official_generator
 generator,d=load_official_generator(contract,pin)
 assert d['schema']=='locateanything_official_full_family_head_optimization_v1' and d['composition']['optimized_head'] is True
 profile=json.loads(Path(d['profile_family']['path']).read_text());assert sha(Path(d['profile_family']['path']))==d['profile_family']['sha256'] and profile['optimization_admission']['replaced_first_layers']==[0,9,18,27]
 assert len(generator.specs)==76 and len({str(x.path.resolve()) for x in generator.specs})==46
 assert sha(REF/'reference-index-v3.json')==REF_SHA and sha(ROOT/'test/results/locateanything-w8a16-ar2-pref0-head2-trial-v2-freeze.json')==FREEZE_SHA
 assert sha(BACKEND)==BACKEND_SHA and sha(CODE/'score_locateanything_independent_final_v2.py')==SCORE_SHA
 artifacts=[]
 for g in profile['groups']:
  package=Path(g['root']);m=json.loads((package/'manifest.json').read_text());s=m['source_status']
  assert s['profile_optimization']=={'1':2,'256':0} and s['first']==g['first']
  artifacts.append(dict(first=g['first'],last=g['last'],package_root=str(package),manifest_sha256=sha(package/'manifest.json'),hbm_sha256=sha(package/'official-q8/model.hbm'),board_guard_sha256=g['proof']['sha256']))
 head=Path(d['head']['root']);m=json.loads((head/'manifest.json').read_text());assert m['source_status']['hbm_sha256']=='dbbe9123fb3216e4edac9d5a91888d44810baad867f7d0a1a17393c0aa43d1ca'
 artifacts.append(dict(component='full-vocabulary-head',package_root=str(head),manifest_sha256=sha(head/'manifest.json'),hbm_sha256=sha(head/'official-q8/model.hbm'),board_guard_sha256=d['head']['proof']['sha256']))
 index=json.loads((REF/'reference-index-v3.json').read_text());raw=json.loads((REF/'status.json').read_text());assert index['trial_recipe_freeze_sha256']==FREEZE_SHA and sha(REF/'status.json')==index['raw_sha256'] and raw['source_sha256']=='2c3cf0f0a8a3f968dfde3275d438969be6ab6227d27a2fb9e6143af39153d33e' and raw['selection_sha256']=='95c72fe2a8283bd0818a5263635c9f5a9a2d9e5062370155ea1c0aea52db7599'
 return artifacts

def check_binding(contract,pin,binding_pin):
 artifacts=check_contract(contract,pin);assert sha(BINDING)==binding_pin;b=json.loads(BINDING.read_text())
 assert b['status']=='all_four_and_head_artifacts_bound_before_candidate_final_generation' and b['contract_sha256']==pin and b['contract']==str(contract) and b['artifacts']==artifacts
 assert b['trial_recipe_freeze_sha256']==FREEZE_SHA and b['reference_index_sha256']==REF_SHA and b['evaluation_source_sha256']==sha(__file__) and b['scorer_sha256']==SCORE_SHA
 return b

def parser_functions():
 p=CODE/'validate_locateanything_official_heldout_bpu_v2.py';assert sha(p)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
 nodes=[n for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in ['parse_response','iou','maximum_matches']];scope={'re':re};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(p),'exec'),scope);return scope

def receive(c,size):
 pieces=[]
 while size:
  b=c.recv(size)
  if not b:raise ConnectionError('Incomplete backend response')
  pieces.append(b);size-=len(b)
 return b''.join(pieces)

def client(args):
 assert os.getuid()==1000;check_binding(args.contract,args.contract_sha,args.binding_sha)
 sys.path.insert(0,str(RUNTIME));sys.path.insert(0,str(CODE));from locateanything_prompt import LocateAnythingPrompt,patchify_prepared_chw
 from score_locateanything_independent_final_v2 import summarize
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKEN_SHA);func=parser_functions();reference=json.loads((REF/'reference-index-v3.json').read_text())
 assert len(reference['cases'])==160 and reference['required_candidate_indices']==list(range(160))
 status=OUT/'status.json';assert not status.exists();r=dict(status='running_all160_frozen_requests',started=time.time(),source_sha256=sha(__file__),contract_sha256=args.contract_sha,binding_sha256=args.binding_sha,reference_index_sha256=REF_SHA,trial_recipe_freeze_sha256=FREEZE_SHA,cases=[],neural_calls=0,neural_calls_exact=False,neural_calls_accounting='Successful RPC neural calls;failed RPC work may be uncounted',release_approved=False,overall_elapsed_cap_seconds=None)
 def rpc(header,payload=b''):
  header.update(schema_version=1,contract_sha256=args.contract_sha,input_bytes=len(payload));encoded=json.dumps(header).encode();start=time.monotonic()
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:
   c.settimeout(960);c.connect(str(SOCKET));c.sendall(struct.pack('!I',len(encoded))+encoded+payload);size=struct.unpack('!I',receive(c,4))[0];assert 0<size<=8*1024**2;answer=json.loads(receive(c,size))
  return answer,time.monotonic()-start
 save(status,r)
 try:
  health,_=rpc(dict(operation='health'));assert health['ok'] and health['ready'] and health['evaluation_only'] and health['component_count']==76 and health['physical_hbm_files']==46
  for native in reference['cases']:
   index=native['index'];r['current']=dict(index=index,image_id=native['image_id'],query=native['query']);save(status,r)
   arrays={}
   for key in ['pixels','grid','ids']:
    p=(REF/native[key]).resolve();assert p.is_relative_to(REF.resolve()) and sha(p)==native[key+'_sha256'];arrays[key]=np.load(p,allow_pickle=False)
   assert np.array_equal(prompt.encode(native['query'],256,'slow'),arrays['ids']) and arrays['grid'].tolist()==[[16,32]]
   pixels=arrays['pixels'];assert pixels.shape==(512,3,14,14) and pixels.dtype==np.float32 and np.isfinite(pixels).all()
   chw=np.ascontiguousarray(pixels.reshape(16,32,3,14,14).transpose(2,0,3,1,4).reshape(3,224,448));assert patchify_prepared_chw(chw).tobytes()==pixels.tobytes()
   header=dict(operation='generate',description=native['query'],tokens=256,input_shape=[3,224,448],pixel_format='rgb-chw-f32le');answer,seconds=rpc(header,chw.astype('<f4',copy=False).tobytes())
   item={k:native[k] for k in ['index','image_id','query','kind','reference','reference_eligible','reference_terminal']};item.update(rpc_ok=answer.get('ok') is True,terminal=answer.get('terminal') is True,neural_cpu_fallback=answer.get('neural_cpu_fallback',True),candidate=func['parse_response'](answer['response']) if answer.get('ok') else None,rpc_seconds=seconds,answer=answer)
   if answer.get('ok'):
    assert answer['models_retained_for_next_request'] and not answer['generation_state_retained'] and not answer['image_features_retained'] and answer['executor_stats']['loads']==answer['executor_stats']['evictions']==0
    duration=sum(s['seconds'] for s in answer['steps'][1:]);item['native_decode_tokens_per_second']=(len(answer['generated_ids'])-1)/duration if duration>0 else None;r['neural_calls']+=answer['bpu_calls']
   # Preserve malformed/nonterminal/RPC failures and continue the fixed160 operational requests.
   r['cases'].append(item);r['failed_rpc_count']=sum(not c['rpc_ok'] for c in r['cases']);r['summary']=summarize(r['cases'],func['parse_response'],func['iou'],func['maximum_matches'],reference);save(status,r)
   health,_=rpc(dict(operation='health'));assert health['ok'] and health['ready'] and not health['busy']
  assert [c['index'] for c in r['cases']]==list(range(160));r['status']='completed_all160_candidate_operations';r['neural_calls_exact']=r['failed_rpc_count']==0;r['candidate_quality_passed']=r['summary']['trial_quality_passed']
 except BaseException:r.update(status='failed_incomplete_final_evaluation',error=traceback.format_exc());raise
 finally:r['finished']=time.time();save(status,r)
 print(json.dumps({k:r.get(k) for k in ['status','neural_calls','candidate_quality_passed','summary']}))

def main():
 global REF_SHA
 p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha',required=True);p.add_argument('--binding-sha');p.add_argument('--reference-sha',required=True);p.add_argument('--bind-only',action='store_true');p.add_argument('--check-only',action='store_true');p.add_argument('--client',action='store_true');args=p.parse_args()
 assert re.fullmatch('[0-9a-f]{64}',args.contract_sha) and re.fullmatch('[0-9a-f]{64}',args.reference_sha)
 REF_SHA=args.reference_sha
 if args.bind_only:
  assert os.getuid()==0 and not BINDING.exists() and not OUT.exists();artifacts=check_contract(args.contract,args.contract_sha)
  b=dict(status='all_four_and_head_artifacts_bound_before_candidate_final_generation',created=time.time(),contract=str(args.contract),contract_sha256=args.contract_sha,artifacts=artifacts,trial_recipe_freeze_sha256=FREEZE_SHA,reference_index_sha256=REF_SHA,evaluation_source_sha256=sha(__file__),scorer_sha256=SCORE_SHA,candidate_final_executed=False,release_approved=False)
  save(BINDING,b);os.chown(BINDING,1000,1000);print(json.dumps(dict(status=b['status'],binding_sha256=sha(BINDING))));return
 assert args.binding_sha and re.fullmatch('[0-9a-f]{64}',args.binding_sha);check_binding(args.contract,args.contract_sha,args.binding_sha)
 if args.check_only:
  assert not OUT.exists();print(json.dumps(dict(status='complete_frozen_final_admission_checked',required_candidate_cases=160,eligible_native_gold=json.loads((REF/'reference-index-v3.json').read_text())['reference_eligible_cases'],neural_calls=0,release_approved=False)));return
 if args.client:client(args);return
 assert os.getuid()==0 and sha(CODE/'locateanything_process_memory_v4.py')==SAMPLE_SHA
 sys.path.insert(0,str(CODE));from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap,IncompleteProcessSnapshot
 from locateanything_process_memory_v3 import find_owned_workers
 import urllib.request
 assert not OUT.exists() and not REPORT.exists() and not SOCKET.exists();OUT.mkdir(mode=0o750);os.chown(OUT,1000,1000)
 key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
 def state():
  path='/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097'
  def get(p):
   req=urllib.request.Request('http://127.0.0.1:8000'+p,headers={'X-Api-Key':key})
   with urllib.request.urlopen(req,timeout=5) as f:return json.load(f)
  d=get(path);last=get(path+'/results/latest')['result']
  return dict(inference_count=d['stats']['inference_count'],consecutive_errors=d['stats']['consecutive_errors'],decoded_frames=d['stats']['frame_count'],frame_index=last['frame_index'],pts=last['frame_pts_ns'],timestamp=last['timestamp'])
 def media():
  with urllib.request.urlopen('http://127.0.0.1:8100/v1/recorder/health',timeout=5) as f:r=json.load(f)
  with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams',timeout=5) as f:s=next(x for x in json.load(f)['streams'] if x['app']=='live' and x['name']=='xm')
  return dict(ok=r['ok'],storageHealthy=r['storageHealthy'],writeDegradedChannels=r['writeDegradedChannels'],droppedMsLastHour=r['droppedMsLastHour'],publish_active=s['publish']['active'],recv_bytes=s['recv_bytes'])
 def services():return {n:subprocess.run(['systemctl','is-active',n],capture_output=True,text=True,timeout=10).stdout.strip() for n in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
 r=dict(status='running_frozen_final_guard',started=time.time(),source_sha256=sha(__file__),contract_sha256=args.contract_sha,binding_sha256=args.binding_sha,reference_index_sha256=REF_SHA,memory_sampler_sha256=SAMPLE_SHA,backend_sha256=BACKEND_SHA,production_paused=False,release_approved=False,overall_elapsed_cap_seconds=None,root_pid=os.getpid(),root_start_ticks=ticks(os.getpid()),memory_sample_count=0,conservative_backend_memory_bytes_maximum=0,conservative_experiment_process_memory_bytes_maximum=0)
 backend=child=None;bt=ct=None;owned=None;tids=set();sample_path=OUT/'memory-samples.ndjson';samples=None
 def stop_group(proc,start,argument):
  if proc is None or proc.poll() is not None:return
  assert ticks(proc.pid)==start and os.getpgid(proc.pid)==proc.pid and str(argument).encode() in Path(f'/proc/{proc.pid}/cmdline').read_bytes().split(b'\0');os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:
   assert ticks(proc.pid)==start;os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
 def interrupted(*_):raise RuntimeError('Owned final evaluation interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  assert all(v=='active' for v in services().values());r['before']=state();r['media_before']=media();assert r['before']['consecutive_errors']==0 and r['media_before']['ok'] and r['media_before']['storageHealthy'] and r['media_before']['publish_active']
  names=['deploy/s100p/bin/ainvr_ai_service','data/ai/config_overlay.json'];r['production_hashes_before']={n:sha(ROOT/n) for n in names};save(REPORT,r)
  cmd=['runuser','-u','sunrise','--',str(PYTHON),str(BACKEND),'--contract',str(args.contract),'--contract-sha256',args.contract_sha,'--tokenizer',str(BASE/'tokenizer-original-v1.json'),'--tokenizer-sha256',TOKEN_SHA,'--socket',str(SOCKET),'--maximum-seconds','900']
  with (OUT/'backend.log').open('xb') as f:backend=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
  bt=ticks(backend.pid);r.update(backend_supervisor_pid=backend.pid,backend_supervisor_start_ticks=bt);save(REPORT,r)
  while not SOCKET.exists():assert backend.poll() is None;time.sleep(.1)
  cmd=['runuser','-u','sunrise','--',str(PYTHON),str(Path(__file__).resolve()),'--client','--contract',str(args.contract),'--contract-sha',args.contract_sha,'--binding-sha',args.binding_sha,'--reference-sha',REF_SHA]
  with (OUT/'client.log').open('xb') as f:child=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
  ct=ticks(child.pid);r.update(client_supervisor_pid=child.pid,client_supervisor_start_ticks=ct);save(REPORT,r);samples=sample_path.open('x');last_save=time.monotonic()
  while child.poll() is None:
   assert backend.poll() is None,'Owned backend stopped during final evaluation'
   if owned is None:
    workers=find_owned_workers(backend.pid,str(BACKEND),1000);assert len(workers)<=1
    if workers:owned=workers[0];r['backend_worker']={k:owned[k] for k in ['pid','start_ticks','pgid','uid']}
   if owned:
    try:
     s=sample_owned_process(owned['pid'],owned['start_ticks'],backend.pid,str(BACKEND),1000);identities=s['owned_task_start_ticks'];tids.update(map(int,identities));total=s['rss_bytes']+sum(s['owned_heap_bytes'].values());assert total<=10400000000
     other=[os.getpid(),backend.pid,child.pid];workers=find_owned_workers(child.pid,str(Path(__file__).resolve()),1000);other += [w['pid'] for w in workers]
     extra=0
     for pid in set(other):
      values=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split();extra+=int(values[21])*os.sysconf('SC_PAGE_SIZE')
     s.update(observed=time.time(),conservative_backend_bytes=total,conservative_experiment_process_bytes=total+extra);assert total+extra<=10400000000;samples.write(json.dumps(s)+'\n');samples.flush();r['memory_sample_count']+=1
     r['conservative_backend_memory_bytes_maximum']=max(r['conservative_backend_memory_bytes_maximum'],total);r['conservative_experiment_process_memory_bytes_maximum']=max(r['conservative_experiment_process_memory_bytes_maximum'],total+extra)
    except (FileNotFoundError,ProcessLookupError,IncompleteProcessSnapshot):r['incomplete_memory_samples']=r.get('incomplete_memory_samples',0)+1
   if time.monotonic()-last_save>=2:save(REPORT,r);last_save=time.monotonic()
   time.sleep(.2)
  assert child.returncode==0;raw=json.loads((OUT/'status.json').read_text());assert raw['status']=='completed_all160_candidate_operations' and len(raw['cases'])==160
  r.update(status='completed_all160_operations_guard',raw_sha256=sha(OUT/'status.json'),summary=raw['summary'],candidate_quality_passed=raw['candidate_quality_passed'],neural_calls=raw['neural_calls'],neural_calls_exact=raw['neural_calls_exact'])
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if samples is not None:samples.close();r['memory_samples_sha256']=sha(sample_path)
  try:
   stop_group(child,ct,Path(__file__).resolve())
   if backend is not None and backend.poll() is None and owned is not None:
    assert ticks(owned['pid'])==owned['start_ticks'];os.kill(owned['pid'],signal.SIGTERM)
    try:backend.wait(timeout=30)
    except subprocess.TimeoutExpired:stop_group(backend,bt,BACKEND)
   else:stop_group(backend,bt,BACKEND)
   assert backend is not None and backend.returncode==0 and not SOCKET.exists();heaps={}
   for name in ['cma_reserved','carveout','ion_cma']:
    p=Path('/sys/kernel/debug/ion/heaps')/name
    if p.exists():heaps[name]=sum(parse_owned_tasks_heap(p.read_text(),name,tids).values())
   assert sum(heaps.values())==0;r.update(owned_backend_stopped=True,private_socket_removed=True,owned_ion_after_exit=heaps)
  except BaseException:r.update(status='failed',cleanup_error=traceback.format_exc())
  try:
   r['after']=state();r['media_after']=media();r['services_after']=services();assert all(v=='active' for v in r['services_after'].values()) and r['after']['consecutive_errors']==0 and time.time()-r['after']['timestamp']<10
   for k in ['inference_count','decoded_frames','frame_index','pts']:assert r['after'][k]>r['before'][k]
   assert r['media_after']['ok'] and r['media_after']['storageHealthy'] and r['media_after']['publish_active'] and r['media_after']['writeDegradedChannels']==0 and r['media_after']['droppedMsLastHour']==r['media_before']['droppedMsLastHour'] and r['media_after']['recv_bytes']>=r['media_before']['recv_bytes']
   r['production_hashes_after']={n:sha(ROOT/n) for n in r['production_hashes_before']};assert r['production_hashes_after']==r['production_hashes_before'];r['production_unchanged_and_fresh']=True
  except BaseException:r.update(status='failed',production_postcheck_error=traceback.format_exc())
  r['finished']=time.time();save(REPORT,r)
 print(json.dumps({k:r.get(k) for k in ['status','summary','candidate_quality_passed','conservative_backend_memory_bytes_maximum','conservative_experiment_process_memory_bytes_maximum','production_unchanged_and_fresh','error','cleanup_error','production_postcheck_error']}));assert r['status']=='completed_all160_operations_guard'
if __name__=='__main__':main()
