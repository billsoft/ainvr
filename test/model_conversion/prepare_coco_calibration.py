"""AINVR offline calibration: deterministic class coverage, separate validation.

CPU preprocessing here is an offline compiler input generator, not production.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path
import numpy as np
from PIL import Image

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--images', type=Path, required=True)
p.add_argument('--labels', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--calibration-count', type=int, default=512)
p.add_argument('--validation-count', type=int, default=128)
a = p.parse_args()
assert 80 <= a.calibration_count <= 2048 and 32 <= a.validation_count <= 512
a.output.mkdir(parents=True, exist_ok=False)
files = sorted(a.images.glob('*.jpg'))
random.Random(20261012).shuffle(files)
hist = np.zeros(80, dtype=np.int64)
selected, validation = [], []
scanned = 0
for path in files:
    scanned += 1
    label = a.labels / (path.stem + '.txt')
    rows = [list(map(float, s.split())) for s in label.read_text().splitlines() if s.strip()]
    assert all(len(r) == 5 and 0 <= int(r[0]) < 80 and all(0 <= v <= 1 for v in r[1:]) for r in rows), path
    classes = sorted(set(int(r[0]) for r in rows))
    if len(selected) < a.calibration_count and (len(selected) < a.calibration_count // 2 or any(hist[c] < 12 for c in classes)):
        selected.append((path, classes))
        hist[classes] += 1
    elif len(validation) < a.validation_count:
        validation.append((path, classes))
    if len(selected) == a.calibration_count and len(validation) == a.validation_count:
        break
    if scanned >= 4096:
        break
if len(selected) < a.calibration_count:
    used = {x[0] for x in selected + validation}
    for path in files:
        if path in used:
            continue
        rows = [list(map(float, s.split())) for s in (a.labels / (path.stem + '.txt')).read_text().splitlines() if s.strip()]
        classes = sorted(set(int(r[0]) for r in rows))
        selected.append((path, classes)); hist[classes] += 1
        if len(selected) == a.calibration_count:
            break
assert len(selected) == a.calibration_count and len(validation) == a.validation_count
assert not set(x[0] for x in selected) & set(x[0] for x in validation)
manifest = {'seed': 20261012, 'source_images': str(a.images.resolve()), 'total_available': len(files),
            'scanned_labels': scanned, 'class_image_counts': hist.tolist(),
            'preprocess': {'rgb': True, 'size': [640,640], 'layout': 'NCHW', 'dtype': 'float32',
                           'scale': 1/255, 'letterbox_value': 114, 'resize': 'PIL bilinear; offline reference; hardware parity pending'},
            'accuracy_validated': False, 'source_sha256_split_disjoint': False, 'items': []}
source_hashes = {'calibration': set(), 'validation': set()}
for split, items in [('calibration', selected), ('validation', validation)]:
    directory = a.output / split
    directory.mkdir()
    for i, (path, classes) in enumerate(items):
        original = path.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        source_hashes[split].add(digest)
        with Image.open(path) as image:
            image = image.convert('RGB'); w,h = image.size
            scale = min(640/w,640/h); nw,nh=round(w*scale),round(h*scale)
            canvas = Image.new('RGB', (640,640), (114,114,114))
            canvas.paste(image.resize((nw,nh), Image.Resampling.BILINEAR), ((640-nw)//2,(640-nh)//2))
            arr=np.ascontiguousarray(np.asarray(canvas,dtype=np.float32).transpose(2,0,1)[None]/255)
        target=directory/(path.stem+'.bin'); arr.tofile(target)
        manifest['items'].append({'split':split,'source':path.name,'source_sha256':digest,'classes':classes,
                                  'shape':[w,h],'tensor':str(target.relative_to(a.output)),
                                  'tensor_sha256':hashlib.sha256(arr.tobytes()).hexdigest()})
        if i % 64 == 0: print(split,i,flush=True)
assert not source_hashes['calibration'] & source_hashes['validation'], 'Duplicate source images across splits'
manifest['source_sha256_split_disjoint']=True
(a.output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'calibration':len(selected),'validation':len(validation),'classes_covered':int((hist>0).sum()),'minimum_class_images':int(hist.min())}),flush=True)
