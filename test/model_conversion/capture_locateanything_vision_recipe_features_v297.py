"""Capture actual BPU 29-stage vision features for the deployed and a candidate MoonViT27 recipe.

Same 17 prepared inputs as official-vision-feature-ablation-v1 (old regression72 images + used 4K).
Both variants share the deployed prefix/connector; only the 27 block programs differ. Each input
runs twice per variant (byte-exact repeat). The deployed variant must reproduce the stored v1
features byte-for-byte as a harness control. No text model, no neural fallback, no service change.
"""
from pathlib import Path
from collections import Counter
import os,sys,json,hashlib,time,traceback,gc,signal,argparse
import numpy as np
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
sys.path.insert(0,str(CODE));sys.path.insert(0,str(ROOT/'ai-service/runtime'))
from locateanything_official_family_contract_v1 import program,digest
from locateanything_official_family_v1 import OfficialVisionBlock
from locateanything_bpu_vision_v1 import FullVision
from locateanything_official_program_executor_v1 import OfficialProgramExecutor
ap=argparse.ArgumentParser();ap.add_argument('--candidate',required=True);ap.add_argument('--candidate-manifest-sha',required=True);a=ap.parse_args()
CAND=BASE/a.candidate;OUT=BASE/(a.candidate+'-features-v297');OLD=BASE/'official-vision-feature-ablation-v1'
assert os.getuid()==1000 and CAND.parent==BASE and digest(CAND/'manifest.json')==a.candidate_manifest_sha and not OUT.exists()
r=dict(status='checking',started=time.time(),source_sha256=digest(Path(__file__)),scope=__doc__,candidate=str(CAND),candidate_manifest_sha256=a.candidate_manifest_sha,bpu_calls=0,cases=[],control_matches_v1=None,production_paused=False,release_approved=False)
OUT.mkdir()
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('interrupted')));executor=None;save()
try:
 from locateanything_official_vision_o2_v284 import load_official_generator
 gen,_=load_official_generator(BASE/'official-full-family-w8a16-vision-o2-v284.json','d471046ae84930c385db34841154583e2476a1d0fe210f5985debee31a29fbf2')
 cur=gen.vision;stages=cur.stages;assert len(stages)==29
 m=json.loads((CAND/'manifest.json').read_text());assert len(m['programs'])==27
 meta=dict(path=str(CAND/'disas.json'),sha256=m['files']['disas.json']['sha256']);blocks=[]
 for i,p in enumerate(m['programs']):
  old=stages[1+i].spec;assert old.program==p['name']
  s=program('candidate-'+old.key,CAND/'official-q8/model.hbm',m['files']['official-q8/model.hbm']['sha256'],meta,p['name'],p['inputs'],p['outputs'],['float32'],['float32']);blocks.append(OfficialVisionBlock(i,s))
 cand=FullVision(stages[0],blocks,stages[-1])
 specs={s.key:s for s in list(cur.specs)+list(cand.specs)};assert len(specs)==56
 old_manifest=json.loads((OLD/'status.json').read_text());cases=old_manifest['cases'];assert len(cases)==17
 inputs=json.loads((BASE/'official-family-regression72-v1.json').read_text())['cases'];paths={}
 for c in inputs:paths[str(c['native_reference']['image_id'])]=(c['inputs']['pixels'],c['inputs']['grid'])
 paths['already_used_live4K']=(dict(path=str(BASE/'official-native4k-probe-v2/backend-inputs/request-000/pixel_values.npy'),sha256='35b3402dec6a3144db61ee6640abd858a2ed430b3208d905c43bb91db36b3048'),None)
 counts=Counter()
 class Executor(OfficialProgramExecutor):
  def run_ordered(self,key,values):
   out=super().run_ordered(key,values);counts[key]+=1;return out
 executor=Executor(tuple(specs.values()),maximum_models=4,budget_bytes=3*1024**3,minimum_available_bytes=2*1024**3,experimental_residency=True);executor.preload_all();assert executor.stats['loads']==4
 control=True
 for e in cases:
  image=e['image_id'];px,gr=paths[image];pp=Path(px['path']);assert digest(pp)==px['sha256']==e['pixels_sha256'];pixels=np.load(pp,allow_pickle=False)
  grid=np.load(gr['path'],allow_pickle=False) if gr else np.array([[16,32]],np.int64)
  rec=dict(image_id=image,pixels_sha256=e['pixels_sha256'])
  for name,vis in [('deployed',cur),('candidate',cand)]:
   x1=vis.forward(executor,pixels,grid);x2=vis.forward(executor,pixels,grid);assert x1.shape==(128,2048) and np.isfinite(x1).all() and x1.tobytes()==x2.tobytes()
   f=OUT/f'{name}-feature-{image}.npy';np.save(f,x1,allow_pickle=False);rec[name]=dict(feature_file=f.name,feature_sha256=digest(f),bf16_representable=bool(np.all((x1.view(np.uint32)&np.uint32(65535))==0)))
  rec['deployed_equals_v1']=rec['deployed']['feature_sha256']==e['feature_sha256'];control&=rec['deployed_equals_v1']
  a64=np.load(OUT/rec['deployed']['feature_file']).astype(np.float64);b64=np.load(OUT/rec['candidate']['feature_file']).astype(np.float64);rec['candidate_vs_deployed_rel_l2']=float(np.linalg.norm(a64-b64)/np.linalg.norm(a64))
  r['cases'].append(rec);r['bpu_calls']=executor.stats['calls'];save()
 r.update(status='completed',control_matches_v1=control,bpu_calls=executor.stats['calls'])
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 if executor is not None:executor.close()
 executor=None;gc.collect();r.update(all_owned_models_released=True,finished=time.time());save()
print(json.dumps({k:r.get(k) for k in ['status','bpu_calls','control_matches_v1','error']}))
