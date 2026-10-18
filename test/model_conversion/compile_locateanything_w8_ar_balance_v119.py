"""Single current W8 group AR1 O2 balance2 same-BC performance experiment.

No recalibration,graph/weight edits,production changes or elapsed compile cap.
Only one9-layer component is compiled before deciding on any broader cohort.
Official compile API documents balance2 as a cycles/DDR tradeoff;speed is unproven.
"""
from pathlib import Path
import argparse,hashlib,json,os,shutil,signal,subprocess,sys,time,traceback
STAGE=Path('/work/official-llm-v1');SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python');ORIGIN=Path('/opt/locate-official-qwen-group-0-8-w8a16-ar2-pref0-v1');OUT=Path('/opt/locate-official-qwen-group-0-8-w8a16-ar2-balance2-v119');GUARD=STAGE/'official-w8-ar-balance2-v119-guard.json'
STATUS_SHA='8660122afa575b7eef04ee20770f8bb9623785c12fafa19849584f4e1522b61f';BC_SHA='e309660223f49207b2d9455d8dce098d95016ed5dd9e4b5a8d869a51e3e467f6';API_SHA='c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name('.'+p.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def admit():
 assert sha(ORIGIN/'status.json')==STATUS_SHA and sha(ORIGIN/'s1/converted.bc')==BC_SHA and sha(SDK/'hbdk4/compiler/apis.py')==API_SHA
 old=json.loads((ORIGIN/'status.json').read_text());assert old['status']=='compiled_original_group_shared_profiles_bpu_only' and old['profile_optimization']=={'1':2,'256':0} and old['source_sha256']=='0bd6e6b75f652e3cf8bad289d09c724fc7a77e113a75ade32ebefec5226aab72' and old['optimized_profile_builder_sha256']=='e3ed149369d804c110271b1b71ecbbe879498595084d7010c69c65a30bca3702' and old['recalibration_executed'] is False and old['weights_or_graph_changed'] is False
 assert sha(ORIGIN/'model.hbm')=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399';return old

def worker():
 assert os.getpid()==os.getpgrp() and not OUT.exists();old=admit();OUT.mkdir();(OUT/'s1').mkdir();os.link(ORIGIN/'s1/converted.bc',OUT/'s1/converted.bc')
 r=dict(status='preparing',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),origin_status_sha256=STATUS_SHA,origin_hbm_sha256=old['hbm_sha256'],converted_bc_sha256=BC_SHA,official_api_sha256=API_SHA,optimization=2,balance=2,jobs=1,max_l2m_size=0,baseline_balance=100,first=0,last=8,sequence_capacity=1,recalibration=False,weights_or_graph_changed=False,neural_cpu_fallback=False,actual_board_verified=False,whole_model_verified=False,release_approved=False,overall_elapsed_cap_seconds=None)
 try:
  for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
  sys.path.insert(0,str(SDK));from hbdk4.compiler import load,compile,link
  from hbdk4.compiler.hbm import Hbo
  m=load(str(OUT/'s1/converted.bc'));r['status']='compiling_same_bc_ar_o2_balance2';save(OUT/'status.json',r);begin=time.monotonic();compile(m,str(OUT/'s1/model.hbo'),march='nash-m',opt=2,jobs=1,balance=2,max_l2m_size=0);r['compile_seconds']=time.monotonic()-begin;del m
  r['hbo_sha256']=sha(OUT/'s1/model.hbo');r['status']='linking_single_profile';save(OUT/'status.json',r);link([Hbo(str(OUT/'s1/model.hbo'))],str(OUT/'model.hbm'))
  tool=SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas';d=json.loads(subprocess.check_output([str(tool),'--json',str(OUT/'model.hbm')],text=True));assert len(d['graphs'])==1 and d['graphs'][0]['name']=='locate_official_qwen_group_0_8_s1';devices=[n['device'] for g in d['graphs'] for n in g['nodes']];assert devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices);(OUT/'disas.json').write_text(json.dumps(d,indent=2)+'\n')
  assert sha(ORIGIN/'status.json')==STATUS_SHA and sha(OUT/'s1/converted.bc')==BC_SHA;r.update(status='compiled_same_bc_ar_o2_balance2_not_board_qualified',hbm_sha256=sha(OUT/'model.hbm'),hbm_bytes=(OUT/'model.hbm').stat().st_size,bpu_only=True)
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:r['finished']=time.time();save(OUT/'status.json',r)

def guard():
 admit();assert not OUT.exists() and not GUARD.exists();r=dict(status='checking',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),overall_elapsed_cap_seconds=None,owned_group_rss_limit_bytes=12*1024**3,minimum_available_bytes=6*1024**3,minimum_staging_free_bytes=6*1024**3,scope=__doc__);child=None;start=None
 def stop(*_):raise RuntimeError('Owned compile guard interrupted')
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
 try:
  assert shutil.disk_usage(STAGE).free>8*1024**3 and int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024>6*1024**3
  with (STAGE/'official-w8-ar-balance2-v119-worker.log').open('xb') as f:child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--worker'],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  start=ticks(child.pid);r.update(status='watching_owned_compile',worker_pid=child.pid,worker_start_ticks=start,maximum_group_rss_bytes=0);save(GUARD,r);next_save=time.monotonic()+5
  while child.poll() is None:
   rss=0
   for p in Path('/proc').iterdir():
    if p.name.isdigit():
     try:a=(p/'stat').read_text().rsplit(')',1)[1].split()
     except (FileNotFoundError,ProcessLookupError):continue
     if int(a[2])==child.pid and a[0] not in ['Z','X']:rss+=int(a[21])*os.sysconf('SC_PAGE_SIZE')
   available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;free=shutil.disk_usage(STAGE).free
   r.update(checked=time.time(),group_rss_bytes=rss,maximum_group_rss_bytes=max(r['maximum_group_rss_bytes'],rss),available_bytes=available,staging_free_bytes=free)
   assert rss<=r['owned_group_rss_limit_bytes'] and available>=r['minimum_available_bytes'] and free>=r['minimum_staging_free_bytes'],'Owned compile resource bound reached'
   if time.monotonic()>=next_save:save(GUARD,r);next_save=time.monotonic()+5
   time.sleep(1)
  r['worker_returncode']=child.returncode;assert child.returncode==0;raw=json.loads((OUT/'status.json').read_text());assert raw['status']=='compiled_same_bc_ar_o2_balance2_not_board_qualified' and sha(OUT/'model.hbm')==raw['hbm_sha256'];r.update(status='completed_same_bc_candidate_not_board_qualified',worker_status_sha256=sha(OUT/'status.json'),hbm_sha256=raw['hbm_sha256'])
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(GUARD,r)
 print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','error']}));assert r['status']=='completed_same_bc_candidate_not_board_qualified'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');a=p.parse_args()
 if a.worker:worker()
 else:guard()
