"""Actual lazy-backend constructor controls;any neural executor construction fails.

All candidate source/provenance validation remains active. Only the private
test process replaces the executor factory with a counting rejection sentinel.
"""
from pathlib import Path
import hashlib,json,os,sys,copy,time,traceback
ROOT=Path('/home/sunrise/ainvr');RUNTIME=ROOT/'ai-service/runtime';CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');OUT=BASE/'prefill-o2-admission-controls-v135';CONTRACT=BASE/'official-full-family-w8a16-prefill-o2-g0-v130.json';TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 assert os.getuid()==1000 and OUT.is_dir() and not (OUT/'status.json').exists();assert sha(RUNTIME/'locateanything_bpu_prefill_o2_executor_v7.py')=='c918ba39fa40a6f22a55e096bb2bd6d3457ce2db7345c5f20107c1b2472de181' and sha(CONTRACT)=='04fe2aea85d8a3467cb98747a9c10c2d0d9d04cae22417527107e29694b39e26'
 sys.path.insert(0,str(RUNTIME));sys.path.insert(0,str(CODE));import locateanything_bpu_prefill_o2_executor_v7 as module
 attempts=[]
 class RejectNeuralFactory:
  def __init__(self,*a,**k):attempts.append(True);raise RuntimeError('Neural executor construction forbidden in metadata test')
 module.OfficialProgramExecutor=RejectNeuralFactory
 r=dict(status='running',source_sha256=sha(__file__),started=time.time(),controls=[],neural_executor_constructions=0,production_source_modified=False,architecture_reduction_allowed=False)
 def constructor(path):
  obj=None
  try:
   obj=module.OfficialEvaluationBackend(path,sha(path),BASE/'tokenizer-original-v1.json',TOKEN_SHA);health=obj.health();assert health['ready'] and health['component_count']==76 and health['physical_hbm_files']==46 and health['persistent_worker']['cached_models']==0 and not health['neural_cpu_fallback'];return health
  finally:
   if obj is not None:obj.close()
 original=json.loads(CONTRACT.read_text());copy_path=OUT/'positive-copy.json';copy_path.write_text(json.dumps(original,indent=2)+'\n')
 for name,p in [('actual_contract',CONTRACT),('same_content_copy',copy_path)]:r['controls'].append(dict(name=name,accepted=True,health=constructor(p)))
 fixtures=[]
 c=copy.deepcopy(original);c['architecture']='reduced35layers';fixtures.append(('reduced_architecture',c))
 c=copy.deepcopy(original);c['whole_model_verified']=True;fixtures.append(('premature_whole_model_claim',c))
 c=copy.deepcopy(original);c['base_family']['sha256']='0'*64;fixtures.append(('altered_original_family_identity',c))
 c=copy.deepcopy(original);c['prefill_component']['manifest_sha256']='0'*64;fixtures.append(('altered_component_identity',c))
 c=copy.deepcopy(original);c['runtime_source_sha256'].pop('locateanything_prefill_component_admission_v1.py');fixtures.append(('missing_admission_source_pin',c))
 for name,c in fixtures:
  p=OUT/(name+'.json');p.write_text(json.dumps(c,indent=2)+'\n')
  try:constructor(p)
  except (AssertionError,ValueError):r['controls'].append(dict(name=name,rejected=True))
  else:raise AssertionError('Invalid full-family metadata admitted: '+name)
 assert len(r['controls'])==7 and not attempts;r.update(status='passed2positive5negative_complete_family_lazy_constructor_controls',finished=time.time(),neural_executor_constructions=len(attempts),neural_calls=0,scope='Constructor/metadata only;not hardware performance,all160 quality or installed service acceptance');(OUT/'status.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(dict(status=r['status'],neural_calls=0,controls=len(r['controls']),sha256=sha(OUT/'status.json'))))
if __name__=='__main__':main()
