from pathlib import Path
from unittest.mock import patch
from dataclasses import replace
import tempfile,unittest,json,hashlib
from locateanything_bpu_components_v2 import ComponentSpec,ComponentExecutor
from locateanything_compact_resident_executor_v1 import ExperimentalCompactResidentExecutor as E,PIN_KEYS
ROOT=Path('/home/sunrise/ainvr')
class Controls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='compact-residency-control-');self.root=Path(self.temp.name)
  keys=['vision-prefix']+[f'vision-block-{i:02d}' for i in range(27)]+['vision-connector']+[f'embedding-{i:02d}' for i in range(38)]+[f'head-{i:02d}' for i in range(38)]+[f'decoder-group-{i:02d}-{i+8:02d}-{p}' for i in (0,9,18,27) for p in ['decode','prefill']]
  self.specs=[]
  for key in keys:
   folder=self.root/key;folder.mkdir();payload=(key.rsplit('-',1)[0] if key.startswith('decoder') else key).encode();(folder/'model.hbm').write_bytes(payload)
   (folder/'ports.json').write_text(json.dumps(dict(inputs=[dict(name='x',shape=[1],dtype='float32')],outputs=[dict(name='y',shape=[1],dtype='float32')])))
   self.specs.append(ComponentSpec(key,folder,hashlib.sha256(payload).hexdigest(),((1,),),('float32',)))
 def tearDown(self):self.temp.cleanup()
 def make(self,specs=None,**kw):return E(self.specs if specs is None else specs,7*1024**3,maximum_models=1,experimental_residency=True,**kw)
 def test_explicit_experimental_admission_required(self):
  for x in [False,1,None]:
   with self.assertRaises(ValueError):E(self.specs,7*1024**3,experimental_residency=x)
 def test_complete_shape_and_four_role_aliases(self):
  e=self.make();self.assertEqual(len(e.specs),113);self.assertEqual(len(e.aliases),4);self.assertEqual(len(PIN_KEYS),42);self.assertFalse(e.residency_plan['compiler_minimum_complete']);self.assertFalse(e.residency_plan['measured_runtime_peak_verified']);e.close()
 def test_missing_component_rejects(self):
  with self.assertRaises(AssertionError):self.make(self.specs[:-1])
 def test_different_executable_hash_rejects_alias(self):
  specs=list(self.specs);i=next(i for i,s in enumerate(specs) if s.key.endswith('08-prefill'));specs[i]=replace(specs[i],hbm_sha256='f'*64)
  with self.assertRaises(AssertionError):self.make(specs)
 def test_different_input_shape_rejects_alias(self):
  specs=list(self.specs);i=next(i for i,s in enumerate(specs) if s.key.endswith('08-prefill'));specs[i]=replace(specs[i],input_shapes=((12,),))
  with self.assertRaises(AssertionError):self.make(specs)
 def test_different_input_dtype_rejects_alias(self):
  specs=list(self.specs);i=next(i for i,s in enumerate(specs) if s.key.endswith('08-prefill'));specs[i]=replace(specs[i],input_dtypes=('float16',))
  with self.assertRaises(AssertionError):self.make(specs)
 def test_same_hbm_but_different_port_metadata_rejects(self):
  s=next(s for s in self.specs if s.key.endswith('08-prefill'));(s.root/'ports.json').write_text('{}')
  with self.assertRaises(AssertionError):self.make()
 def test_canonical_role_reuses_same_context(self):
  e=self.make()
  def load(x,key):
   if key not in x.loaded:x.loaded[key]=object()
   return x.loaded[key]
  with patch.object(ComponentExecutor,'_load',load):
   for start in (0,9,18,27):self.assertIs(e._load(f'decoder-group-{start:02d}-{start+8:02d}-prefill'),e._load(f'decoder-group-{start:02d}-{start+8:02d}-decode'))
  self.assertEqual(len(e.loaded),4);self.assertEqual(e.maximum_models,43);e.loaded.clear();e.close()
 def test_no_pinned_context_evicted_to_meet_unavailable_margin(self):
  e=self.make();e.loaded.update((k,object()) for k in PIN_KEYS)
  with self.assertRaises(RuntimeError):e._evict_oldest()
  e.loaded.clear();e.close()
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls));p=ROOT/'test/results/locateanything-compact-resident-controls-v1.json';assert not p.exists()
 p.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,neural_calls=0,synthetic_component_metadata=True,full_model_or_memory_qualified=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n');assert result.wasSuccessful()
