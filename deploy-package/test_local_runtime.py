import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('local_runtime',Path(__file__).with_name('verify-local-runtime.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class IntegrityTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.models=self.root/'ai-service/models';self.models.mkdir(parents=True)
  def put(name,data):
   p=self.models/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return p
  self.put=put
  q=put('llm/qwen3vl-4b-review-v3/embedding.bf16',b'embedding')
  self.manifest=put('llm/qwen3vl-4b-review-v3/llm-package.ainvr.json',json.dumps({'files':[{'path':q.name,'bytes':q.stat().st_size,'sha256':hashlib.sha256(q.read_bytes()).hexdigest()}]}).encode())
  for name in ['gpen_bfr_256.hbm','derived/s100p/yolo26x.hbm','derived/s100p/yolo26x-face.hbm','derived/s100p/yoloe-26x.hbm','derived/s100p/yoloe-26x-32.hbm']:
   p=put(name,name.encode());put(name+'.ainvr.json',json.dumps({'hbm_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}).encode())
 def test_valid_local_assets(self):self.assertTrue(module.verify(self.root)['passed'])
 def test_embedding_corruption_is_rejected(self):
  self.put('llm/qwen3vl-4b-review-v3/embedding.bf16',b'corrupt!!')
  with self.assertRaises(AssertionError):module.verify(self.root)
 def test_detector_corruption_is_rejected(self):
  self.put('derived/s100p/yolo26x.hbm',b'corrupt')
  with self.assertRaisesRegex(AssertionError,'Checksum mismatch'):module.verify(self.root)
 def test_missing_asset_is_rejected(self):
  (self.models/'gpen_bfr_256.hbm').unlink()
  with self.assertRaisesRegex(AssertionError,'Missing or externally'):module.verify(self.root)
 def test_manifest_escape_is_rejected_before_reading(self):
  self.manifest.write_text(json.dumps({'files':[{'path':'../../../outside','bytes':0,'sha256':'x'}]}))
  with self.assertRaisesRegex(AssertionError,'Out-of-package'):module.verify(self.root)
 def test_broken_discovery_link_is_rejected(self):
  (self.models/'obsolete.hbm').symlink_to(self.root/'missing')
  with self.assertRaisesRegex(AssertionError,'External or broken'):module.verify(self.root)
class InstallTest(unittest.TestCase):
 def test_existing_model_symlink_is_not_accepted_as_local_install(self):
  spec=importlib.util.spec_from_file_location('installer',Path(__file__).with_name('install-yoloe-s100p.py'))
  installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(tmp)/'source.hbm';source.write_bytes(b'model')
   destination=Path(tmp)/'model.hbm';destination.symlink_to(source)
   with self.assertRaises(AssertionError):installer.install_file(source,destination,installer.digest(source))
   self.assertTrue(destination.is_symlink())
if __name__=='__main__':unittest.main()

