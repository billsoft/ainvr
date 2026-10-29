"""Private tmp-only cleanup/quota checks; no real disk discovery or deletion."""
import importlib.util,os,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('managed_fixture_storage',Path(__file__).with_name('managed_fixture_storage.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class StorageTests(unittest.TestCase):
 def check(self,path):
  fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
  try:return module.scan(fd,path.stat().st_dev,os.geteuid())
  finally:os.close(fd)
 def test_exact_bounded_tree_removal_leaves_outside_untouched(self):
  with tempfile.TemporaryDirectory()as tmp:
   parent=Path(tmp);root=parent/'owned';root.mkdir();(root/'shard').mkdir();(root/'shard/1.f32').write_bytes(b'abc');outside=parent/'outside';outside.write_bytes(b'keep')
   entries,count,size=self.check(root);self.assertEqual((count,size),(2,3))
   fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   try:module.remove_entries(fd,entries)
   finally:os.close(fd)
   self.assertEqual(list(root.iterdir()),[]);self.assertEqual(outside.read_bytes(),b'keep')
 def test_symlink_is_not_followed(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'link').symlink_to('/etc')
   with self.assertRaisesRegex(ValueError,'identity'):self.check(root)
 def test_hardlink_is_not_accepted(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'a').write_bytes(b'x');os.link(root/'a',root/'b')
   with self.assertRaisesRegex(ValueError,'object'):self.check(root)
 def test_byte_quota_is_hard(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp)
   with(root/'big').open('wb')as f:f.truncate(module.MAX_BYTES+1)
   with self.assertRaisesRegex(ValueError,'quota'):self.check(root)
 def test_concurrent_replacement_is_refused_before_unlink(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'a').write_text('a');entries,_,_=self.check(root);(root/'a').rename(root/'old');(root/'a').write_text('replacement')
   fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   try:
    with self.assertRaisesRegex(ValueError,'changed'):module.remove_entries(fd,entries)
   finally:os.close(fd)
   self.assertTrue((root/'a').exists());self.assertTrue((root/'old').exists())
 def test_capacity_profile_does_not_change_default_quota(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'mongo').mkdir();(root/'index').mkdir()
   with(root/'mongo/data').open('wb')as f:f.truncate(module.MAX_BYTES+1)
   with self.assertRaisesRegex(ValueError,'quota'):self.check(root)
   fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   try:entries,_,_=module.scan(fd,root.stat().st_dev,os.geteuid(),max_bytes=module.CAPACITY_MONGO_BYTES+module.CAPACITY_INDEX_BYTES)
   finally:os.close(fd)
   self.assertEqual(module.capacity_usage(entries)['mongo']['logical_bytes'],module.MAX_BYTES+1)
 def test_capacity_index_quota_is_independent_of_mongo_headroom(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'mongo').mkdir();(root/'index').mkdir()
   with(root/'index/data').open('wb')as f:f.truncate(module.CAPACITY_INDEX_BYTES+1)
   fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   try:entries,_,_=module.scan(fd,root.stat().st_dev,os.geteuid(),max_bytes=module.CAPACITY_MONGO_BYTES+module.CAPACITY_INDEX_BYTES)
   finally:os.close(fd)
   with self.assertRaisesRegex(ValueError,'quota'):module.capacity_usage(entries)
if __name__=='__main__':unittest.main()
