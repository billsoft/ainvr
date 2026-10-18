"""Same-BC O2 prefill for original layers18..26,retaining exact admitted AR HBO.

Only one new prefill profile;no calibration/graph/weight changes,not balance2.
Large output and TMPDIR use the existing owned D staging FD. Compilation keeps
6GiB C reserve;fixed-HBO linking uses the separately proven4GiB C reserve.
No total elapsed cap,no production unit operations,no implied board acceptance.
"""
from pathlib import Path
import argparse,fcntl,hashlib,json,os,shutil,signal,subprocess,sys,time,traceback
STAGE=Path('/work/official-llm-v1');SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python');ORIGIN=Path('/opt/locate-official-qwen-group-18-26-w8a16-ar2-pref0-v2');GUARD=STAGE/'official-w8-prefill-g18-o2-v187-guard.json'
STATUS_SHA='f7d7b78189fe15b5e608a09ed0d40a0da9aaecf8e58f4a83e601f16bfc426c3c';HBM_SHA='5468d7fce1874606c32762926a2223ea8eebaf347a9afc42b5c314c2c6589f32';BC_SHA='4c96c2046273e242cb408a2900f6b8ca60657c5fc7c0ea48077a8ba0351d124b';AR_HBO_SHA='03dbeae1332728e5174f91f50d66e605e22949ac9c3831bf9a97cf3465094e41';API_SHA='c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name('.'+p.name+'.incoming-v187');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def storage():
 h=read(STAGE/'d-task-storage-v131-holder.json');assert h['status']=='holding_task_directory_fd' and h['pid']==672834 and h['start_ticks']==ticks(672834)=='19235986' and h['source_sha256']=='e9b1b6d3986c597a54f4e36f2bba54c8c613cfeed917ab34abcbfca3a4dce365';assert b'/work/official-llm-v1/hold_locateanything_task_directory_v131.py' in Path('/proc/672834/cmdline').read_bytes().split(b'\0');assert h['access_path']=='/proc/672834/fd/9';large=Path(h['access_path']);owner=read(large/'.ainvr-task-owner.json');assert owner['thread']=='01a11f62-f8a4-7801-8cd1-52fbcea37056' and owner['source_directory']=='/home/sunrise/ainvr';return h,large,large/'prefill-g18-o2-v187'
def admit():
 holder,large,out=storage();assert sha(ORIGIN/'status.json')==STATUS_SHA and sha(ORIGIN/'model.hbm')==HBM_SHA and sha(ORIGIN/'s256/converted.bc')==BC_SHA and sha(ORIGIN/'s1/model.hbo')==AR_HBO_SHA and sha(SDK/'hbdk4/compiler/apis.py')==API_SHA
 old=read(ORIGIN/'status.json');assert old['status']=='compiled_original_group_shared_profiles_bpu_only' and old['bpu_only'] and old['first']==18 and old['last']==26 and old['layer_count']==9 and old['profile_optimization']=={'1':2,'256':0} and old['source_sha256']=='fafcbe8b4d9447ce10eb745f5c4ed1eba3c7edc267e5e96cd786f549a6ee5a8b' and old['recalibration_executed'] is False and old['weights_or_graph_changed'] is False and old['neural_cpu_or_gpu_production_fallback'] is False
 for row in old['profiles']:
  seq=row['sequence_capacity'];assert seq in [1,256] and row['status']=='compiled_hbo' and sha(ORIGIN/f's{seq}/converted.bc')==row['converted_bc_sha256'] and sha(ORIGIN/f's{seq}/model.hbo')==row['hbo_sha256'] and sha(ORIGIN/f's{seq}/ports.json')==row['ports_sha256']
 assert not out.exists();return old,holder,large,out
def worker():
 assert os.getpid()==os.getpgrp();old,holder,large,out=admit();out.mkdir();(out/'s1').mkdir();(out/'s256').mkdir();(out/'tmp').mkdir();os.environ['TMPDIR']=str(out/'tmp');os.chdir(out)
 r=dict(status='copying_exact_admitted_inputs_to_D',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),scope=__doc__,holder=holder,output_directory=str(out),output_windows='D:/codex-task-staging/ainvr-locateanything-w4/prefill-g18-o2-v187',origin_directory=str(ORIGIN),origin_status_sha256=STATUS_SHA,origin_hbm_sha256=HBM_SHA,prefill_bc_sha256=BC_SHA,unchanged_ar_hbo_sha256=AR_HBO_SHA,official_api_sha256=API_SHA,first=18,last=26,layer_count=9,profile_optimization={'1':2,'256':2},recalibration_executed=False,weights_or_graph_changed=False,AR_recompiled=False,compile_jobs=1,balance=100,max_l2m_size=0,overall_elapsed_cap_seconds=None,actual_board_verified=False,whole_model_verified=False,release_approved=False,fixture_pins={})
 status=out/'status.json';save(status,r)
 try:
  shutil.copyfile(ORIGIN/'s256/converted.bc',out/'s256/converted.bc');shutil.copyfile(ORIGIN/'s1/model.hbo',out/'s1/model.hbo');assert sha(out/'s256/converted.bc')==BC_SHA and sha(out/'s1/model.hbo')==AR_HBO_SHA
  for seq in [1,256]:
   for f in (ORIGIN/f's{seq}').rglob('*'):
    if f.is_file() and (f.suffix=='.npy' or f.name=='ports.json'):r['fixture_pins'][str(f.relative_to(ORIGIN))]=sha(f)
  assert len([k for k in r['fixture_pins'] if Path(k).name.startswith(('input-','compiler-'))])==328
  (out/'origin-status.json').write_bytes((ORIGIN/'status.json').read_bytes());save(status,r)
  for key in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[key]='1'
  sys.path.insert(0,str(SDK));from hbdk4.compiler import load,compile
  m=load(str(out/'s256/converted.bc'));assert len(m.functions)==1 and m.functions[0].name=='locate_official_qwen_group_18_26_s256';r['status']='compiling_same_bc_prefill_o2';save(status,r);begin=time.monotonic();compile(m,str(out/'s256/model.hbo'),march='nash-m',opt=2,jobs=1,balance=100,max_l2m_size=0,progress_bar=True);r['compile_seconds']=time.monotonic()-begin;del m;r['prefill_hbo_sha256']=sha(out/'s256/model.hbo');r['status']='linking_exact_AR_and_new_prefill_HBO';save(status,r)
  linker=SDK/'hbdk4/compiler/_mlir_libs/hbdk-lld';r['linker_sha256']=sha(linker);begin=time.monotonic();subprocess.run([str(linker),str(out/'s1/model.hbo'),str(out/'s256/model.hbo'),'-o',str(out/'model.hbm')],check=True);r['link_seconds']=time.monotonic()-begin
  tool=SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas';d=json.loads(subprocess.check_output([str(tool),'--json',str(out/'model.hbm')],text=True));assert {g['name'] for g in d['graphs']}=={'locate_official_qwen_group_18_26_s1','locate_official_qwen_group_18_26_s256'} and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs']);(out/'disas.json').write_text(json.dumps(d,indent=2)+'\n')
  assert sha(ORIGIN/'status.json')==STATUS_SHA and sha(out/'s256/converted.bc')==BC_SHA and sha(out/'s1/model.hbo')==AR_HBO_SHA and all(sha(ORIGIN/k)==pin for k,pin in r['fixture_pins'].items());r.update(status='compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified',hbm_sha256=sha(out/'model.hbm'),hbm_bytes=(out/'model.hbm').stat().st_size,disas_sha256=sha(out/'disas.json'),bpu_only=True)
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:r['finished']=time.time();save(status,r)
def guard(check):
 old,holder,large,out=admit()
 if check:print(json.dumps(dict(status='admitted_same_bc_prefill_g18_zero_compile_zero_neural_calls',origin_status_sha256=STATUS_SHA,BC_sha256=BC_SHA,unchanged_AR_HBO_sha256=AR_HBO_SHA,output_directory=str(out),holder_pid=holder['pid'],holder_start_ticks=holder['start_ticks'])));return
 assert not GUARD.exists()
 cgroup=Path('/sys/fs/cgroup/memory');limit=int((cgroup/'memory.limit_in_bytes').read_text());assert limit==27917287424 and int((cgroup/'memory.usage_in_bytes').read_text())<=limit-6*1024**3,'Insufficient initial compiler headroom'
 lease=(STAGE/'locate-prefill-o2-compile.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 for p in Path('/proc').iterdir():
  if not p.name.isdigit() or int(p.name)==os.getpid():continue
  try:a=(p/'stat').read_text().rsplit(')',1)[1].split();args=(p/'cmdline').read_bytes().split(b'\0')
  except (FileNotFoundError,ProcessLookupError):continue
  assert not (a[0] not in ['Z','X'] and any(x.startswith((b'/work/official-llm-v1/compile_locateanything_',b'/work/official-llm-v1/link_locateanything_',b'/work/official-llm-v1/probe_locateanything_')) and x.endswith(b'.py') for x in args)),'Another owned compiler/linker or GPU oracle is already live'
 r=dict(status='checking',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),scope=__doc__,output_directory=str(out),output_windows='D:/codex-task-staging/ainvr-locateanything-w4/prefill-g18-o2-v187',holder=holder,overall_elapsed_cap_seconds=None,owned_group_rss_limit_bytes=12*1024**3,minimum_available_bytes=6*1024**3,minimum_C_compile_free_bytes=6*1024**3,minimum_C_fixed_link_free_bytes=4*1024**3,minimum_D_free_bytes=12*1024**3,maximum_group_rss_bytes=0);child=None;start=None
 def interrupted(*_):raise RuntimeError('Owned prefill compile guard interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  assert shutil.disk_usage(STAGE).free>7*1024**3 and shutil.disk_usage(large).free>r['minimum_D_free_bytes'] and int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024>r['minimum_available_bytes']
  with (STAGE/'official-w8-prefill-g18-o2-v187-worker.log').open('xb') as f:child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--worker'],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  start=ticks(child.pid);r.update(status='watching_owned_prefill_compile',worker_pid=child.pid,worker_start_ticks=start);save(GUARD,r);next_save=time.monotonic()+5
  while child.poll() is None:
   rss=0
   for p in Path('/proc').iterdir():
    if not p.name.isdigit():continue
    try:a=(p/'stat').read_text().rsplit(')',1)[1].split()
    except (FileNotFoundError,ProcessLookupError):continue
    if int(a[2])==child.pid and a[0] not in ['Z','X']:rss+=int(a[21])*os.sysconf('SC_PAGE_SIZE')
   phase=read(out/'status.json')['status'] if (out/'status.json').exists() else 'worker_admission';Cmin=r['minimum_C_fixed_link_free_bytes'] if phase in ['linking_exact_AR_and_new_prefill_HBO','compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified'] else r['minimum_C_compile_free_bytes'];available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;cfree=shutil.disk_usage(STAGE).free;dfree=shutil.disk_usage(large).free
   assert ticks(holder['pid'])==holder['start_ticks'];r.update(checked=time.time(),worker_phase=phase,group_rss_bytes=rss,maximum_group_rss_bytes=max(r['maximum_group_rss_bytes'],rss),available_bytes=available,C_task_free_bytes=cfree,D_task_free_bytes=dfree,current_minimum_C_free_bytes=Cmin);assert rss<=r['owned_group_rss_limit_bytes'] and available>=r['minimum_available_bytes'] and cfree>=Cmin and dfree>=r['minimum_D_free_bytes'],'Owned prefill compile resource bound reached'
   if time.monotonic()>=next_save:save(GUARD,r);next_save=time.monotonic()+5
   time.sleep(1)
  r['worker_returncode']=child.returncode;assert child.returncode==0;s=read(out/'status.json');assert s['status']=='compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified' and sha(out/'model.hbm')==s['hbm_sha256'] and sha(out/'s1/model.hbo')==AR_HBO_SHA;r.update(status='completed_same_bc_prefill_g18_candidate_not_board_qualified',worker_status_sha256=sha(out/'status.json'),hbm_sha256=s['hbm_sha256'])
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(GUARD,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','error']}));assert r['status']=='completed_same_bc_prefill_g18_candidate_not_board_qualified'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.worker:worker()
 else:guard(a.check_only)
