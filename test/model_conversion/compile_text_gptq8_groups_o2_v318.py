"""v318:same converted-BC opt2 compile of one GPTQ INT8 decoder group (both AR1 and prefill256 profiles).

No export/calibration/graph/weight change versus the board-evaluated v312 opt0 group. compile(opt=2,
balance=100,max_l2m_size=0), link with hbdk-lld, disassemble and require all-BPU placement. Candidate only.
"""
from pathlib import Path
import os,sys,json,time,hashlib,subprocess,argparse,traceback
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
SDK=Path('/opt/locate-oellm-research-v1/sdk448-isolated/python');sys.path.insert(0,str(SDK))
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
ap=argparse.ArgumentParser();ap.add_argument('--first',type=int,required=True,choices=[0,9,18,27]);ap.add_argument('--jobs',type=int,default=4);a=ap.parse_args()
A,B=a.first,a.first+8;SRC=Path(f'/opt/locate-official-qwen-group-gptq8-{A}-{B}-v312')
# Groups 18/27:write outputs and compiler temp to the host bind mount (/work) so the Docker vhdx does not grow;
# the host moves finished outputs to D:. Groups 0/9 were already started with /opt outputs.
OUT=Path(f'/opt/locate-text-gptq8-group-{A}-{B}-o2-v318') if A in (0,9) else Path(f'/work/official-llm-v1/o2-v318/locate-text-gptq8-group-{A}-{B}-o2-v318')
if A not in (0,9):
 tmp=Path('/work/official-llm-v1/o2-v318/tmp');tmp.mkdir(parents=True,exist_ok=True);os.environ['TMPDIR']=str(tmp);import tempfile;tempfile.tempdir=str(tmp)
 OUT.parent.mkdir(parents=True,exist_ok=True)
assert os.getpgrp()==os.getpid() and not OUT.exists();OUT.mkdir()
r=dict(status='checking',started=time.time(),pid=os.getpid(),source_sha256=sha(__file__),scope=__doc__,first=A,last=B,jobs=a.jobs,compile_arguments=dict(march='nash-m',opt=2,balance=100,max_l2m_size=0),profiles=[])
def persist():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
persist()
try:
 s=json.loads((SRC/'status.json').read_text());assert s['status']=='compiled_original_group_shared_profiles_bpu_only' and s['bpu_only'];r['source_status_sha256']=sha(SRC/'status.json');r['source_o0_hbm_sha256']=s['hbm_sha256']
 from hbdk4.compiler import load,compile
 hbos=[]
 for seq in [1,256]:
  bc=SRC/f's{seq}'/'converted.bc';d=OUT/f's{seq}';d.mkdir();e=dict(sequence=seq,converted_bc_sha256=sha(bc),status='compiling');r['profiles'].append(e);r['status']=f'compiling_s{seq}';persist()
  m=load(str(bc));assert len(m.functions)==1;e['name']=m.functions[0].name;t=time.monotonic()
  compile(m,str(d/'model.hbo'),march='nash-m',opt=2,jobs=a.jobs,balance=100,max_l2m_size=0,progress_bar=False)
  e.update(status='compiled_hbo',compile_seconds=time.monotonic()-t,hbo_sha256=sha(d/'model.hbo'));hbos.append(d/'model.hbo');del m;persist()
 r['status']='linking';persist();subprocess.run([str(SDK/'hbdk4/compiler/_mlir_libs/hbdk-lld')]+[str(x) for x in hbos]+['-o',str(OUT/'model.hbm')],check=True)
 d=json.loads(subprocess.check_output([str(SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas'),'--json',str(OUT/'model.hbm')],text=True))
 assert {g['name'] for g in d['graphs']}=={e['name'] for e in r['profiles']} and all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs'])
 (OUT/'disas.json').write_text(json.dumps(d,indent=2)+'\n')
 r.update(status='compiled_same_bc_o2_bpu_only_not_board_qualified',bpu_only=True,hbm_sha256=sha(OUT/'model.hbm'),hbm_bytes=(OUT/'model.hbm').stat().st_size)
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','error']}))
