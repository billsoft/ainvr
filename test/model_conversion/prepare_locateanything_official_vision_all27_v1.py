"""All27 sequential official-Q8 native vision blocks:accumulated compiler error+board fixtures."""
from pathlib import Path
import os,sys,json,time,hashlib,traceback,subprocess,tarfile
for k in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[k]='1'
BASE=Path('/opt/locate-oellm-research-v1');sys.path.insert(0,str(BASE/'sdk448-isolated/python'));sys.path.insert(0,str(BASE/'leap-source-overlay'))
import numpy as np
import torch
from hbdk4.compiler import load
from hbdk4.compiler.hbm import Hbo
from leap_llm.nn.utils import Model
assert os.getpgrp()==os.getpid();torch.set_num_threads(2);out=Path('/opt/locate-official-vision-all27-v1');assert not out.exists();out.mkdir();r=dict(status='checking_components',started=time.time(),pid=os.getpid(),scope=__doc__,whole_model_verified=False,release_approved=False,regression=[])
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def metric(a,b):
 a=np.asarray(a,np.float64);b=np.asarray(b,np.float64);assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all();return dict(rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-12)),max_abs=float(np.abs(a-b).max()))
def persist():
 p=out/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+chr(10));p.replace(out/'status.json')
persist()
try:
 roots=[Path('/opt/locate-official-moonvit-block0-w8-v2')]+[Path(f'/opt/locate-official-moonvit-block{i}-w8-v3') for i in range(1,27)];states=[json.loads((p/'status.json').read_text()) for p in roots];assert all(s['status']=='compiled_bpu_only' and s['finished'] and s['bpu_only'] and s['stage']==i and s['norm_implementation']=='official LayerNormSplit' for i,s in enumerate(states));assert all(sha(p/'model.hbm')==s['hbm_sha256'] for p,s in zip(roots,states));r['components']=[dict(stage=i,status_sha256=sha(p/'status.json'),converted_bc_sha256=sha(p/'converted.bc'),hbm_sha256=s['hbm_sha256']) for i,(p,s) in enumerate(zip(roots,states))]
 linked=out/'official-q8';linked.mkdir();Model.link_models([Hbo(str(p/'model.hbo')) for p in roots],str(linked/'model.hbm'));tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas';disas=json.loads(subprocess.check_output([str(tool),'--json',str(linked/'model.hbm')],text=True));assert len(disas['graphs'])==27 and all(n['device']=='DEVICE_CATEGORY_BPU' for g in disas['graphs'] for n in g['nodes']);(out/'disas.json').write_text(json.dumps(disas,indent=2)+chr(10));r['hbm_sha256']=sha(linked/'model.hbm');r['hbm_bytes']=(linked/'model.hbm').stat().st_size
 data=Path('/work/vision-native-bf16-stage-data-v1');meta=json.loads((data/'status.json').read_text());assert meta['source_weights_modified']==False and meta['original_whole_vision_equivalence_exact'];r['native_vision_source_status_sha256']=sha(data/'status.json');selected=[(split,p) for split in ['pilot','validation'] for p in sorted((data/'block-00'/split).glob('*.npy'))];assert len(selected)==18;values=[np.load(p,allow_pickle=False) for split,p in selected];r['programs']=[];r['status']='compiler_chain_reference';r['regression']=[dict(case=i,split=split,image=p.stem,input_sha256=sha(p),stages=[]) for i,(split,p) in enumerate(selected)];persist()
 for case,x in enumerate(values[:4]):
  q=out/f'case-{case:02d}';q.mkdir();np.save(q/'input-00.npy',x)
 for stage,p in enumerate(roots):
  module=load(str(p/'converted.bc'));f=module.functions[0];r['current_stage']=stage;r['programs'].append(dict(name=f.name,inputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.inputs],outputs=[dict(name=x.name,shape=list(x.type.shape)) for x in f.outputs]));persist()
  for case,(split,source) in enumerate(selected):
   x=np.asarray(f(values[case])[0]).copy();gold=np.load(data/(f'block-{stage+1:02d}' if stage<26 else 'tail')/split/source.name,allow_pickle=False);r['regression'][case]['stages'].append(dict(stage=stage,compiler_chain_vs_original_native_bf16=metric(x,gold)));values[case]=x
   if case<4:np.save(out/f'case-{case:02d}'/f'compiler-stage{stage:02d}.npy',x)
  del f,module;persist()
 r['status']='compiler_chain_reference_completed';r['finished']=time.time();persist();(out/'source-status.json').write_bytes((out/'status.json').read_bytes());entries={}
 for p in sorted(out.rglob('*')):
  if p.is_file() and (p.parent.name.startswith('case-') or p.relative_to(out).as_posix() in ['official-q8/model.hbm','source-status.json','disas.json']):entries[p.relative_to(out).as_posix()]=dict(bytes=p.stat().st_size,sha256=sha(p))
 m=dict(schema='locateanything_official_vision_prefix_chain_v1',source_status=r,component_kind='vision_all27',stage_count=27,repeats=3,warmup_repeats=1,case_count=4,programs=r['programs'],files=entries,whole_model_verified=False,release_approved=False);(out/'manifest.json').write_text(json.dumps(m,indent=2)+chr(10));archive=Path('/work/official-llm-v1/official-vision-all27-q8-v1-board-package.tar');assert not archive.exists()
 with tarfile.open(archive,'w') as tar:
  for n in sorted(set(entries)|{'manifest.json'}):tar.add(out/n,arcname=n,recursive=False)
 report=dict(status='packaged',archive_bytes=archive.stat().st_size,archive_sha256=sha(archive),manifest_sha256=sha(out/'manifest.json'),payload_files=len(entries),hbm_sha256=r['hbm_sha256'],hbm_bytes=r['hbm_bytes'],compiler_chain_regression=r['regression'],whole_model_verified=False,release_approved=False);p=archive.with_suffix('.json');assert not p.exists();p.write_text(json.dumps(report,indent=2)+chr(10));r.update(status='packaged',package_report_sha256=sha(p),archive_sha256=report['archive_sha256'],manifest_sha256=report['manifest_sha256'])
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:r['finished']=time.time();persist()
print(json.dumps({k:r.get(k) for k in ['status','hbm_sha256','hbm_bytes','regression','error']},indent=2))
