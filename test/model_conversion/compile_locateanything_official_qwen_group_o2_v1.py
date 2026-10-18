"""Compile the exact terminal official9layer BC profiles atO2;no recalibration or graph edits."""
from pathlib import Path
import argparse,os,sys,json,hashlib,time,traceback,subprocess,copy
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'))
from hbdk4.compiler import load,compile,link
p=argparse.ArgumentParser();p.add_argument('--origin',type=Path,required=True);p.add_argument('--origin-status-sha',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();assert os.getpgrp()==os.getpid() and a.origin.parent==a.out.parent==Path('/opt') and a.out.name.startswith('locate-official-qwen-group-') and not a.out.exists()
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert sha(a.origin/'status.json')==a.origin_status_sha;origin=json.loads((a.origin/'status.json').read_text());assert origin['status']=='compiled_original_group_shared_profiles_bpu_only' and origin['bpu_only'] and origin['layer_count']==9 and sha(a.origin/'model.hbm')==origin['hbm_sha256'];a.out.mkdir();r=copy.deepcopy(origin)
for key in ['hbm_sha256','hbm_bytes','finished','devices','compiler_memory']:r.pop(key,None)
r.update(status='loading_saved_profiles',started=time.time(),pid=os.getpid(),source_sha256=sha(Path(__file__)),origin_status_sha256=a.origin_status_sha,origin_hbm_sha256=origin['hbm_sha256'],optimization=2,compile_jobs=1,recalibration_executed=False,weights_or_graph_changed=False,maximum_compile_seconds=None,whole_model_verified=False,release_approved=False,actual_board_verified=False)
def save():
 p=a.out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(a.out/'status.json')
save()
try:
 hbos=[]
 for entry in r['profiles']:
  seq=entry['sequence_capacity'];sd=a.origin/f's{seq}';d=a.out/f's{seq}';d.mkdir();assert sha(sd/'converted.bc')==entry['converted_bc_sha256']
  for f in sd.rglob('*'):
   if f.is_file() and (f.suffix=='.npy' or f.name in ['converted.bc','ports.json']):
    dest=d/f.relative_to(sd);dest.parent.mkdir(parents=True,exist_ok=True);os.link(f,dest)
  module=load(str(d/'converted.bc'));entry['status']='compiling_hbo';r['status']=f'compiling_o2_s{seq}';save();start=time.monotonic();hbo=compile(module,str(d/'model.hbo'),march='nash-m',opt=2,jobs=1);entry.update(status='compiled_hbo',compile_seconds=time.monotonic()-start,hbo_sha256=sha(d/'model.hbo'));hbos.append(hbo);del module;save()
 r['status']='linking_shared_profiles';save();link(hbos,str(a.out/'model.hbm'));tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';disas=json.loads(subprocess.check_output([str(tool),'--json',str(a.out/'model.hbm')],text=True));devices=[n['device'] for g in disas['graphs'] for n in g['nodes']];assert len(disas['graphs'])==2 and devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices);(a.out/'disas.json').write_text(json.dumps(disas,indent=2)+'\n');r.update(status='compiled_original_group_shared_profiles_bpu_only',bpu_only=True,hbm_sha256=sha(a.out/'model.hbm'),hbm_bytes=(a.out/'model.hbm').stat().st_size,devices=devices,compiler_memory=[g['modelMemoryRequirement'] for g in disas['graphs']])
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','hbm_bytes','error']}))
