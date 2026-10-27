import importlib.util
from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deploy-package'))
spec=importlib.util.spec_from_file_location('gb_backup_policy',ROOT/'deploy-package/gb28181/backup_policy.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BackupPolicyTest(unittest.TestCase):
 def test_only_complete_standalone_ssd_backups_are_accepted(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);good=root/'gb28181/20261027T010000Z';good.mkdir(parents=True)
   with patch.object(m,'require_ssd') as mounted,patch.object(m,'BACKUPS',root):
    with self.assertRaises(ValueError):m.check(good)
    (good/'repository').write_text('/repo');(good/'opt/ainvr/gb28181').mkdir(parents=True)
    for u in ['ainvr-gb28181','ainvr-gb-media']:(good/(u+'.active')).write_text('active')
    m.check(good);mounted.assert_called()
    with self.assertRaises(ValueError):m.check(root)
    (good/'escape').symlink_to(root)
    with self.assertRaises(ValueError):m.check(good)
 def test_missing_ssd_cannot_fall_back_to_emmc(self):
  with patch.object(m,'require_ssd',side_effect=RuntimeError('no SSD')):
   with self.assertRaises(RuntimeError):m.check(Path('/var/backups/old'))
if __name__=='__main__':unittest.main()
