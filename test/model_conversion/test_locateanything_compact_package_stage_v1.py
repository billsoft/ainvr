"""Real tar/OS-link controls with tiny synthetic payloads;no model or NN proof."""
from pathlib import Path
import copy,hashlib,json,os,tarfile,tempfile,time,unittest
import stage_locateanything_compact_decoder_package_v1 as stage
ROOT=Path('/home/sunrise/ainvr')
def fixture(root):
 source=root/'source';source.mkdir();entries=[]
 for i in (0,9,18,27):
  ar=None
  for profile in ['ar','prefill']:
   directory=f'group-{i:02d}-{i+8:02d}-{profile}';d=source/directory;d.mkdir()
   if ar is None:(d/'model.hbm').write_bytes(('SYNTHETIC-NOT-MODEL-'+str(i)).encode());ar=d/'model.hbm'
   else:os.link(ar,d/'model.hbm')
   for f in stage.FILES-{'model.hbm'}:(d/f).write_text('synthetic-'+f+'-'+directory)
   files={f:stage.digest(d/f) for f in stage.FILES}
   entries.append(dict(start=i,end=i+8,profile=profile,directory=directory,sequence=1,hbm_sha256=files['model.hbm'],files=files))
 manifest=dict(schema='compact_original_decoder_groups_v1',status='complete_compact_decoder_profiles',source_sha256=stage.PACKAGER,builder_sha256=stage.BUILDER,original_decoder_layers=36,profile_sequence_capacities={'ar':1,'prefill':1},required_profiles=['ar','prefill'],enabled_generation_modes=['slow'],evaluation_only=True,release_approved=False,components=entries)
 (source/'manifest.json').write_text(json.dumps(manifest));archive=root/'fixture.tar'
 with tarfile.open(archive,'w') as tf:
  for p in sorted(source.rglob('*')):
   if p.is_file():tf.add(p,arcname=p.relative_to(source).as_posix(),recursive=False)
 return archive,stage.digest(source/'manifest.json')

class StageControls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=ROOT/'test/results',prefix='compact-package-control-');self.root=Path(self.temp.name);self.archive,self.sha=fixture(self.root)
 def tearDown(self):self.temp.cleanup()
 def opened(self):return tarfile.open(self.archive,'r:')
 def test_real_tar_internal_hardlinks_and_extraction(self):
  with self.opened() as tf:
   manifest,members,expected,links=stage.inspect(tf,self.sha);self.assertEqual(len(links),4)
   out=self.root/'out';out.mkdir();stage.extract(tf,members,expected,out,os.getuid(),os.getgid())
   for link in links:self.assertEqual((out/link['name']).stat().st_ino,(out/link['target']).stat().st_ino)
 def test_changed_manifest_hash_rejected(self):
  with self.opened() as tf:
   with self.assertRaises(AssertionError):stage.inspect(tf,'0'*64)
 def test_noncanonical_names_rejected(self):
  for s in ['../escape','/escape','group/../escape','./file','group//file','group\\file']:
   with self.assertRaises(AssertionError):stage.canonical(s)
 def test_escaping_hardlink_rejected(self):
  with self.opened() as tf:
   members=tf.getmembers();next(m for m in members if m.islnk()).linkname='../escape'
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
 def test_cross_group_hardlink_rejected(self):
  with self.opened() as tf:
   tf.getmembers();tf.getmember('group-09-17-prefill/model.hbm').linkname='group-00-08-ar/model.hbm'
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
 def test_symlink_is_not_hardlink(self):
  with self.opened() as tf:
   m=next(m for m in tf.getmembers() if m.islnk());m.type=tarfile.SYMTYPE
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
 def test_duplicate_tar_member_rejected(self):
  with self.opened() as tf:
   members=tf.getmembers();members[-1].name=members[0].name
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
 def test_reordered_forward_hardlink_rejected(self):
  with self.opened() as tf:
   members=tf.getmembers();link=next(m for m in members if m.islnk());members.remove(link);members.insert(0,link)
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
 def test_changed_payload_rejected_before_publication(self):
  with self.opened() as tf:
   _,members,expected,_=stage.inspect(tf,self.sha);expected['group-00-08-ar/model.hbm']='0'*64
   out=self.root/'out';out.mkdir()
   with self.assertRaises(AssertionError):stage.extract(tf,members,expected,out,os.getuid(),os.getgid())
 def test_missing_member_rejected(self):
  with self.opened() as tf:
   tf.getmembers().pop()
   with self.assertRaises(AssertionError):stage.inspect(tf,self.sha)
if __name__=='__main__':
 out=ROOT/'test/results/locateanything-compact-package-stage-controls-v1.json';assert not out.exists()
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(StageControls))
 out.write_text(json.dumps(dict(status='passed' if result.wasSuccessful() else 'failed',checked=time.time(),tests_run=result.testsRun,failures=[(t.id(),m) for t,m in result.failures],errors=[(t.id(),m) for t,m in result.errors],source_sha256=stage.digest(__file__),stager_sha256=stage.digest(Path(stage.__file__)),synthetic_payloads_only=True,actual_tar_and_hardlink_syscalls=True,neural_calls=0,actual_model_packaged=False),indent=2)+'\n');assert result.wasSuccessful()
