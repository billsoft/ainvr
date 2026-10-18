"""Wait for the exact existing compile guard with pidfd;never restart or poll progress."""
from pathlib import Path
import hashlib,json,os,select,signal,time,traceback
STAGE=Path('/work/official-llm-v1');REPORT=STAGE/'official-w8-prefill-g9-terminal-v145.json';GUARD=STAGE/'official-w8-prefill-g9-o2-v141-guard.json';SOURCE=STAGE/'compile_locateanything_w8_prefill_g9_v141.py'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def read(p):return json.loads(Path(p).read_text())
def save(r):
 t=REPORT.with_name('.'+REPORT.name+'.incoming');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(REPORT)
def main():
 assert not REPORT.exists();launch=read(STAGE/'official-w8-prefill-g9-o2-v141-launch.json');assert launch['pid']==672931 and launch['start_ticks']=='19545538' and launch['source_sha256']==sha(SOURCE)=='8f3d82f5ed235f5e7377c4215a070a9559981c93ce4380d4ae6933dcba6a0fbc';r=dict(status='opening_exact_compile_guard_pidfd',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],compile_launch=launch,compile_restarted=False,neural_calls=0,actual_board_verified=False,release_approved=False);fd=None;save(r)
 def interrupted(*_):raise RuntimeError('Only terminal observer interrupted;compile group left unchanged')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  pid=launch['pid'];proc=Path(f'/proc/{pid}')
  if proc.exists():
   assert (proc/'stat').read_text().rsplit(')',1)[1].split()[19]==launch['start_ticks'] and str(SOURCE).encode() in (proc/'cmdline').read_bytes().split(b'\0');fd=os.pidfd_open(pid);r['status']='waiting_exact_compile_guard_pidfd';save(r)
   while not select.select([fd],[],[],45)[0]:pass
  g=read(GUARD);assert g['pid']==launch['pid'] and g['start_ticks']==launch['start_ticks'] and g['source_sha256']==launch['source_sha256'] and g['finished'];r.update(terminal_guard=g,terminal_guard_sha256=sha(GUARD))
  if g['status']!='completed_same_bc_prefill_g9_candidate_not_board_qualified':r['status']='compile_guard_failed_not_restarted';raise RuntimeError('Original guard is terminal without compiled candidate;failure retained')
  holder=read(STAGE/'d-task-storage-v131-holder.json');assert Path(f"/proc/{holder['pid']}/stat").read_text().rsplit(')',1)[1].split()[19]==holder['start_ticks']=='19235986';out=Path(g['output_directory']);s=read(out/'status.json');assert sha(out/'status.json')==g['worker_status_sha256'] and s['status']=='compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified' and s['bpu_only'] and sha(out/'model.hbm')==s['hbm_sha256']==g['hbm_sha256'] and sha(out/'s1/model.hbo')==s['unchanged_ar_hbo_sha256']=='3095ffa0adbeac5c7e9c9c4228cd7aca120bcfecb6f0c3cc3c33f8297095807c' and sha(out/'s256/converted.bc')==s['prefill_bc_sha256']=='a52474d1e5bbe69b72d84e80db57e751f78c5a01688ab9af3898cbafe15b6317';d=read(out/'disas.json');assert sha(out/'disas.json')==s['disas_sha256'] and len(d['graphs'])==2 and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs'])
  r.update(status='terminal_compiled_same_bc_prefill_candidate_not_board_qualified',worker_status_sha256=sha(out/'status.json'),hbm_sha256=s['hbm_sha256'],hbm_bytes=s['hbm_bytes'],disas_sha256=s['disas_sha256'],compile_seconds=s['compile_seconds'],link_seconds=s['link_seconds'],fixture_pins=s['fixture_pins'],whole_model_verified=False)
 except BaseException:
  if r['status']!='compile_guard_failed_not_restarted':r['status']='observer_failed_compile_not_modified'
  r['error']=traceback.format_exc()
 finally:
  if fd is not None:os.close(fd)
  r['finished']=time.time();save(r)
 print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','error']}));assert r['status']=='terminal_compiled_same_bc_prefill_candidate_not_board_qualified'
if __name__=='__main__':main()
