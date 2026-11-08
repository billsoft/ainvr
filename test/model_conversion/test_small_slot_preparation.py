"""Software fixture: slot packing, inactive zero padding and split preservation."""
import unittest,tempfile,json,subprocess,sys
from pathlib import Path
import numpy as np
class SmallSlotPreparation(unittest.TestCase):
 def test_slots_and_padding(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);base=root/'base';base.mkdir();model=root/'fixture.onnx';model.write_bytes(b'fixture hash only; no inference')
   rows=[{'source_classes':[0,1,2],'prompt_file':f'prompts/{i}.bin','split':'validation' if i%2 else 'calibration','image_sha256':str(i)} for i in range(16)]
   (base/'manifest.json').write_text(json.dumps({'samples':rows}))
   np.savez(base/'coco80-prompt-oracle.npz',prompt_embeddings=np.ones((1,80,512),np.float32),class_names=np.array([str(i) for i in range(80)]))
   for slots in (1,2,32):
    out=root/str(slots);subprocess.run([sys.executable,str(Path(__file__).with_name('prepare_yoloe_prompt_slots.py')),'--prepared',str(base),'--onnx',str(model),'--output',str(out),'--slots',str(slots)],check=True,capture_output=True)
    result=json.loads((out/'manifest.json').read_text())
    for source,row in zip(rows,result['samples']):
     self.assertEqual(source['split'],row['split']);self.assertEqual(source['image_sha256'],row['image_sha256']);self.assertLessEqual(row['active_count'],slots)
     tensor=np.fromfile(out/row['prompt_file'],dtype=np.float32).reshape(1,slots,512)
     self.assertTrue((tensor[:,:row['active_count']]==1).all());self.assertTrue((tensor[:,row['active_count']:]==0).all())
if __name__=='__main__':unittest.main()
