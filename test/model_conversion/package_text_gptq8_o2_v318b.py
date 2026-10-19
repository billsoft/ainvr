"""v318b:package one same-BC O2 GPTQ group with the v312 compiler-reference fixtures (inputs + compiler outputs).

The fixtures come from the identical converted.bc, so they are the bitwise target for O0 and O2 alike.
Usage: --first N --dst-root DIR. Zero neural calls.
"""
from pathlib import Path
import json,hashlib,shutil,argparse,time
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ap=argparse.ArgumentParser();ap.add_argument('--first',type=int,required=True,choices=[0,9,18,27]);ap.add_argument('--dst-root',type=Path,required=True);a=ap.parse_args()
A,B=a.first,a.first+8;O0=Path(f'/opt/locate-official-qwen-group-gptq8-{A}-{B}-v312')
O2=Path(f'/opt/locate-text-gptq8-group-{A}-{B}-o2-v318') if A in (0,9) else Path(f'/work/official-llm-v1/o2-v318/locate-text-gptq8-group-{A}-{B}-o2-v318')
s2=json.loads((O2/'status.json').read_text());assert s2['status']=='compiled_same_bc_o2_bpu_only_not_board_qualified' and sha(O2/'model.hbm')==s2['hbm_sha256']
s0=json.loads((O0/'status.json').read_text());assert s2['source_o0_hbm_sha256']==s0['hbm_sha256']
for p in s2['profiles']:assert p['converted_bc_sha256']==sha(O0/f"s{p['sequence']}"/'converted.bc')
dst=a.dst_root/f'text-gptq8-group-{A}-{B}-o2-v318-board-package';assert not dst.exists();dst.mkdir(parents=True)
shutil.copy2(O2/'model.hbm',dst/'model.hbm');shutil.copy2(O2/'disas.json',dst/'disas.json');profiles=[]
for seq in [1,256]:
 ports=json.loads((O0/f's{seq}'/'ports.json').read_text());cases=sorted(x.name for x in (O0/f's{seq}').glob('case-*'))
 for c in cases:
  (dst/f's{seq}'/c).mkdir(parents=True)
  for f in sorted((O0/f's{seq}'/c).glob('input-*.npy'))+sorted((O0/f's{seq}'/c).glob('compiler-*.npy')):shutil.copy2(f,dst/f's{seq}'/c/f.name)
 profiles.append(dict(sequence=seq,name=ports['name'],inputs=ports['inputs'],outputs=ports['outputs'],cases=cases))
files={str(p.relative_to(dst)):dict(bytes=p.stat().st_size,sha256=sha(p)) for p in sorted(dst.rglob('*')) if p.is_file()}
m=dict(schema='locateanything_text_gptq8_group_o2_board_v318',first=A,last=B,bpu_only=True,o2_hbm_sha256=s2['hbm_sha256'],o0_hbm_sha256=s0['hbm_sha256'],o2_status_sha256=sha(O2/'status.json'),profiles=profiles,files=files,created=time.time(),release_approved=False)
(dst/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');print(json.dumps({f'{A}-{B}':sha(dst/'manifest.json')}))
