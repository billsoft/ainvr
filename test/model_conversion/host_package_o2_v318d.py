"""v318d host-side packager:O2 HBM/disas from D: + v312 fixtures/ports streamed from the container. Zero neural calls."""
import json,hashlib,shutil,subprocess,sys,time,os
from pathlib import Path
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
A=int(sys.argv[1]);B=A+8;C='ainvr-locateanything-w4-20261014'
O2=Path(rf'D:\codex-task-staging\ainvr-locateanything-w4\o2-v318\locate-text-gptq8-group-{A}-{B}-o2-v318')
DST=Path(rf'D:\codex-task-staging\ainvr-locateanything-w4\o2-v318\packages\text-gptq8-group-{A}-{B}-o2-v318-board-package')
s2=json.loads((O2/'status.json').read_text());assert s2['status']=='compiled_same_bc_o2_bpu_only_not_board_qualified' and sha(O2/'model.hbm')==s2['hbm_sha256']
assert not DST.exists();DST.mkdir(parents=True);shutil.copy2(O2/'model.hbm',DST/'model.hbm');shutil.copy2(O2/'disas.json',DST/'disas.json')
env=dict(os.environ,MSYS_NO_PATHCONV='1');src=f'/opt/locate-official-qwen-group-gptq8-{A}-{B}-v312'
s0=json.loads(subprocess.check_output(['docker','exec',C,'cat',f'{src}/status.json'],env=env));assert s2['source_o0_hbm_sha256']==s0['hbm_sha256']
lst=subprocess.check_output(['docker','exec',C,'bash','-c',f"cd {src} && ls -d s1/case-*/input-*.npy s1/case-*/compiler-*.npy s256/case-*/input-*.npy s256/case-*/compiler-*.npy s1/ports.json s256/ports.json"],env=env,text=True).split()
tar=subprocess.Popen(['docker','exec',C,'tar','cf','-','-C',src]+lst,stdout=subprocess.PIPE,env=env)
subprocess.run([r'C:\Windows\System32\tar.exe','xf','-','-C',DST.as_posix()],stdin=tar.stdout,check=True,env=env);tar.wait();assert tar.returncode==0
profiles=[]
for seq in [1,256]:
 ports=json.loads((DST/f's{seq}'/'ports.json').read_text());cases=sorted(x.name for x in (DST/f's{seq}').glob('case-*'));(DST/f's{seq}'/'ports.json').unlink()
 profiles.append(dict(sequence=seq,name=ports['name'],inputs=ports['inputs'],outputs=ports['outputs'],cases=cases))
files={p.relative_to(DST).as_posix():dict(bytes=p.stat().st_size,sha256=sha(p)) for p in sorted(DST.rglob('*')) if p.is_file()}
m=dict(schema='locateanything_text_gptq8_group_o2_board_v318',first=A,last=B,bpu_only=True,o2_hbm_sha256=s2['hbm_sha256'],o0_hbm_sha256=s0['hbm_sha256'],o2_status_sha256=sha(O2/'status.json'),profiles=profiles,files=files,created=time.time(),release_approved=False,packager='host_package_o2_v318d.py')
(DST/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');print(json.dumps({f'{A}-{B}':sha(DST/'manifest.json'),'files':len(files)}))
