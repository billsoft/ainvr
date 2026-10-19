"""v318c:link the already compiled O2 s1/s256 HBOs of one group into /work (host disk), then finalize its status.

Used for groups whose v318 compile finished both profiles but whose link was interrupted by the C-disk guard.
"""
from pathlib import Path
import os,sys,json,time,hashlib,subprocess,argparse
SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ap=argparse.ArgumentParser();ap.add_argument('--first',type=int,required=True,choices=[0,9]);a=ap.parse_args()
A,B=a.first,a.first+8;SRC=Path(f'/opt/locate-text-gptq8-group-{A}-{B}-o2-v318');OUT=Path(f'/work/official-llm-v1/o2-v318/locate-text-gptq8-group-{A}-{B}-o2-v318')
s=json.loads((SRC/'status.json').read_text());assert s['status']=='linking' and [p['status'] for p in s['profiles']]==['compiled_hbo','compiled_hbo']
for p in s['profiles']:assert sha(SRC/f"s{p['sequence']}"/'model.hbo')==p['hbo_sha256']
assert not OUT.exists();OUT.mkdir(parents=True)
subprocess.run([str(SDK/'hbdk4/compiler/_mlir_libs/hbdk-lld'),str(SRC/'s1/model.hbo'),str(SRC/'s256/model.hbo'),'-o',str(OUT/'model.hbm')],check=True)
d=json.loads(subprocess.check_output([str(SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas'),'--json',str(OUT/'model.hbm')],text=True))
assert {g['name'] for g in d['graphs']}=={p['name'] for p in s['profiles']} and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs'])
(OUT/'disas.json').write_text(json.dumps(d,indent=2)+'\n')
s.update(status='compiled_same_bc_o2_bpu_only_not_board_qualified',bpu_only=True,hbm_sha256=sha(OUT/'model.hbm'),hbm_bytes=(OUT/'model.hbm').stat().st_size,linked_by='link_text_gptq8_o2_v318c.py',link_note='original link interrupted by C-disk guard;relinked identical HBOs',finished=time.time())
(OUT/'status.json').write_text(json.dumps(s,indent=2)+'\n');print(json.dumps(dict(group=f'{A}-{B}',status=s['status'],hbm_sha256=s['hbm_sha256'])))
