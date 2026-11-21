"""Downgrade preflight tests; no production service/database access."""
import importlib.util,json,tempfile,unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('guard',ROOT/'deploy-package/ptz_rollback_guard.py');guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
class RollbackGuard(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.target=Path(self.temp.name)
 def tearDown(self):self.temp.cleanup()
 def state(self,blocked=0,pending=0,scenes=0,presets=0):return lambda _: {'blocked':blocked,'stopPending':pending,'sceneBindings':scenes,'presetBindings':presets}
 def target_release(self,scene=False,preset=False):
  (self.target/'ptz-compatibility.json').write_text(json.dumps(guard.COMPATIBILITY if preset else guard.SCENE_COMPATIBILITY if scene else guard.LEGACY_COMPATIBILITY))
  for name in guard.REQUIRED+(guard.SCENE_REQUIRED if scene or preset else ())+(guard.PRESET_REQUIRED if preset else ()):
   p=self.target/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('// compiled fixture')
 def test_legacy_allowed_only_after_protection_is_clear(self):
  guard.preflight(ROOT,self.target,self.state())
  for b,p in [(1,0),(0,1),(2,3)]:
   with self.assertRaisesRegex(RuntimeError,'Downgrade refused'):guard.preflight(ROOT,self.target,self.state(b,p))
 def test_database_failure_never_means_no_protection(self):
  def failed(_):raise RuntimeError('database unavailable')
  with self.assertRaises(RuntimeError):guard.preflight(ROOT,self.target,failed)
 def test_verified_ptz_target_can_preserve_protection(self):
  self.target_release()
  guard.preflight(ROOT,self.target,self.state(2,1))
  self.assertTrue(guard.supports_view_guards(self.target))
  self.assertFalse(guard.supports_scene_bindings(self.target))
  for count in [1,5]:
   with self.subTest(count=count),self.assertRaisesRegex(RuntimeError,'scene bindings exist'):
    guard.preflight(ROOT,self.target,self.state(scenes=count))
 def test_legacy_target_rejects_scene_bindings_even_with_clear_ptz(self):
  with self.assertRaisesRegex(RuntimeError,'scene bindings exist'):
   guard.preflight(ROOT,self.target,self.state(scenes=1))
 def test_scene_target_accepts_zero_and_nonzero_bindings(self):
  self.target_release(scene=True)
  for count in [0,1,7]:guard.preflight(ROOT,self.target,self.state(2,1,count))
  self.assertTrue(guard.supports_scene_bindings(self.target))
 def test_both_compatible_markers_still_require_database(self):
  for scene in [False,True]:
   self.target_release(scene)
   def failed(_):raise RuntimeError('database unavailable')
   with self.subTest(scene=scene),self.assertRaisesRegex(RuntimeError,'database unavailable'):
    guard.preflight(ROOT,self.target,failed)
 def test_every_scene_runtime_file_is_required(self):
  self.target_release(scene=True)
  for name in guard.SCENE_REQUIRED:
   p=self.target/name;p.unlink()
   try:
    with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'incomplete'):
     guard.preflight(ROOT,self.target,self.state(scenes=1))
   finally:p.write_text('// compiled fixture')
 def test_scene_file_symlink_is_not_a_complete_release(self):
  self.target_release(scene=True)
  p=self.target/guard.SCENE_REQUIRED[0];p.unlink();p.symlink_to(self.target/guard.REQUIRED[0])
  with self.assertRaisesRegex(RuntimeError,'incomplete'):guard.preflight(ROOT,self.target,self.state(scenes=1))
 def test_malformed_or_missing_scene_count_fails_closed(self):
  self.target_release(scene=True)
  for state in [{'blocked':0,'stopPending':0},None,{'blocked':0,'stopPending':0,'sceneBindings':True},
                {'blocked':0,'stopPending':0,'sceneBindings':-1},{'blocked':0,'stopPending':0,'sceneBindings':'0'}]:
   with self.subTest(state=state),self.assertRaisesRegex(RuntimeError,'Invalid persistent'):
    guard.preflight(ROOT,self.target,lambda _:state)
 def test_database_protocol_requires_new_count(self):
  for state,valid in [({'blocked':0,'stopPending':0,'sceneBindings':0,'presetBindings':0},True),({'blocked':0,'stopPending':0,'sceneBindings':0},False),({'blocked':0,'stopPending':0},False)]:
   with patch.object(guard.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps(state))):
    if valid:self.assertEqual(guard.database_state(ROOT),state)
    else:
     with self.assertRaisesRegex(RuntimeError,'Invalid persistent'):guard.database_state(ROOT)
 def test_unknown_scene_marker_is_not_silently_treated_as_old_ptz(self):
  self.target_release(scene=True)
  for version in [0,2,True]:
   (self.target/'ptz-compatibility.json').write_text(json.dumps({**guard.COMPATIBILITY,'sceneBindingVersion':version}))
   with self.assertRaisesRegex(RuntimeError,'Invalid PTZ'):guard.preflight(ROOT,self.target,self.state())
 def test_marker_without_compiled_protection_is_rejected(self):
  (self.target/'ptz-compatibility.json').write_text(json.dumps(guard.COMPATIBILITY))
  with self.assertRaisesRegex(RuntimeError,'incomplete'):guard.preflight(ROOT,self.target,self.state())
 def test_formal_bindings_block_every_old_target(self):
  for scene in [False,True]:
   self.target_release(scene=scene)
   with self.assertRaisesRegex(RuntimeError,'preset bindings exist'):
    guard.preflight(ROOT,self.target,self.state(scenes=2,presets=1))
 def test_formal_complete_target_preserves_pending_formal_bindings(self):
  self.target_release(preset=True)
  for count in [0,1,5]:guard.preflight(ROOT,self.target,self.state(2,1,count,count))
  for name in guard.PRESET_REQUIRED:
   p=self.target/name;p.unlink()
   try:
    with self.assertRaisesRegex(RuntimeError,'Preset-aware target is incomplete'):guard.preflight(ROOT,self.target,self.state(scenes=1,presets=1))
   finally:p.write_text('// compiled fixture')
if __name__=='__main__':unittest.main()
