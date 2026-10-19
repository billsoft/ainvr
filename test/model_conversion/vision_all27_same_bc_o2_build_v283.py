"""Same converted-BC opt2 recompilation of the 27 deployed MoonViT W8 blocks.

No export, calibration, graph or weight change. Only the HBDK optimization level
changes from the original opt0 (all other compile arguments stay defaults, jobs1).
Output is written to the D-drive task directory through the verified holder fd.
This produces a candidate only; it is not board-qualified or deployed.
"""
from pathlib import Path
import hashlib,json,os,sys,time,traceback
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');SDK=BASE/'sdk448-isolated/python'
sys.path.insert(0,str(SDK));sys.path.insert(0,str(BASE/'leap-source-overlay'))
HOLDER_PID=672834;HOLDER_TICKS='19235986'
ALL27=Path('/opt/locate-official-vision-all27-v1/status.json');ALL27_HBM='8020083c93cea4d1e3d00e7c316a8b268b05c598c2b4b601088e3a13c9961da1'
API_SHA='c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def headroom():
 cg=Path('/sys/fs/cgroup/memory');limit=int((cg/'memory.limit_in_bytes').read_text());used=int((cg/'memory.usage_in_bytes').read_text())
 avail=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
 return limit-used,avail
def main():
 assert ticks(HOLDER_PID)==HOLDER_TICKS;D=Path(f'/proc/{HOLDER_PID}/fd/9');assert json.loads((D/'.ainvr-task-owner.json').read_text())['scope'].startswith('AINVR LocateAnything')
 out=D/'vision-all27-o2-v283';assert not out.exists();out.mkdir();os.nice(19)
 r=dict(status='admitting',started=time.time(),pid=os.getpid(),start_ticks=ticks(os.getpid()),source_sha256=sha(__file__),scope=__doc__,
  output_windows='D:/codex-task-staging/ainvr-locateanything-w4/vision-all27-o2-v283',compile_arguments=dict(march='nash-m',opt=2,jobs=1,other='HBDK defaults identical to original opt0 build'),
  recalibration_executed=False,weights_or_graph_changed=False,board_qualified=False,release_approved=False,components=[])
 def persist():
  p=out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(out/'status.json')
 persist()
 try:
  assert sha(SDK/'hbdk4/compiler/apis.py')==API_SHA
  pins=json.loads(ALL27.read_text());assert pins['hbm_sha256']==ALL27_HBM and len(pins['components'])==27
  roots=[Path('/opt/locate-official-moonvit-block0-w8-v2')]+[Path(f'/opt/locate-official-moonvit-block{i}-w8-v3') for i in range(1,27)]
  for i,(p,pin) in enumerate(zip(roots,pins['components'])):
   s=json.loads((p/'status.json').read_text());assert pin['stage']==i and s['stage']==i and s['status']=='compiled_bpu_only' and s['bpu_only']
   assert sha(p/'status.json')==pin['status_sha256'] and sha(p/'converted.bc')==pin['converted_bc_sha256'] and sha(p/'model.hbm')==pin['hbm_sha256']
  from hbdk4.compiler import load,compile
  from hbdk4.compiler.hbm import Hbo
  from leap_llm.nn.utils import Model
  hbos=[]
  for i,p in enumerate(roots):
   cg,av=headroom();assert cg>=6*1024**3 and av>=6*1024**3,f'Insufficient memory headroom before stage {i}'
   r.update(status=f'compiling_stage_{i:02d}',current_stage=i);persist()
   m=load(str(p/'converted.bc'));assert len(m.functions)==1;name=m.functions[0].name;d=out/f'stage{i:02d}';d.mkdir()
   begin=time.monotonic();compile(m,str(d/'model.hbo'),march='nash-m',opt=2,jobs=1);sec=time.monotonic()-begin
   r['components'].append(dict(stage=i,name=name,converted_bc_sha256=pins['components'][i]['converted_bc_sha256'],o2_hbo_sha256=sha(d/'model.hbo'),compile_seconds=sec));hbos.append(Hbo(str(d/'model.hbo')));del m;persist()
  r['status']='linking';persist();(out/'official-q8').mkdir();Model.link_models(hbos,str(out/'official-q8/model.hbm'))
  import subprocess
  disas=json.loads(subprocess.check_output([str(SDK/'hbdk4/compiler/_mlir_libs/hbrt4-disas'),'--json',str(out/'official-q8/model.hbm')],text=True))
  names=[g['name'] for g in disas['graphs']];assert sorted(names)==sorted(c['name'] for c in r['components']) and len(names)==27
  assert all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in disas['graphs'])
  (out/'disas.json').write_text(json.dumps(disas,indent=2)+'\n')
  for i,p in enumerate(roots):assert sha(p/'converted.bc')==pins['components'][i]['converted_bc_sha256']
  r.update(status='compiled_same_bc_vision_o2_not_board_qualified',bpu_only=True,hbm_sha256=sha(out/'official-q8/model.hbm'),hbm_bytes=(out/'official-q8/model.hbm').stat().st_size,disas_sha256=sha(out/'disas.json'),total_compile_seconds=sum(c['compile_seconds'] for c in r['components']))
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:r['finished']=time.time();persist()
main()
