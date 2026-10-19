"""v302:capture actual BPU 29-stage vision features (deployed and candidate) for the 32 independent160 images.

Inputs are the frozen independent-final-native-reference-v2-head-o2 pixels.
Both variants share the deployed prefix/connector; only the 27 block programs differ. Each input
runs twice per variant (byte-exact repeat). Repeats must be byte-exact; deployed features feed the 160-case text attribution. No text model, no neural fallback, no service change.
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
CAND=BASE/a.candidate;OUT=BASE/(a.candidate+'-features160-v302');REF=BASE/'independent-final-native-reference-v2-head-o2'
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
 assert digest(REF/'reference-index-v3.json')=='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253';ref=json.loads((REF/'reference-index-v3.json').read_text());cases=[];seen=set()
 for c in ref['cases']:
  if c['image_id'] in seen:continue
  seen.add(c['image_id']);cases.append(dict(image_id=c['image_id'],pixels_sha256=c['pixels_sha256'],pixels=c['pixels'],grid=c['grid'],grid_sha256=c['grid_sha256']))
 assert len(cases)==32
 counts=Counter()
 class Executor(OfficialProgramExecutor):
  def run_ordered(self,key,values):
   out=super().run_ordered(key,values);counts[key]+=1;return out
 executor=Executor(tuple(specs.values()),maximum_models=4,budget_bytes=3*1024**3,minimum_available_bytes=2*1024**3,experimental_residency=True);executor.preload_all();assert executor.stats['loads']==4
 control=True
 for e in cases:
  image=e['image_id'];pp=REF/e['pixels'];assert digest(pp)==e['pixels_sha256'];pixels=np.load(pp,allow_pickle=False)
  gp=REF/e['grid'];assert digest(gp)==e['grid_sha256'];grid=np.load(gp,allow_pickle=False)
  rec=dict(image_id=image,pixels_sha256=e['pixels_sha256'])
  for name,vis in [('deployed',cur),('candidate',cand)]:
   x1=vis.forward(executor,pixels,grid);x2=vis.forward(executor,pixels,grid);assert x1.shape==(128,2048) and np.isfinite(x1).all() and x1.tobytes()==x2.tobytes()
   f=OUT/f'{name}-feature-{image}.npy';np.save(f,x1,allow_pickle=False);rec[name]=dict(feature_file=f.name,feature_sha256=digest(f),bf16_representable=bool(np.all((x1.view(np.uint32)&np.uint32(65535))==0)))
  a64=np.load(OUT/rec['deployed']['feature_file']).astype(np.float64);b64=np.load(OUT/rec['candidate']['feature_file']).astype(np.float64);rec['candidate_vs_deployed_rel_l2']=float(np.linalg.norm(a64-b64)/np.linalg.norm(a64))
  r['cases'].append(rec);r['bpu_calls']=executor.stats['calls'];save()
 r.update(status='completed',bpu_calls=executor.stats['calls'])
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 if executor is not None:executor.close()
 executor=None;gc.collect();r.update(all_owned_models_released=True,finished=time.time());save()
print(json.dumps({k:r.get(k) for k in ['status','bpu_calls','error']}))
