"""Compiler host/cgroup resource-boundary controls;zero neural/compile jobs."""
from pathlib import Path
import argparse,hashlib,json,time,unittest
from locateanything_compile_memory_v1 import headroom,has_headroom,resource_snapshot
G=1024**3
class ResourceControls(unittest.TestCase):
 def test_inactive_cache_is_not_counted_as_live_rss(self):
  d=headroom(20*G,22*G,26*G,4*G);self.assertEqual(d['cgroup_working_set_bytes'],18*G);self.assertEqual(d['cgroup_headroom_after_inactive_file_bytes'],8*G)
 def test_preparation_boundary_is_strict(self):
  self.assertFalse(has_headroom(headroom(14*G,16*G,26*G,0),True))
  self.assertFalse(has_headroom(headroom(20*G,18*G,26*G,0),True))
  self.assertTrue(has_headroom(headroom(20*G,18*G-1,26*G,0),True))
 def test_runtime_boundaries_preserve_host_and_cgroup(self):
  self.assertFalse(has_headroom(headroom(6*G,1*G,26*G,0)))
  self.assertFalse(has_headroom(headroom(20*G,23*G,26*G,0)))
  self.assertTrue(has_headroom(headroom(6*G+1,23*G-1,26*G,0)))
 def test_unlimited_cgroup_still_checks_host_ram(self):
  self.assertTrue(has_headroom(headroom(20*G,100*G,None,0),True))
  self.assertFalse(has_headroom(headroom(5*G,1*G,None,0)))
 def test_unbounded_cache_numbers_cannot_create_headroom(self):
  d=headroom(20*G,22*G,26*G,50*G);self.assertEqual(d['cgroup_inactive_file_bytes'],22*G);self.assertEqual(d['cgroup_working_set_bytes'],0)
 def test_over_limit_usage_has_zero_headroom(self):
  d=headroom(20*G,30*G,26*G,0);self.assertEqual(d['cgroup_headroom_after_inactive_file_bytes'],0);self.assertFalse(has_headroom(d))
 def test_invalid_types_and_negative_values_rejected(self):
  for args in [(True,1,2,0),(-1,1,2,0),(1,-1,2,0),(1,1,0,0),(1,1,2,-1)]:
   with self.assertRaises(AssertionError):headroom(*args)
 def test_actual_compiler_host_accounting_is_available(self):
  d=resource_snapshot();self.assertIn(d['cgroup_version'],[1,2]);self.assertGreater(d['ordinary_available_bytes'],0)
  self.assertGreater(d['cgroup_usage_bytes'],0);self.assertIsInstance(d['cgroup_inactive_file_bytes'],int)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--report',type=Path,required=True);a=p.parse_args();assert a.report.parent.resolve()==Path('/work/official-llm-v1') and not a.report.exists();begin=time.time()
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ResourceControls))
 d=dict(status='passed' if result.wasSuccessful() else 'failed',started=begin,finished=time.time(),tests_run=result.testsRun,
  failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),resource_helper_sha256=hashlib.sha256((Path(__file__).parent/'locateanything_compile_memory_v1.py').read_bytes()).hexdigest(),
  actual_host_snapshot=resource_snapshot(),synthetic_boundary_tests=True,new_compile_jobs=0,neural_calls=0,production_actions=False)
 a.report.write_text(json.dumps(d,indent=2)+'\n');assert result.wasSuccessful()
