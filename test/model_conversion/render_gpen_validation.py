"""Render fixed validation samples for manual GPEN color/detail inspection.

This is an offline test visualization, never a production image path or an
automatic accuracy approval. Optional HBM outputs must match input hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--reference', type=Path, required=True)
p.add_argument('--candidate', type=Path)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
assert not a.output.exists()
ref = json.loads((a.reference / 'manifest.json').read_text())
rows = sorted(ref['samples'], key=lambda row: row['id'])
assert len(rows) >= 8
selected = [rows[i] for i in np.linspace(0, len(rows)-1, 8, dtype=int)]
candidates = {}
if a.candidate:
    candidates = {r['id']: r for r in json.loads(
        (a.candidate / 'manifest.json').read_text())['samples']}
headers = ['Validation input', 'FP32 reference']
if a.candidate:
    headers.append('HBM BPU output')
canvas = Image.new('RGB', (256*len(headers), 290*len(selected)+24), 'white')
draw = ImageDraw.Draw(canvas)
for j, header in enumerate(headers):
    draw.text((j*256+8, 5), header, fill='black')

def rgb(tensor):
    assert tensor.shape == (1, 3, 256, 256), tensor.shape
    assert np.isfinite(tensor).all()
    pixels = np.clip((tensor[0].transpose(1, 2, 0)+1)*127.5, 0, 255)
    return Image.fromarray(np.rint(pixels).astype(np.uint8))

for i, row in enumerate(selected):
    path = a.inputs / (row['id']+'.bin')
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['input_sha256']
    tensors = [np.fromfile(path, dtype='<f4').reshape(1, 3, 256, 256)]
    with np.load(a.reference / (row['id']+'.npz')) as data:
        tensors.append(data['0'].copy())
    if a.candidate:
        assert candidates[row['id']]['input_sha256'] == row['input_sha256']
        with np.load(a.candidate / (row['id']+'.npz')) as data:
            tensors.append(data['0'].copy())
    y = 24+i*290
    draw.text((8, y), row['id'], fill='black')
    for j, tensor in enumerate(tensors):
        canvas.paste(rgb(tensor), (j*256, y+22))
a.output.parent.mkdir(parents=True, exist_ok=True)
canvas.save(a.output)
print(a.output)
