"""Decode one verified S100P hardware trace with the matching official compiler.

Host-only analysis;no model compilation,inference or production changes.
"""
from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess,time,traceback
STAGE=Path('/work/official-llm-v1');SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python/hbdk4/compiler');HBM=Path('/opt/locate-official-qwen-group-0-8-w8a16-ar2-pref0-v1/model.hbm');TRACE=STAGE/'official-w8-g0-ar-hwperf-v125.bin';PROOF=STAGE/'locateanything-official-hwperf-trace-v125.json';OUT=STAGE/'official-w8-g0-ar-hwperf-analysis-v126';REPORT=STAGE/'official-w8-g0-ar-hwperf-analysis-v126.json'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(r):
 p=REPORT.with_name('.'+REPORT.name+'.incoming');p.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');p.replace(REPORT)
def main():
 assert not OUT.exists() and not REPORT.exists()
 assert sha(HBM)=='c5d4205c62bae529c86635c1f816b5c7e936f59ba6cd3aec674e685ef9aec399'
 assert sha(TRACE)=='56062716190ff5bd7b9b1d95b68fa8018176b673554b02a667a0e3286fc98226'
 proof=json.loads(PROOF.read_text());assert proof['status']=='completed_trace_and_official_allequal_reference_check' and proof['trace_sha256']==sha(TRACE) and proof['compiler_byte_exact_verified'] and proof['production_unchanged_and_fresh']
 tool=SDK/'_mlir_libs/hbdk4-perf';assert sha(tool)=='e755084568cb9c4b9ee45ee630d205ab3e8a78cb3e7ed5b0bcb8b467d355f561'
 OUT.mkdir();r=dict(status='analyzing_real_hardware_trace',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],hbm_sha256=sha(HBM),trace_sha256=sha(TRACE),hardware_proof_sha256=sha(PROOF),official_tool_sha256=sha(tool),whole_model_verified=False,production_changes=False,maximum_owned_rss_bytes=0,overall_elapsed_cap_seconds=None);save(r);child=None;start=None
 try:
  cmd=[str(tool),str(HBM),'--hwperf',str(TRACE),'-o',str(OUT)];r['command']=cmd
  with (OUT/'tool.log').open('xb') as log:child=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  start=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19];r.update(child_pid=child.pid,child_start_ticks=start);save(r)
  while child.poll() is None:
   memory=0
   for p in Path('/proc').iterdir():
    if not p.name.isdigit():continue
    try:
     if os.getpgid(int(p.name))!=child.pid:continue
     lines=(p/'status').read_text().splitlines();memory+=int(next((x.split()[1] for x in lines if x.startswith('VmRSS:')),'0'))*1024
    except (FileNotFoundError,ProcessLookupError):pass
   r['maximum_owned_rss_bytes']=max(r['maximum_owned_rss_bytes'],memory);assert memory<3*1024**3
   available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;assert available>6*1024**3;assert shutil.disk_usage(STAGE).free>6*1024**3;save(r);time.sleep(1)
  r['returncode']=child.returncode;r['outputs']={str(p.relative_to(OUT)):dict(bytes=p.stat().st_size,sha256=sha(p)) for p in OUT.rglob('*') if p.is_file()};assert child.returncode==0;assert list(OUT.glob('*.json'));r['status']='completed_official_hwperf_analysis_pending_interpretation'
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19]==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(r)
 print(json.dumps({k:r.get(k) for k in ['status','returncode','error']}));assert r['status']=='completed_official_hwperf_analysis_pending_interpretation'
if __name__=='__main__':main()
