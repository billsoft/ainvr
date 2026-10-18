# v132 changes only fixed-HBO linking C reserve to4GiB and new output/report paths.
# Original compiler and failed link guard outputs are retained unchanged.
"""Recover only official linking from the completed saved balance2 HBO.

The original disk-reserve guard failure stays immutable. No compilation,
calibration,weight or graph changes. New output/TMPDIR use owned D staging via
an identity-checked held directory descriptor;no bind mount was created.
"""
from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess,time,traceback
STAGE=Path('/work/official-llm-v1');SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python/hbdk4/compiler');ORIGINAL=Path('/opt/locate-official-qwen-group-0-8-w8a16-ar2-balance2-v119');REPORT=STAGE/'official-w8-ar-balance2-link-v132.json'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(r):
 p=REPORT.with_name('.'+REPORT.name+'.incoming');p.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');p.replace(REPORT)
def main():
 assert not REPORT.exists();holder=read(STAGE/'d-task-storage-v131-holder.json');assert holder['status']=='holding_task_directory_fd' and holder['pid']==672834 and holder['start_ticks']==ticks(672834)=='19235986' and holder['source_sha256']=='e9b1b6d3986c597a54f4e36f2bba54c8c613cfeed917ab34abcbfca3a4dce365'
 assert b'/work/official-llm-v1/hold_locateanything_task_directory_v131.py' in Path('/proc/672834/cmdline').read_bytes().split(b'\0');large=Path(holder['access_path']);assert read(large/'.ainvr-task-owner.json')['thread']=='01a11f62-f8a4-7801-8cd1-52fbcea37056'
 guard=read(STAGE/'official-w8-ar-balance2-v119-guard.json');source=read(ORIGINAL/'status.json');assert guard['status']=='failed' and guard['finished'] and 'Owned compile resource bound reached' in guard['error'] and guard['staging_free_bytes']<guard['minimum_staging_free_bytes'] and guard['group_rss_bytes']<guard['owned_group_rss_limit_bytes'] and guard['available_bytes']>guard['minimum_available_bytes']
 assert source['status']=='linking_single_profile' and source['source_sha256']==guard['source_sha256']=='f43ee914f822b5c691f716734aefe6f2f0eb7d70c6d9471c27e8166b92ac636c' and source['compile_seconds']>0 and source['balance']==2 and source['optimization']==2 and source['max_l2m_size']==0 and not source['weights_or_graph_changed'] and not source['recalibration']
 assert sha(ORIGINAL/'s1/model.hbo')==source['hbo_sha256']=='3f398078581364d150f044b35569a462369c7531516dbbb7c32bb68dd653ec54' and sha(ORIGINAL/'s1/converted.bc')=='e309660223f49207b2d9455d8dce098d95016ed5dd9e4b5a8d869a51e3e467f6'
 for p in Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:a=(p/'stat').read_text().rsplit(')',1)[1].split()
  except (FileNotFoundError,ProcessLookupError):continue
  assert not (int(a[2])==672655 and a[0] not in ['Z','X']),'Original owned compile/link group still live'
 assert sha(SDK/'apis.py')=='c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846'
 out=large/'balance2-link-v132';assert not out.exists();assert shutil.disk_usage(STAGE).free>7*1024**3 and shutil.disk_usage(large).free>10*1024**3;out.mkdir();tmp=out/'tmp';tmp.mkdir();tool=SDK/'_mlir_libs/hbdk-lld';r=dict(status='linking_exact_saved_hbo_on_D_task_storage',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),scope=__doc__,source_compile_status_sha256=sha(ORIGINAL/'status.json'),source_failed_guard_sha256=sha(STAGE/'official-w8-ar-balance2-v119-guard.json'),source_hbo_sha256=source['hbo_sha256'],converted_bc_sha256=source['converted_bc_sha256'],original_compiler_source_sha256=source['source_sha256'],source_compile_seconds=source['compile_seconds'],holder=holder,output_directory=str(out),output_windows='D:/codex-task-staging/ainvr-locateanything-w4/balance2-link-v132',official_linker_sha256=sha(tool),compilation_reexecuted=False,recalibration=False,weights_or_graph_changed=False,overall_elapsed_cap_seconds=None,maximum_owned_rss_bytes=0,minimum_C_task_free_bytes=4*1024**3,minimum_D_task_free_bytes=10*1024**3,prior_link_attempt_sha256=sha(STAGE/'official-w8-ar-balance2-link-v131.json'),C_policy_reason='Fixed completed0.712GB HBO link only;prior process used transientCspace then released it,exact allocation mechanism unproven;Doutput/TMPDIR preserved and4GiB C reserve enforced.Compile guard6GiB policy unchanged.',whole_model_verified=False,actual_board_verified=False,release_approved=False);child=None;start=None;save(r)
 def stop(*_):raise RuntimeError('Owned link recovery interrupted')
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGHUP,stop)
 try:
  env=dict(os.environ,TMPDIR=str(tmp));cmd=[str(tool),str(ORIGINAL/'s1/model.hbo'),'-o',str(out/'model.hbm')];r['command']=cmd
  with (out/'linker.log').open('xb') as log:child=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,env=env,start_new_session=True)
  start=ticks(child.pid);r.update(child_pid=child.pid,child_start_ticks=start);save(r)
  while child.poll() is None:
   rss=0
   for p in Path('/proc').iterdir():
    if not p.name.isdigit():continue
    try:a=(p/'stat').read_text().rsplit(')',1)[1].split()
    except (FileNotFoundError,ProcessLookupError):continue
    if int(a[2])==child.pid and a[0] not in ['Z','X']:rss+=int(a[21])*os.sysconf('SC_PAGE_SIZE')
   r['maximum_owned_rss_bytes']=max(r['maximum_owned_rss_bytes'],rss);r['C_task_free_bytes']=shutil.disk_usage(STAGE).free;r['D_task_free_bytes']=shutil.disk_usage(large).free;r['available_bytes']=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
   assert rss<12*1024**3 and r['C_task_free_bytes']>=4*1024**3 and r['D_task_free_bytes']>=10*1024**3 and r['available_bytes']>=6*1024**3;assert ticks(672834)==holder['start_ticks'];save(r);time.sleep(.25)
  r['linker_returncode']=child.returncode;assert child.returncode==0
  tool=SDK/'_mlir_libs/hbrt4-disas';d=json.loads(subprocess.check_output([str(tool),'--json',str(out/'model.hbm')],text=True));assert len(d['graphs'])==1 and d['graphs'][0]['name']=='locate_official_qwen_group_0_8_s1' and all(n['device']=='DEVICE_CATEGORY_BPU' for n in d['graphs'][0]['nodes']);(out/'disas.json').write_text(json.dumps(d,indent=2)+'\n');assert sha(ORIGINAL/'s1/model.hbo')==r['source_hbo_sha256'] and sha(ORIGINAL/'status.json')==r['source_compile_status_sha256'] and sha(STAGE/'official-w8-ar-balance2-v119-guard.json')==r['source_failed_guard_sha256']
  r.update(status='recovered_same_saved_hbo_linked_not_board_qualified',hbm_sha256=sha(out/'model.hbm'),hbm_bytes=(out/'model.hbm').stat().st_size,disas_sha256=sha(out/'disas.json'),bpu_only=True)
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(r);(out/'recovery-status.json').write_text(json.dumps(r,indent=2,allow_nan=False)+'\n')
 print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','hbm_bytes','compilation_reexecuted','error']}));assert r['status']=='recovered_same_saved_hbo_linked_not_board_qualified'
if __name__=='__main__':main()
