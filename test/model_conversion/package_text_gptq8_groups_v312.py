"""Package the four v312 GPTQ INT8 decoder group builds (opt0) for board evaluation. Zero neural calls."""
from pathlib import Path
import json,hashlib,shutil,sys,time
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
out={}
for a in [0,9,18,27]:
 b=a+8;src=Path(f'/opt/locate-official-qwen-group-gptq8-{a}-{b}-v312');s=json.loads((src/'status.json').read_text())
 assert s['status'].startswith('compiled') and s.get('bpu_only') is True and sha(src/'model.hbm')==s['hbm_sha256'],(a,s['status'])
 dst=Path(f'/opt/text-gptq8-packages-v312/text-gptq8-group-{a}-{b}-o0-v312-board-package');dst.parent.mkdir(exist_ok=True);assert not dst.exists();dst.mkdir()
 shutil.copy2(src/'model.hbm',dst/'model.hbm');shutil.copy2(src/'disas.json',dst/'disas.json');profiles=[]
 for seq in [1,256]:
  ports=json.loads((src/f's{seq}'/'ports.json').read_text());profiles.append(dict(sequence=seq,name=ports['name'],inputs=ports['inputs'],outputs=ports['outputs']))
 files={n:dict(bytes=(dst/n).stat().st_size,sha256=sha(dst/n)) for n in ['model.hbm','disas.json']}
 m=dict(schema='locateanything_text_gptq8_group_board_v312',first=a,last=b,bpu_only=True,source_status_sha256=sha(src/'status.json'),gptq_source='/opt/locate-text-gptq-row8-v307',profiles=profiles,files=files,created=time.time(),release_approved=False)
 (dst/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');out[f'{a}-{b}']=sha(dst/'manifest.json')
print(json.dumps(out))
