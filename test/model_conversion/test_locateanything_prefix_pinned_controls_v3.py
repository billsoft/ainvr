from pathlib import Path
from collections import OrderedDict
from unittest.mock import patch
import unittest,tempfile,json,hashlib
from locateanything_compact_prefix_pinned_executor_v3 import DiagnosticPinnedExecutor as E,PIN_KEYS,ComponentExecutor as B,memory_requirement
ROOT=Path('/home/sunrise/ainvr')
class Controls(unittest.TestCase):
 def fake(self,keys):
  e=E.__new__(E);e.loaded=OrderedDict((k,{}) for k in keys);e._closing=False;return e
 def test_pin_set_exact(self):self.assertEqual(len(PIN_KEYS),42);self.assertEqual(sum(k.startswith('head-') for k in PIN_KEYS),38)
 def test_transient_evicted_before_older_pin(self):
  e=self.fake([next(iter(PIN_KEYS)),'vision-block-00']);chosen=[]
  with patch.object(B,'_evict_oldest',lambda x:chosen.append(next(iter(x.loaded)))):e._evict_oldest()
  self.assertEqual(chosen,['vision-block-00'])
 def test_no_transient_fails_instead_of_dropping_decoder(self):
  with self.assertRaises(RuntimeError):self.fake(sorted(PIN_KEYS))._evict_oldest()
 def test_close_releases_pins(self):
  e=self.fake(sorted(PIN_KEYS));e._initial_maximum=1;e._pinning_started=True;e.maximum_models=43
  def close(x):
   while x.loaded:x._evict_oldest()
  with patch.object(B,'close',close),patch.object(B,'_evict_oldest',lambda x:x.loaded.popitem(last=False)):e.close()
  self.assertFalse(e.loaded);self.assertFalse(e._pinning_started);self.assertEqual(e.maximum_models,1)
 def test_missing_metadata_is_unknown_not_zero(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='prefix-memory-control-') as d:self.assertIsNone(memory_requirement(Path(d)))
 def test_duplicate_graph_metadata_is_not_double_counted(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='prefix-memory-control-') as d:
   p=Path(d);(p/'disas.json').write_text(json.dumps([{'modelMemoryRequirement':{'minMemoryRequirement':1234}}]*2));self.assertEqual(memory_requirement(p),1234)
 def test_conflicting_graph_metadata_rejects(self):
  with tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='prefix-memory-control-') as d:
   p=Path(d);(p/'disas.json').write_text(json.dumps([{'modelMemoryRequirement':{'minMemoryRequirement':x}} for x in [1234,4321]]))
   with self.assertRaises(AssertionError):memory_requirement(p)
 def test_identical_prefill_role_loads_canonical_pinned_runtime(self):
  e=self.fake([]);e.aliases={'decoder-group-00-08-prefill':'decoder-group-00-08-decode'};e._initial_maximum=1;e._pinning_started=False
  seen=[]
  with patch.object(B,'_load',lambda x,k:seen.append(k) or k):
   self.assertEqual(e._load('decoder-group-00-08-prefill'),'decoder-group-00-08-decode')
  self.assertEqual(seen,['decoder-group-00-08-decode']);self.assertEqual(e.maximum_models,43)
 def test_nonidentical_legacy_prefill_is_not_aliased(self):
  e=self.fake([]);e.aliases={'decoder-group-00-08-prefill':'decoder-group-00-08-decode'};e._initial_maximum=1;e._pinning_started=False
  with patch.object(B,'_load',lambda x,k:k):self.assertEqual(e._load('decoder-group-09-17-prefill'),'decoder-group-09-17-prefill')
  self.assertFalse(e._pinning_started);self.assertEqual(e.maximum_models,1)
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Controls))
 p=ROOT/'test/results/locateanything-prefix-pinned-controls-v3.json';assert not p.exists()
 p.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',tests=result.testsRun,neural_calls=0,production_actions=False,actual_device_residency_verified=False,source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n');assert result.wasSuccessful()
