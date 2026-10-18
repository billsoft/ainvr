"""One existing W8 AR fixture through matching official hardware-trace runner.

No model/precision/configuration/service changes. A concurrent diagnostic call
is not an isolated latency benchmark or whole-model MAC-utilization measure.
"""
from pathlib import Path
import fcntl,hashlib,json,os,signal,subprocess,sys,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
KIT=BASE/'official-hwperf-tools-v125';PACKAGE=BASE/'official-qwen-group-0-8-w8a16-ar2-pref0-v1-board-package';OUT=BASE/'official-hwperf-trace-v125';REPORT=ROOT/'test/results/locateanything-official-hwperf-trace-v125.json'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(r):
 p=REPORT.with_name('.'+REPORT.name+'.incoming');p.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');p.replace(REPORT)
def main():
 assert os.getuid()==0 and not OUT.exists() and not REPORT.exists()
 assert sha(PACKAGE/'manifest.json')=='4a23c4b34a9d25e1d702f731e6ec787f1ae5a265d48e9dfbca1ddee17bebf1f7'
 m=read(PACKAGE/'manifest.json');profile=next(x for x in m['profiles'] if x['sequence']==1)
 assert sha(PACKAGE/'official-q8/model.hbm')=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399'
 assert profile['name']=='locate_official_qwen_group_0_8_s1'
 disas=read(PACKAGE/'disas.json');graph=next(x for x in disas['graphs'] if x['name']==profile['name']);assert all(n['device']=='DEVICE_CATEGORY_BPU' for n in graph['nodes'])
 cap=read(ROOT/'test/results/locateanything-official-hwperf-capability-v125.json');assert cap['status']=='official_matching_cli_help_verified_zero_nn_calls'
 for name,v in cap['files'].items():assert sha(KIT/name)==v['sha256']
 sys.path.insert(0,str(CODE));assert sha(CODE/'locateanything_process_memory_v4.py')=='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
 from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap,IncompleteProcessSnapshot
 import numpy as np
 lease=(ROOT/'data/ai/runtime-validation.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 key=read(ROOT/'data/ai/config_overlay.json')['server']['api_key']
 def get(url,auth=False):
  with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Api-Key':key} if auth else {}),timeout=5) as f:return json.load(f)
 def state():return get('http://127.0.0.1:8000/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097',True)
 services=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-recorder','ainvr-ingest']
 def units():return {n:subprocess.check_output(['systemctl','show',n,'--property=MainPID,ActiveState','--value'],text=True,timeout=8) for n in services}
 def media():
  h=get('http://127.0.0.1:8100/v1/recorder/health');s=next(x for x in get('http://127.0.0.1:1985/api/v1/streams')['streams'] if x['app']=='live' and x['name']=='xm');return dict(recorder={k:h.get(k) for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},frames=s['frames'],recv_bytes=s['recv_bytes'],active=s['publish']['active'])
 r=dict(status='admitting_one_diagnostic_call',started=time.time(),source_sha256=sha(__file__),scope=__doc__,neural_calls_requested=1,model_sha256=sha(PACKAGE/'official-q8/model.hbm'),services_changed=False,production_model_changed=False,trace_collected=False,compiler_byte_exact_verified=False,whole_model_verified=False,release_approved=False,memory_samples=0,incomplete_memory_samples=0,conservative_worker_memory_maximum=0)
 child=None;start=None;tids=set()
 def stop(*_):raise RuntimeError('Owned hardware trace interrupted')
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
 try:
  r['before']=state();r['media_before']=media();r['units_before']=units();r['protected_before']={str(p):sha(p) for p in [ROOT/'data/ai/config_overlay.json',ROOT/'deploy/s100p/bin/ainvr_ai_service',Path('/usr/hobot/lib/libhbrt4.so'),Path('/usr/hobot/lib/libhbtl.so')]};assert r['before']['state']=='running' and r['before']['stats']['consecutive_errors']==0 and r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy'] and r['media_before']['active']
  heap=Path('/sys/kernel/debug/ion/heaps/cma_reserved').read_text().split('allocations (',1)[0];total=int(next(l.split()[-1] for l in heap.splitlines() if 'heap total size' in l));used=sum(int(l.split()[3]) for l in heap.splitlines() if len(l.split())==4 and l.split()[0]=='cma_reserved' and l.split()[2].isdigit());assert total-used>1_500_000_000;r['dedicated_pool_free_before']=total-used
  OUT.mkdir(mode=0o755);os.chown(OUT,1000,1000);inputs=[];refs=[]
  for stem,count,dest in [('input',22,inputs),('compiler',19,refs)]:
   for i in range(count):
    name=f's1/case-00/{stem}-{i:02d}.npy';p=PACKAGE/name;assert sha(p)==m['files'][name]['sha256'] and p.stat().st_size==m['files'][name]['bytes'];a=np.load(p,allow_pickle=False);assert a.dtype==np.float32 and np.isfinite(a).all();q=OUT/f'{stem}-{i:02d}.bin';q.write_bytes(a.tobytes(order='C'));q.chmod(0o644);dest.append(q)
  output=OUT/'output';output.mkdir(mode=0o750);os.chown(output,1000,1000)
  cmd=[str(KIT/'bin/hbrt4-run-model-nash'),'-m','Bpu30g','-f',str(PACKAGE/'official-q8/model.hbm'),'-n',profile['name']]
  for p in inputs:cmd+=['-i',str(p)]
  for p in refs:cmd+=['-r',str(p)]
  cmd+=['--diff-measure','allequal','--hwperf-buffer-size',str(20*1024**2),'--perf','-t','1','-o',str(output)]
  r['command']=cmd;save(r);env=dict(os.environ,LD_LIBRARY_PATH=str(KIT/'lib')+':/usr/hobot/lib');env.pop('_HB_UCP_PROFILER_LOG_PATH_',None)
  with (OUT/'runner.stdout.log').open('xb') as stdout,(OUT/'runner.stderr.log').open('xb') as stderr:child=subprocess.Popen(['runuser','-u','sunrise','--',*cmd],stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,env=env,cwd=OUT,start_new_session=True)
  start=ticks(child.pid);r.update(status='running_one_official_hardware_trace',child_pid=child.pid,child_start_ticks=start);save(r);deadline=time.monotonic()+150
  while child.poll() is None:
   assert time.monotonic()<deadline,'Finite single-call hardware diagnostic deadline'
   for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():continue
    try:
     pid=int(proc.name)
     if pid==child.pid or os.getpgid(pid)!=child.pid:continue
     argv=(proc/'cmdline').read_bytes().split(b'\0')
     if str(KIT/'bin/hbrt4-run-model-nash').encode() not in argv:continue
     sample=sample_owned_process(pid,ticks(pid),child.pid,str(KIT/'bin/hbrt4-run-model-nash'));tids.update(map(int,sample['owned_task_start_ticks']));value=sample['rss_bytes']+sum(sample['owned_heap_bytes'].values());assert value<1_500_000_000;r['conservative_worker_memory_maximum']=max(r['conservative_worker_memory_maximum'],value);r['memory_samples']+=1
    except (FileNotFoundError,ProcessLookupError,IncompleteProcessSnapshot):r['incomplete_memory_samples']+=1
   assert int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024>2*1024**3;time.sleep(.02)
  r['returncode']=child.returncode;r['stdout_sha256']=sha(OUT/'runner.stdout.log');r['stderr_sha256']=sha(OUT/'runner.stderr.log');r['output_files']={str(p.relative_to(output)):dict(bytes=p.stat().st_size,sha256=sha(p)) for p in output.rglob('*') if p.is_file()};assert child.returncode==0,('Official runner failed',child.returncode,(OUT/'runner.stderr.log').read_text(errors='replace')[-2500:])
  trace=output/'hwperf_enc.bin';assert trace.is_file() and trace.stat().st_size>0;r.update(status='completed_trace_and_official_allequal_reference_check',trace_collected=True,trace_sha256=sha(trace),compiler_byte_exact_verified=True)
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
   assert tids and r['memory_samples'] and not any(heaps.values());r['owned_ion_after_exit']=heaps;assert units()==r['units_before'] and all(sha(Path(p))==h for p,h in r['protected_before'].items())
   deadline=time.monotonic()+120
   while True:
    s=state();pub=s['stats']['publish'];old=r['before']['stats']['publish']
    if s['state']=='running' and s['stats']['consecutive_errors']==0 and s['stats']['inference_count']>r['before']['stats']['inference_count'] and pub['sei_injected']>old['sei_injected'] and pub['au_pushed']>old['au_pushed']:break
    assert time.monotonic()<deadline;time.sleep(.5)
   med=media();assert s['config']==r['before']['config'] and med['recorder']['ok'] and med['recorder']['storageHealthy'] and med['recorder']['writeDegradedChannels']==0 and med['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'] and med['active'] and med['frames']>r['media_before']['frames'] and med['recv_bytes']>r['media_before']['recv_bytes'];r.update(after=s,media_after=med,production_unchanged_and_fresh=True)
  except BaseException:r.update(status='failed',postcheck_error=traceback.format_exc())
  r['finished']=time.time();save(r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','trace_collected','compiler_byte_exact_verified','production_unchanged_and_fresh','error','postcheck_error']}));assert r['status']=='completed_trace_and_official_allequal_reference_check'
if __name__=='__main__':main()
