# Private full160 guard for the GPTQ INT8 same-BC O2 text decoder;finally restores current deployed v11.
"""All160 reused-runtime qualification with an authorized AI-only maintenance pause.

Original recording/ingest/source remain live. Always restore the original active
units in finally;never roll back the user's files or create/delete SRS channels.
"""
from pathlib import Path
import argparse,re,fcntl,hashlib,json,os,signal,subprocess,sys,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
CLIENT=CODE/'regress_locateanything_text_gptq8_o2_eval_v321.py';BACKEND=RUNTIME/'locateanything_bpu_text_gptq8_o2_eval_executor_v14.py'
OUT=BASE/'text-gptq8-o2-eval160-v321';SOCKET=ROOT/'data/ai/locate-text-gptq8-o2-eval-v321.sock'
REPORT=ROOT/'test/results/locateanything-text-gptq8-o2-eval160-guard-v322.json';PYTHON=RUNTIME/'.venv-locateanything/bin/python'
CONTRACT=BASE/'official-full-family-w8a16-text-gptq8-o2-eval-v320.json';CONTRACT_SHA=None
TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
BACKEND_SHA='27da9bc48907f77096d25e59368436601b51648629879f29b49c08b2e60e4bcd'
CLIENT_SHA='50fc4a650b977ca2a7f9edfcc5c2ccc8c49d9ff01469c5778e081fc81dbe1d7f'
CURRENT_BACKEND=RUNTIME/'locateanything_bpu_vision_o2_executor_v11.py'
CURRENT_BACKEND_SHA='d4efa1bd5cca6bbc4b923fa7a467001b84ead18b1a87ebaf3f69f3246cdb1bcf'
CURRENT_CONTRACT=BASE/'official-full-family-w8a16-vision-o2-v284.json'
CURRENT_CONTRACT_SHA=None;BASELINE_SHA=None
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name(p.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def active(n):return subprocess.run(['systemctl','is-active',n],capture_output=True,text=True,timeout=8).stdout.strip()
def unit(action,name):subprocess.run(['systemctl',action,name],check=True,timeout=45)
def main():
 global CONTRACT_SHA,CURRENT_CONTRACT_SHA,BASELINE_SHA
 p=argparse.ArgumentParser();p.add_argument('--contract-sha',required=True);p.add_argument('--current-contract-sha',required=True);p.add_argument('--baseline-sha',required=True);p.add_argument('--client-sha',required=True);p.add_argument('--binding-sha',required=True);a=p.parse_args()
 assert re.fullmatch('[0-9a-f]{64}',a.contract_sha);CONTRACT_SHA=a.contract_sha
 assert re.fullmatch('[0-9a-f]{64}',a.current_contract_sha) and re.fullmatch('[0-9a-f]{64}',a.baseline_sha);CURRENT_CONTRACT_SHA=a.current_contract_sha;BASELINE_SHA=a.baseline_sha
 assert os.getuid()==0 and sha(CLIENT)==a.client_sha==CLIENT_SHA and sha(BACKEND)==BACKEND_SHA
 assert sha(CURRENT_BACKEND)==CURRENT_BACKEND_SHA and sha(CURRENT_CONTRACT)==CURRENT_CONTRACT_SHA
 assert not REPORT.exists() and not OUT.exists() and not SOCKET.exists()
 assert sha(CODE/'locateanything_process_memory_v4.py')=='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
 sys.path.insert(0,str(CODE))
 from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap,IncompleteProcessSnapshot
 from locateanything_process_memory_v3 import find_owned_workers
 # Admission runs before any service action and must not issue neural calls.
 subprocess.run([str(PYTHON),str(CLIENT),'--contract-sha',CONTRACT_SHA,'--baseline-sha',BASELINE_SHA,'--check-only','--binding-sha',a.binding_sha],check=True,timeout=120,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
 key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
 prefix='http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097'
 def get(url,auth=False):
  request=urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {})
  with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
 def state():return get(prefix,True)
 def unit_identity(n):
  pid=int(subprocess.check_output(['systemctl','show',n,'--property=MainPID','--value'],text=True,timeout=8));assert pid>0
  return dict(pid=pid,start_ticks=ticks(pid))
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');ss=get('http://127.0.0.1:1985/api/v1/streams')['streams']
  source=next(x for x in ss if x['app']=='live' and x['name']=='xm')
  return dict(recorder={k:h.get(k) for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},frames=source['frames'],recv_bytes=source['recv_bytes'],publish_active=source['publish']['active'],original_unit_processes={n:unit_identity(n) for n in ['ainvr-recorder','ainvr-ingest']})
 services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest']
 r=dict(status='checking',scope=__doc__,started=time.time(),source_sha256=sha(__file__),client_sha256=a.client_sha,backend_sha256=BACKEND_SHA,binding_sha256=a.binding_sha,
        root_pid=os.getpid(),root_start_ticks=ticks(os.getpid()),baseline_raw_sha256=BASELINE_SHA,current_contract_sha256=CURRENT_CONTRACT_SHA,candidate_contract_sha256=CONTRACT_SHA,overall_elapsed_cap_seconds=None,source_recording_stopped=False,
        production_candidate_installed=False,memory_sample_count=0,incomplete_memory_samples=0,conservative_backend_memory_bytes_maximum=0,conservative_experiment_memory_bytes_maximum=0,release_approved=False)
 restore=[];backend=client=None;bt=ct=None;owned=None;all_tids=set();samples=None
 lease=(ROOT/'data/ai/runtime-validation.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def stop_group(proc,start,argument):
  if proc is None or proc.poll() is not None:return
  assert ticks(proc.pid)==start and os.getpgid(proc.pid)==proc.pid and str(argument).encode() in Path(f'/proc/{proc.pid}/cmdline').read_bytes().split(b'\0')
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=12)
  except subprocess.TimeoutExpired:
   assert ticks(proc.pid)==start;os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
 def interrupted(*_):raise RuntimeError('Owned runtime regression interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  assert all(active(n)=='active' for n in services)
  channels=get('http://127.0.0.1:8000/api/v1/channels',True)['channels']
  assert len(channels)==1 and channels[0]['id']=='2baec0a3-9941-47dc-b1bd-d3d284488097'
  assert channels[0]['config']['model']['adapter']=='locateanything_bpu'
  r['before']=state();r['media_before']=media();r['config_before']=sha(ROOT/'data/ai/config_overlay.json');r['binary_before']=sha(ROOT/'deploy/s100p/bin/ainvr_ai_service')
  old=CURRENT_BACKEND;assert sha(old)==CURRENT_BACKEND_SHA
  pid=int(subprocess.check_output(['systemctl','show','ainvr-locateanything-official-bpu','--property=MainPID','--value'],text=True,timeout=8));assert str(old).encode() in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
  r['original_backend_pid']=pid;r['original_backend_start_ticks']=ticks(pid)
  assert r['before']['state']=='running' and r['before']['stats']['consecutive_errors']==0
  assert r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy'] and r['media_before']['publish_active']
  restore=['ainvr-locateanything-official-bpu','ainvr-ai'];save(REPORT,r)
  unit('stop','ainvr-ai');unit('stop','ainvr-locateanything-official-bpu');r['ai_paused_at']=time.time();save(REPORT,r)
  assert active('ainvr-ai')=='inactive' and active('ainvr-locateanything-official-bpu')=='inactive'
  OUT.mkdir(mode=0o750);os.chown(OUT,1000,1000)
  cmd=['runuser','-u','sunrise','--',str(PYTHON),str(BACKEND),'--contract',str(CONTRACT),'--contract-sha256',CONTRACT_SHA,'--tokenizer',str(BASE/'tokenizer-original-v1.json'),'--tokenizer-sha256',TOKEN_SHA,'--socket',str(SOCKET),'--maximum-seconds','900']
  with (OUT/'backend.log').open('xb') as log:backend=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
  bt=ticks(backend.pid);r.update(backend_supervisor_pid=backend.pid,backend_supervisor_start_ticks=bt);save(REPORT,r)
  readiness=time.monotonic()+90
  while not SOCKET.exists():assert backend.poll() is None and time.monotonic()<readiness;time.sleep(.1)
  cmd=['runuser','-u','sunrise','--',str(PYTHON),str(CLIENT),'--contract-sha',CONTRACT_SHA,'--baseline-sha',BASELINE_SHA,'--binding-sha',a.binding_sha]
  with (OUT/'client.log').open('xb') as log:client=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
  ct=ticks(client.pid);r.update(client_supervisor_pid=client.pid,client_supervisor_start_ticks=ct,status='running_all160_private_backend');save(REPORT,r)
  samples=(OUT/'memory-samples.ndjson').open('x');next_save=time.monotonic()+2;next_media=time.monotonic()+5
  while client.poll() is None:
   assert backend.poll() is None,'Private backend exited during frozen160 regression'
   if owned is None:
    workers=find_owned_workers(backend.pid,str(BACKEND),1000);assert len(workers)<=1
    if workers:owned=workers[0];r['backend_worker']={k:owned[k] for k in ['pid','start_ticks','pgid','uid']}
   if owned:
    try:
     s=sample_owned_process(owned['pid'],owned['start_ticks'],backend.pid,str(BACKEND));all_tids.update(map(int,s['owned_task_start_ticks']))
     total=s['rss_bytes']+sum(s['owned_heap_bytes'].values());assert total<=10_400_000_000
     extra=0;other={os.getpid(),backend.pid,client.pid}
     other.update(x['pid'] for x in find_owned_workers(client.pid,str(CLIENT),1000))
     for pid in other:extra+=int(Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[21])*os.sysconf('SC_PAGE_SIZE')
     s.update(conservative_backend_bytes=total,conservative_experiment_bytes=total+extra);assert total+extra<=10_400_000_000
     samples.write(json.dumps(s)+'\n');samples.flush();r['memory_sample_count']+=1
     r['conservative_backend_memory_bytes_maximum']=max(r['conservative_backend_memory_bytes_maximum'],total)
     r['conservative_experiment_memory_bytes_maximum']=max(r['conservative_experiment_memory_bytes_maximum'],total+extra)
    except (FileNotFoundError,ProcessLookupError,IncompleteProcessSnapshot):r['incomplete_memory_samples']+=1
   available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;assert available>2*1024**3
   now=time.monotonic()
   if now>=next_media:
    m=media();assert m['recorder']['ok'] and m['recorder']['storageHealthy'] and m['publish_active'] and m['recorder']['writeDegradedChannels']==0
    assert m['original_unit_processes']==r['media_before']['original_unit_processes']
    r['media_latest']=m;next_media=now+5
   if now>=next_save:save(REPORT,r);next_save=now+2
   time.sleep(.2)
  raw=json.loads((OUT/'status.json').read_text());r.update(client_returncode=client.returncode,raw_sha256=sha(OUT/'status.json'),summary=raw.get('summary'),runtime_equivalence_passed=raw.get('runtime_equivalence_passed'),neural_calls=raw.get('neural_calls'),retained_failed_indices=raw.get('retained_failed_indices'))
  assert client.returncode==0 and raw['status']=='completed_all160_runtime_regression' and len(raw['cases'])==160
  r['status']='completed_all160_evaluation_not_installed'
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if samples is not None:samples.close();r['memory_samples_sha256']=sha(OUT/'memory-samples.ndjson')
  try:
   stop_group(client,ct,CLIENT)
   if backend is not None and backend.poll() is None and owned is not None:
    assert ticks(owned['pid'])==owned['start_ticks'];os.kill(owned['pid'],signal.SIGTERM)
    try:backend.wait(timeout=30)
    except subprocess.TimeoutExpired:stop_group(backend,bt,BACKEND)
   else:stop_group(backend,bt,BACKEND)
   if backend is not None:assert backend.returncode==0 and not SOCKET.exists()
   heaps={}
   for name in ['cma_reserved','carveout','ion_cma']:
    p=Path('/sys/kernel/debug/ion/heaps')/name
    if p.exists():heaps[name]=sum(parse_owned_tasks_heap(p.read_text(),name,all_tids).values())
   assert not any(heaps.values());r['owned_ion_after_exit']=heaps
  except BaseException:r.update(status='failed',cleanup_error=traceback.format_exc())
  r['restore_errors']=[]
  for name in restore:
   try:unit('start',name)
   except BaseException:r['restore_errors'].append(dict(unit=name,error=traceback.format_exc()))
  r['ai_units_restarted_at']=time.time();save(REPORT,r)
  try:
   assert not r['restore_errors'];assert all(active(n)=='active' for n in services)
   deadline=time.monotonic()+190
   while True:
    try:s=state()
    except urllib.error.URLError as error:
     r.setdefault('restore_http_readiness_errors',[]).append(str(error));assert time.monotonic()<deadline;time.sleep(.5);continue
    m=media();pub=s['stats'].get('publish',{});assert m['recorder']['ok'] and m['recorder']['storageHealthy'] and m['publish_active']
    if s['state']=='running' and s['stats']['inference_count']>0 and pub.get('running') and pub.get('sei_injected',0)>0 and pub.get('au_pushed',0)>0:break
    assert time.monotonic()<deadline,'Original delayed AI stream did not recover';time.sleep(1)
   r['after']=s;r['media_after']=m;r['config_after']=sha(ROOT/'data/ai/config_overlay.json');r['binary_after']=sha(ROOT/'deploy/s100p/bin/ainvr_ai_service')
   assert s['stats']['consecutive_errors']==0 and r['config_after']==r['config_before'] and r['binary_after']==r['binary_before']
   assert m['original_unit_processes']==r['media_before']['original_unit_processes']
   assert m['frames']>r['media_before']['frames'] and m['recv_bytes']>r['media_before']['recv_bytes']
   pid=int(subprocess.check_output(['systemctl','show','ainvr-locateanything-official-bpu','--property=MainPID','--value'],text=True,timeout=8));assert str(CURRENT_BACKEND).encode() in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
   assert sha(CURRENT_BACKEND)==CURRENT_BACKEND_SHA and sha(CURRENT_CONTRACT)==CURRENT_CONTRACT_SHA
   r['original_backend_user_config_and_sei_output_restored']=True
   r['preferred_memory_below_8GB']=r['conservative_experiment_memory_bytes_maximum']<8_000_000_000
  except BaseException:r.update(status='failed',restore_postcheck_error=traceback.format_exc())
  r['finished']=time.time();save(REPORT,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','runtime_equivalence_passed','neural_calls','retained_failed_indices','conservative_backend_memory_bytes_maximum','original_backend_user_config_and_sei_output_restored','error','cleanup_error','restore_postcheck_error']}))
 assert r['status']=='completed_all160_evaluation_not_installed'
if __name__=='__main__':main()
