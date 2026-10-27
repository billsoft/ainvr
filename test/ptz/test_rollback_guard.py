"""Downgrade preflight tests; no production service/database access."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('guard',ROOT/'deploy-package/ptz_rollback_guard.py');guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class RollbackGuard(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.target=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def state(self,blocked=0,pending=0):return lambda _: {'blocked':blocked,'stopPending':pending}
 def test_legacy_allowed_only_after_protection_is_clear(self):
  guard.preflight(ROOT,self.target,self.state())
  for b,p in [(1,0),(0,1),(2,3)]:
   with self.assertRaisesRegex(RuntimeError,'Downgrade refused'):guard.preflight(ROOT,self.target,self.state(b,p))
 def test_database_failure_never_means_no_protection(self):
  def failed(_):raise RuntimeError('database unavailable')
  with self.assertRaises(RuntimeError):guard.preflight(ROOT,self.target,failed)
 def test_verified_ptz_target_can_preserve_protection(self):
  (self.target/'ptz-compatibility.json').write_text(json.dumps(guard.COMPATIBILITY))
  for name in guard.REQUIRED:
   p=self.target/name;p.parent.mkdir(exist_ok=True);p.write_text('// compiled fixture')
  guard.preflight(ROOT,self.target,lambda _: self.fail('compatible release should not require a downgrade query'))
 def test_marker_without_compiled_protection_is_rejected(self):
  (self.target/'ptz-compatibility.json').write_text(json.dumps(guard.COMPATIBILITY))
  with self.assertRaisesRegex(RuntimeError,'incomplete'):guard.preflight(ROOT,self.target,self.state())
if __name__=='__main__':unittest.main()
