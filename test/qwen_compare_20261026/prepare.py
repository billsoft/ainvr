from pathlib import Path
import json,hashlib
ROOT=Path('/home/sunrise/ainvr/test/results/qwen-compare-20261026')
MODELS={'vl':('/mnt/ainvr-ssd/qwen3vl/run-v1','manifest-o2-v3.json'),'q35':('/mnt/ainvr-ssd/qwen35/run-v1','manifest-o2.json')}
def rows(p):return [json.loads(l) for l in p.read_text().splitlines()]
labels=rows(ROOT/'vl-labels.jsonl')
assert labels==rows(ROOT/'q35-labels.jsonl') and len(labels)==559
metadata={}
for name,(base,manifest) in MODELS.items():
 base=Path(base);m=json.loads((base/manifest).read_text())
 for k in ['vision','text']:m[k]=[str((base/p).resolve()) for p in m[k]]
 for k in ['head','embedding','vision_rope']:m[k]=str((base/m[k]).resolve())
 (ROOT/(name+'-manifest.json')).write_text(json.dumps(m,indent=2))
 data=rows(base/'items-final-v2.jsonl');assert [r['id'] for r in data]==[r['id'] for r in labels]
 images={}
 for r in data:
  path=base/r['image_path'];r['image_path']=str(path.resolve());images[r['id']]=hashlib.sha256(path.read_bytes()).hexdigest()
 (ROOT/(name+'-final.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in data))
 hashes={}
 for p in m['vision']+m['text']+[m['head']]:
  path=Path(p)/'model.hbm';h=hashlib.sha256()
  with path.open('rb') as f:
   for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
  hashes[str(path)]={'sha256':h.hexdigest(),'bytes':path.stat().st_size}
 metadata[name]={'packages':hashes,'package_bytes':sum(x['bytes'] for x in hashes.values()),'images':images,'sequence_lengths':[len(r['input_ids']) for r in data]}
assert metadata['vl']['images']==metadata['q35']['images']
(ROOT/'model-identity.json').write_text(json.dumps(metadata,indent=2))
print('Verified 559 identical image inputs and label records; froze all HBM hashes',flush=True)
