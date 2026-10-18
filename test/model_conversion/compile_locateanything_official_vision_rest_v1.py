"""Bounded-resource two-worker completion of native vision blocks4..26;no elapsed compile cap."""
from pathlib import Path
import os,json,time,hashlib,subprocess,signal,traceback
BASE=Path('/work/official-llm-v1');SOURCE=Path('/work/build_locateanything_official_moonvit_block_probe_v3.py');SOURCE_SHA='8072943d4b8617804744a95ce85eb548f9f5db90fdf177abc933be6c3fea76a8';GUARD=Path('/work/guard_locateanything_owned_resources_v3.py');ROOT=Path('/opt/locate-official-vision-rest-v1')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert os.getpgrp()==os.getpid() and sha(SOURCE)==SOURCE_SHA and not ROOT.exists();proof=BASE/'official-vision-prefix4-q8-v1-board-package-guard-v1.json';assert sha(proof)=='f9ef4dedf17ffe3e62c9a302aa242b6928a0f51c3b26ec0da13b720ab3de3a87';g=json.loads(proof.read_text());assert g['status']=='completed' and g['production_unchanged_and_fresh'] and g['hardware']['board_calls']==80 and g['hardware']['all_outputs_compiler_bitwise_exact'] and g['hardware']['all_models_released'];assert len(g['hardware']['compiler_chain_native_regression'])==18 and max(x['stages'][-1]['compiler_chain_vs_original_native_bf16']['rel_l2'] for x in g['hardware']['compiler_chain_native_regression'])<.02
stages=list(range(4,27));assert all(not Path(f'/opt/locate-official-moonvit-block{i}-w8-v3').exists() for i in stages);ROOT.mkdir();r=dict(status='running',started=time.time(),pid=os.getpid(),source_sha256=sha(__file__),builder_sha256=SOURCE_SHA,prefix_board_guard_sha256=sha(proof),concurrency=2,maximum_compile_seconds=None,pending=list(stages),active=[],components=[],whole_model_verified=False,release_approved=False);active={};env=dict(os.environ,CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',OPENBLAS_NUM_THREADS='2')
def persist():
 p=ROOT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(ROOT/'status.json')
def available():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
def launch(stage):
 assert sha(SOURCE)==SOURCE_SHA;name=f'official-moonvit-block{stage}-w8-v3';out=Path('/opt/locate-'+name);assert not out.exists();cmd=['python3','-u',str(SOURCE),'--stage',str(stage)];child=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=open(BASE/(name+'.log'),'xb'),stderr=subprocess.STDOUT,env=env,start_new_session=True);ticks=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19];guardcmd=['python3','-u',str(GUARD),'--pid',str(child.pid),'--start-ticks',ticks,'--source',str(SOURCE),'--source-sha256',SOURCE_SHA,'--minimum-vm-available-kb','8388608','--maximum-group-rss-kb','4194304','--root',str(out),'--report','/work/'+name+'-guard.json'];guard=subprocess.Popen(guardcmd,stdin=subprocess.DEVNULL,stdout=open(BASE/(name+'-guard.log'),'xb'),stderr=subprocess.STDOUT,start_new_session=True);item=dict(stage=stage,pid=child.pid,start_ticks=ticks,guard_pid=guard.pid,root=str(out),started=time.time());active[stage]=(child,item);q=BASE/(name+'-launch.json');assert not q.exists();q.write_text(json.dumps(dict(item,source_sha256=SOURCE_SHA,command=cmd,coordinator_pid=os.getpid(),maximum_compile_seconds=None),indent=2)+chr(10))
def stop(child,item):
 if child.poll() is not None:return
 p=Path('/proc')/str(child.pid);parts=(p/'stat').read_text().rsplit(')',1)[1].split();assert parts[19]==item['start_ticks'] and os.getpgid(child.pid)==child.pid and str(SOURCE).encode() in (p/'cmdline').read_bytes().split(bytes([0]));os.killpg(child.pid,signal.SIGTERM)
 try:child.wait(timeout=10)
 except subprocess.TimeoutExpired:
  assert (p/'stat').read_text().rsplit(')',1)[1].split()[19]==item['start_ticks'];os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
def interrupted(*_):raise RuntimeError('Owned vision completion coordinator interrupted')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted);persist()
try:
 while r['pending'] or active:
  for stage,(child,item) in list(active.items()):
   if child.poll() is None:continue
   p=Path(item['root'])/'status.json';s=json.loads(p.read_text()) if p.exists() else {};guardfile=Path('/work')/(f'official-moonvit-block{stage}-w8-v3-guard.json');guard=json.loads(guardfile.read_text()) if guardfile.exists() else {};record=dict(item,returncode=child.returncode,status=s.get('status'),builder_report_sha256=sha(p) if p.exists() else None,guard_status=guard.get('status'),hbm_sha256=s.get('hbm_sha256'),hbm_bytes=s.get('hbm_bytes'));r['components'].append(record);del active[stage];persist();assert child.returncode==0 and s['status']=='compiled_bpu_only' and s['bpu_only'] and s['stage']==stage and s['source_sha256']==SOURCE_SHA and sha(Path(item['root'])/'model.hbm')==s['hbm_sha256'],('Component failed;preserved,do not restart unchanged',record,s.get('error'))
  while r['pending'] and len(active)<2 and available()>=12*1024**3:launch(r['pending'].pop(0))
  r['active']=[v for _,v in active.values()];r['checked']=time.time();r['host_available_bytes']=available();persist()
  if r['pending'] or active:time.sleep(5)
 assert len(r['components'])==23;r['status']='compiled_all_remaining_vision_blocks_bpu_only'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 for child,item in active.values():stop(child,item)
 r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','components','error']},indent=2))
