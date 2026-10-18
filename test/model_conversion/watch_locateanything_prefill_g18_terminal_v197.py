"""Exact group18 guard-exit observation;no progress polling or automatic restart."""
from pathlib import Path
import os,select,time,json,hashlib,traceback
B=Path('/work/official-llm-v1');OUT=B/'official-w8-prefill-g18-terminal-v197.json'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for x in iter(lambda:f.read(4194304),b''):h.update(x)
 return h.hexdigest()
def save(r):
 p=OUT.with_name(OUT.name+'.incoming');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT)
def main():
 assert not OUT.exists();s=B/'compile_locateanything_w8_prefill_g18_v187.py';assert sha(s)=='5272bbdb1a33ac83ed3e38e4b5f40402e802c16a7f259a3968ad4936a8931127'
 p=Path('/proc/673205/stat');a=p.read_text().rsplit(')',1)[1].split();assert a[19]=='20248845'
 r=dict(status='waiting_exact_group18_compile_guard_pidfd',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=Path(f'/proc/{os.getpid()}/stat').read_text().rsplit(')',1)[1].split()[19],guard_pid=673205,guard_start_ticks='20248845',compile_restarted=False,actual_board_verified=False,release_approved=False)
 try:
  save(r)
  if a[0] not in ['Z','X']:
   assert str(s).encode() in Path('/proc/673205/cmdline').read_bytes().split(b'\0')
   fd=os.pidfd_open(673205);poll=select.poll();poll.register(fd,select.POLLIN)
   try:poll.poll()
   finally:os.close(fd)
  g=B/'official-w8-prefill-g18-o2-v187-guard.json';v=json.loads(g.read_text());r['terminal_guard']=v;r['terminal_guard_sha256']=sha(g)
  assert v['source_sha256']==sha(s) and v['pid']==673205 and v['start_ticks']=='20248845'
  assert v['status']=='completed_same_bc_prefill_g18_candidate_not_board_qualified' and v['worker_returncode']==0
  import sys;sys.path.insert(0,str(B));from compile_locateanything_w8_prefill_g18_v187 import storage,BC_SHA,AR_HBO_SHA
  _,_,root=storage();raw=json.loads((root/'status.json').read_text());assert sha(root/'status.json')==v['worker_status_sha256']
  assert raw['first']==18 and raw['last']==26 and raw['prefill_bc_sha256']==BC_SHA and raw['unchanged_ar_hbo_sha256']==AR_HBO_SHA
  assert sha(root/'s256/converted.bc')==BC_SHA and sha(root/'s1/model.hbo')==AR_HBO_SHA
  assert sha(root/'model.hbm')==raw['hbm_sha256']==v['hbm_sha256']
  d=json.loads((root/'disas.json').read_text());assert {g['name'] for g in d['graphs']}=={'locate_official_qwen_group_18_26_s1','locate_official_qwen_group_18_26_s256'} and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs'])
  r.update(status='terminal_compiled_same_bc_group18_not_board_qualified',hbm_sha256=raw['hbm_sha256'],worker_status_sha256=sha(root/'status.json'),disas_sha256=sha(root/'disas.json'))
 except BaseException:r.update(status='failed_terminal_observation_no_restart',error=traceback.format_exc())
 finally:r['finished']=time.time();save(r)
if __name__=='__main__':main()
