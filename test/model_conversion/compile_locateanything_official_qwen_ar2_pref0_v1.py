"""Compile only remaining original9-layer AR1 atO2;reuse checkedO0prefill.

Official saved-BC compile/link only,no calibration,weights/graph changes or
elapsed compile cap. Separate output roots keep the first fullO2 job intact.
"""
from pathlib import Path
import os,sys,json,hashlib,time,copy,shutil,traceback,argparse,subprocess
for key in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[key]='1'
SDK=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(SDK/'sdk448-isolated/python'))
from hbdk4.compiler import load,compile,link
from hbdk4.compiler.hbm import Hbo
p=argparse.ArgumentParser();p.add_argument('--origin',type=Path,required=True);p.add_argument('--origin-status-sha',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert os.getpid()==os.getpgrp() and a.origin.resolve().parent==a.out.resolve().parent==Path('/opt') and not a.out.exists()
assert sha(a.origin/'status.json')==a.origin_status_sha
old=json.loads((a.origin/'status.json').read_text());first=old['first'];assert first in (9,18,27) and old['last']==first+8 and old['layer_count']==9
assert a.origin.name==f'locate-official-qwen-group-{first}-{first+8}-w8a16-v3' and a.out.name==f'locate-official-qwen-group-{first}-{first+8}-w8a16-ar2-pref0-v2'
assert old['source_sha256']=='5e8bd1b7992143c8abdb005a1729f224bbddc4e9ad69b576e5dac6338e347091'
assert old['status']=='compiled_original_group_shared_profiles_bpu_only' and old['bpu_only'] and old['weight_bits']==8 and old['attention_activation_bits']==16
assert old['original_norm_epsilon_preserved'] and old['official_quantized_linear_build_unmodified'] and sha(a.origin/'model.hbm')==old['hbm_sha256']
assert len(old['profiles'])==2 and [x['sequence_capacity'] for x in old['profiles']]==[1,256]
assert len(old['calibration'])==192 and set(old['original_parameter_hashes'])=={str(i) for i in range(first,first+9)}
a.out.mkdir();r=copy.deepcopy(old);r.pop('finished',None)
r.update(status='preparing_same_bc_profiles',started=time.time(),pid=os.getpid(),source_sha256=sha(Path(__file__)),origin_status_sha256=a.origin_status_sha,origin_hbm_sha256=old['hbm_sha256'],profile_optimization={'1':2,'256':0},compile_jobs=2,only_decode_recompiled=True,prefill_reused_without_recompilation=True,recompilation_executed=True,recalibration_executed=False,weights_or_graph_changed=False,maximum_compile_seconds=None,actual_board_verified=False,whole_model_verified=False,release_approved=False)
def save():
 p=a.out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(a.out/'status.json')
save()
try:
 for entry in r['profiles']:
  seq=entry['sequence_capacity'];source=a.origin/f's{seq}';dest=a.out/f's{seq}';dest.mkdir()
  assert sha(source/'converted.bc')==entry['converted_bc_sha256']
  for file in source.rglob('*'):
   if file.is_file() and (file.suffix=='.npy' or file.name in ('ports.json','converted.bc')):
    target=dest/file.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True);os.link(file,target)
  if seq==1:
   r['status']='compiling_decode_o2';entry['status']='compiling_hbo';save();m=load(str(dest/'converted.bc'));begin=time.monotonic()
   compile(m,str(dest/'model.hbo'),march='nash-m',opt=2,jobs=2)
   entry.update(status='compiled_hbo',compile_seconds=time.monotonic()-begin,hbo_sha256=sha(dest/'model.hbo'));del m
  else:
   r['status']='copying_verified_origin_prefill_hbo';save()
   assert sha(source/'model.hbo')==entry['hbo_sha256'];shutil.copyfile(source/'model.hbo',dest/'model.hbo');assert sha(dest/'model.hbo')==entry['hbo_sha256']
  save()
 r['status']='linking_ar2_pref0';save();begin=time.monotonic()
 link([Hbo(str(a.out/'s1/model.hbo')),Hbo(str(a.out/'s256/model.hbo'))],str(a.out/'model.hbm'))
 tool=SDK/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';disas=json.loads(subprocess.check_output([str(tool),'--json',str(a.out/'model.hbm')],text=True))
 devices=[n['device'] for g in disas['graphs'] for n in g['nodes']]
 assert len(disas['graphs'])==2 and devices and all(x=='DEVICE_CATEGORY_BPU' for x in devices)
 assert {g['name'] for g in disas['graphs']}=={json.loads((a.out/f's{q}/ports.json').read_text())['name'] for q in (1,256)}
 (a.out/'disas.json').write_text(json.dumps(disas,indent=2)+'\n')
 r.update(status='compiled_original_group_shared_profiles_bpu_only',bpu_only=True,hbm_sha256=sha(a.out/'model.hbm'),hbm_bytes=(a.out/'model.hbm').stat().st_size,devices=devices,compiler_memory=[g['modelMemoryRequirement'] for g in disas['graphs']],link_seconds=time.monotonic()-begin)
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','first','hbm_sha256','hbm_bytes','profile_optimization']}))
