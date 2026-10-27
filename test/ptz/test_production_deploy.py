"""Deployment guarantees on disposable paths; never controls live services."""
import sys,tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'deploy-package'))
import deploy_ptz_release as deploy
class DeployTests(unittest.TestCase):
 def test_no_ssd_has_no_emmc_fallback(self):
  with tempfile.TemporaryDirectory() as d:
   with patch.object(deploy,'SSD',Path(d)),patch.object(deploy,'BACKUPS',Path(d)/'rollback'):
    with self.assertRaisesRegex(RuntimeError,'no eMMC'):deploy.require_ssd()
    self.assertFalse((Path(d)/'rollback').exists())
 def test_atomic_tree_exchange(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);old=root/'live';new=root/'candidate';old.mkdir();new.mkdir()
   (old/'old').write_text('old');(new/'new').write_text('new')
   deploy.swap_tree(new,old)
   self.assertEqual([p.name for p in old.iterdir()],['new'])
   self.assertFalse(list(root.glob('.ptz-stage-*')))
 def test_retention_per_service_max_three(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);bucket=root/'backend';bucket.mkdir()
   for n in range(5):
    p=bucket/('20261027T120000Z-'+str(n));p.mkdir();(p/'backup.json').write_text(json.dumps({'phase':'applied'}))
   with patch.object(deploy,'BACKUPS',root),patch.object(deploy,'require_ssd'):
    deploy.prune('backend')
   self.assertEqual(sorted(p.name for p in bucket.iterdir()),['20261027T120000Z-'+str(n) for n in [2,3,4]])
 def test_unfinished_backup_is_not_deleted(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);bucket=root/'backend';bucket.mkdir()
   for n in range(4):
    p=bucket/('20261027T120000Z-'+str(n));p.mkdir();(p/'backup.json').write_text(json.dumps({'phase':'preparing' if n==0 else 'applied'}))
   with patch.object(deploy,'BACKUPS',root),patch.object(deploy,'require_ssd'):
    with self.assertRaisesRegex(RuntimeError,'unfinished'):deploy.prune('backend')
   self.assertTrue((bucket/'20261027T120000Z-0').exists())
 def test_symlink_cannot_be_retention_target(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);bucket=root/'backend';bucket.mkdir();outside=root/'outside';outside.mkdir()
   (bucket/'20261027T120000Z-1').symlink_to(outside,target_is_directory=True)
   with patch.object(deploy,'BACKUPS',root),patch.object(deploy,'require_ssd'):
    with self.assertRaisesRegex(RuntimeError,'Unknown'):deploy.prune('backend')
   self.assertTrue(outside.exists())
 def test_migrated_legacy_backup_obeys_same_limit(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);bucket=root/'gb28181';bucket.mkdir()
   old=bucket/'20261024T153413Z';old.mkdir();(old/'etc').mkdir();(old/'opt').mkdir();(old/'repository').write_text('legacy location')
   for n in range(3):
    p=bucket/('20261027T120000Z-'+str(n));p.mkdir();(p/'backup.json').write_text(json.dumps({'phase':'applied'}))
   with patch.object(deploy,'BACKUPS',root),patch.object(deploy,'require_ssd'):
    deploy.prune('gb28181')
   self.assertFalse(old.exists());self.assertEqual(len(list(bucket.iterdir())),3)
 def test_changed_backup_refuses_rollback(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);paths={}
   for service in deploy.SERVICES:
    p=root/service/'20261027T120000Z-1';p.mkdir(parents=True);(p/'binary').write_text('original');paths[service]=p
   state={'format':'ainvr-ptz-v1','phase':'applied','integrity':deploy.backup_inventory(paths)}
   (paths['onvif']/'binary').write_text('corrupted')
   with patch.object(deploy,'BACKUPS',root):
    with self.assertRaisesRegex(RuntimeError,'Rollback artifact changed'):deploy.check_rollback(state,paths)
 def test_concurrent_binary_deployment_refuses_rollback(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);paths={}
   for service in deploy.SERVICES:
    p=root/service/'20261027T120000Z-1';p.mkdir(parents=True);(p/'binary').write_text('original');paths[service]=p
   live=root/'live';live.write_text('other deployment')
   state={'format':'ainvr-ptz-v1','phase':'applied','integrity':deploy.backup_inventory(paths),'allowedBinaries':{'onvif':[deploy.sha(paths['onvif']/'binary')]}}
   with patch.object(deploy,'BACKUPS',root),patch.object(deploy,'TARGETS',{'onvif':live}):
    with self.assertRaisesRegex(RuntimeError,'Concurrent binary'):deploy.check_rollback(state,paths)
 def test_invalid_transaction_refused(self):
  with self.assertRaisesRegex(RuntimeError,'Invalid rollback'):
   deploy.check_rollback({'format':'wrong'},{})
class RegressionTests(unittest.TestCase):
 def test_mixed_legacy_local_and_new_utc_order(self):
  # 20:20 CST is 12:20 UTC; the new 13:00 UTC backup is newer.
  self.assertLess(deploy.backup_time(Path('20261027T202001Z-1793103601261947030')),deploy.backup_time(Path('20261027T130000Z-1234')))
 def test_alarm_restore_needs_only_ssd_source(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);parent=root/'deploy/s100p/alarm-service';parent.mkdir(parents=True)
   backup=root/'ssd';(backup/'src').mkdir(parents=True);(backup/'src/main.mjs').write_text('saved source')
   old=root/'deleted-runtime';(backup/'dropin.conf').write_text('[Service]\nWorkingDirectory='+str(old)+'\nExecStart=node '+str(old/'src/main.mjs')+'\n')
   state={'oldAlarmSource':str(old/'src'),'dropinExisted':True,'integrity':{'alarm-service-src':deploy.files(backup/'src')}}
   with patch.object(deploy,'ROOT',root):
    restored,config=deploy.restore_alarm_runtime(state,backup)
    self.assertEqual((restored/'src/main.mjs').read_text(),'saved source')
    self.assertNotIn(str(old),config.read_text())
    self.assertTrue((restored/'node_modules').is_symlink())
 def test_retention_marks_joint_transaction_incomplete(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);record=root/'backend/20261027T130000Z-1/deployment.json';record.parent.mkdir(parents=True)
   removed=root/'gb28181/20261027T120000Z-1';record.write_text(json.dumps({'backups':{'gb28181':str(removed)}}))
   with patch.object(deploy,'BACKUPS',root):deploy.invalidate_transactions(removed)
   self.assertEqual(json.loads(record.read_text())['retentionRemoved'],[str(removed)])
 def test_runtime_cleanup_preserves_active_and_unknown(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);parent=root/'deploy/s100p/alarm-service';parent.mkdir(parents=True)
   active=parent/'release-ptz-current';old=parent/'release-ptz-old';unknown=parent/'release-ptz-unknown'
   for p in [active,old,unknown]:p.mkdir()
   for p in [active,old]:(p/'.ainvr-ptz-runtime.json').write_text(json.dumps({'managedBy':'deploy_ptz_release'}))
   with patch.object(deploy,'ROOT',root):deploy.prune_alarm_releases(active)
   self.assertTrue(active.exists());self.assertTrue(unknown.exists());self.assertFalse(old.exists())
if __name__=='__main__':unittest.main()
