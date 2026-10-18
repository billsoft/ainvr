"""Prepare a new static prompt-slot candidate from the disjoint approved dataset.
Keeps image split/hash identities; regenerates text sets for the changed graph.
"""
import argparse, hashlib, json
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--prepared',type=Path,required=True)
p.add_argument('--onnx',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--oracle',type=Path)
p.add_argument('--slots',type=int,choices=[32],default=32)
a=p.parse_args();a.output.mkdir(exist_ok=False)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
base=json.loads((a.prepared/'manifest.json').read_text())
oracle=np.load(a.oracle or a.prepared/'coco80-prompt-oracle.npz')
vectors=oracle['prompt_embeddings'];names=oracle['class_names'].tolist()
assert vectors.shape==(1,80,512)
rng=np.random.default_rng(20261013);rows=[]
for i,item in enumerate(base['samples']):
    selected=list(dict.fromkeys(item['source_classes']));rng.shuffle(selected)
    selected=selected[:a.slots]
    for c in rng.permutation(80).tolist():
        if len(selected)==a.slots:break
        if c not in selected:selected.append(c)
    active=a.slots if i%4 else [1,8,16,24][(i//4)%4]
    prompt=np.zeros((1,a.slots,512),dtype=np.float32)
    prompt[:,:active]=vectors[:,selected[:active]]
    path=Path(item['prompt_file']);(a.output/path).parent.mkdir(exist_ok=True)
    prompt.tofile(a.output/path)
    rows.append(dict(item,prompt_sha256=sha(a.output/path),class_ids=selected,
                     class_names=[names[c] for c in selected],active_count=active))
base.update(samples=rows,prompt_slots=a.slots,detector_onnx_sha256=sha(a.onnx),
            source_manifest_sha256=sha(a.prepared/'manifest.json'),production_approved=False,
            scope='32-slot candidate calibration/validation; old images and splits preserved')
(a.output/'manifest.json').write_text(json.dumps(base,indent=2))
print(json.dumps({'slots':a.slots,'samples':len(rows),'onnx_sha256':sha(a.onnx)}))
