from pathlib import Path
import sys,threading,unittest,json,hashlib
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
ROOT=Path('/home/sunrise/ainvr');sys.path.insert(0,str(ROOT/'ai-service/runtime'))
import locateanything_bpu_compact_resident_executor_v2 as backend
from locateanything_persistent_request_worker_v1 import PersistentRequestWorker
class FakeExecutor:
 def __init__(self):self.owner=threading.get_ident();self.loaded={};self.stats=dict(calls=0,loads=0,evictions=0,load_ms=0.,inference_ms=0.,events=[],peak_loaded_models=0,peak_resident_file_bytes=0)
 def run_ordered(self,key,values):
  assert threading.get_ident()==self.owner
  if key not in self.loaded:self.loaded[key]=1;self.stats['loads']+=1;self.stats['events'].append({'type':'fake_load'})
  self.stats['calls']+=1;return values
 def close(self):assert threading.get_ident()==self.owner;self.loaded.clear()
class FakeGenerator:
 def generate(self,e,pixels,grid,ids,**kwargs):
  result=e.run_ordered('fake',ids)
  if int(ids[0])<0:raise ValueError('fake generation failed')
  return dict(generated_ids=np.array(result,dtype=np.int64),bpu_calls=1,model_loads=0,terminal=True,neural_cpu_fallback=False)
class Controls(unittest.TestCase):
 def make(self):
  b=backend.ResidentCompactBackend.__new__(backend.ResidentCompactBackend);b.generator=FakeGenerator();b.prompt=SimpleNamespace(decode=lambda ids:str(ids));b.mode='slow';b.maximum_seconds=2;b._worker=PersistentRequestWorker(FakeExecutor);return b
 def test_request_diagnostics_are_deltas_and_inputs_are_not_cached(self):
  b=self.make()
  try:
   a=b.generate(None,np.array([7]),8,None);c=b.generate(None,np.array([8]),8,None)
   self.assertEqual(a['generated_ids'],[7]);self.assertEqual(c['generated_ids'],[8]);self.assertEqual(a['executor_stats']['calls'],1);self.assertEqual(c['executor_stats']['calls'],1)
   self.assertEqual(a['executor_stats']['loads'],1);self.assertEqual(c['executor_stats']['loads'],0);self.assertFalse(c['all_models_released']);self.assertFalse(c['generation_state_retained']);self.assertTrue(c['models_retained_for_next_request'])
  finally:b.close()
 def test_failed_generation_returns_no_partial_answer_and_drops_cache(self):
  b=self.make()
  try:
   with self.assertRaises(ValueError):b.generate(None,np.array([-1]),8,None)
   self.assertEqual(b._worker.snapshot()['cached_models'],0)
   result=b.generate(None,np.array([9]),8,None);self.assertEqual(result['generated_ids'],[9]);self.assertEqual(result['executor_stats']['loads'],1)
  finally:b.close()
 def test_missing_real_residency_proof_prevents_worker_creation(self):
  def init(self,*args):self.generator=SimpleNamespace(specs=[None]*113);self.contract=dict(profile_sequence_capacities=dict(ar=1,prefill=1));self.contract_sha256='a'*64
  with patch.object(backend.CompactEvaluationBackend,'__init__',init),patch.object(backend,'load_residency_evidence',side_effect=ValueError('No actual complete proof')),patch.object(backend,'PersistentRequestWorker') as factory:
   with self.assertRaises(ValueError):backend.ResidentCompactBackend(None,'a'*64,None,None,'slow',2,43,None,'b'*64)
   factory.assert_not_called()
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls));p=ROOT/'test/results/locateanything-compact-resident-backend-controls-v2.json';assert not p.exists()
 p.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,neural_calls=0,fake_generator_and_executor=True,actual_model_or_service_start_verified=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n');assert result.wasSuccessful()
