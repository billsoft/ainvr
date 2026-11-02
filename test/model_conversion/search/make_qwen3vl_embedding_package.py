#!/usr/bin/env python3
"""Assemble the Qwen3-VL-Embedding-2B (O2) search model package into the shared models/search tree.
Run on the board as root. Idempotent: refuses to overwrite files whose content differs.
usage: make_qwen3vl_embedding_package.py RUN_O2_DIR TOKENIZER_DIR [MODELS_ROOT]"""
import hashlib, json, os, shutil, sys
from pathlib import Path
import numpy as np
import hbm_runtime

run = Path(sys.argv[1]); tok = Path(sys.argv[2])
root = Path(sys.argv[3] if len(sys.argv) > 3 else '/home/sunrise/ainvr/ai-service/models/search')
man = json.loads((run / 'manifest-o2-v2.json').read_text())
for d in ('hbm', 'data', 'tokenizers'):
    (root / d).mkdir(exist_ok=True)

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()

def put(src, rel):
    dst = root / rel
    if dst.exists():
        if sha(dst) != sha(src):
            raise SystemExit(f'exists and differs: {dst}')
    else:
        shutil.copyfile(src, dst)
    return dst

entries = []
def program_meta(pkg, hbm_name, role, index):
    rt = hbm_runtime.HB_HBMRuntime(str(pkg / 'model.hbm'))
    progs = {}
    for n in rt.model_names:
        ins = [{'name': k, 'shape': list(v), 'dtype': 'F32'} for k, v in sorted(dict(rt.input_shapes[n]).items(), key=lambda kv: int(kv[0].split('_')[-1]))]
        outs = [{'name': k, 'shape': list(v), 'dtype': 'F32'} for k, v in sorted(dict(rt.output_shapes[n]).items(), key=lambda kv: int(kv[0].split('_')[-1]))]
        progs[n] = {'inputs': ins, 'outputs': outs}
    dst = root / 'hbm' / hbm_name
    return {
        'schema_version': 1, 'target': 'rdk_s100p', 'hbm_file': hbm_name, 'hbm_sha256': sha(dst), 'hbm_bytes': dst.stat().st_size,
        'programs': progs, 'accuracy_verified': False, 'production_approved': False, 'role': role, 'index': index,
        'family': 'qwen3vl-embedding-2b', 'source': 'compiled by us (O2, same converted.bc as the verified O0 build)',
        'input_contract': 'float32 tensors, see programs; host does patchify, MRoPE, KV window layout, BF16 token lookup, L2 normalisation',
        'source_weights': 'Qwen/Qwen3-VL-Embedding-2B (Apache-2.0)',
    }

names = []
for g, p in enumerate(man['vision']):
    n = f'qwen3vl-emb-vis-{g}.hbm'; put(run / p / 'model.hbm', 'hbm/' + n); names.append((run / p, n, 'vision_group', g))
for g, p in enumerate(man['text']):
    n = f'qwen3vl-emb-txt-{g}.hbm'; put(run / p / 'model.hbm', 'hbm/' + n); names.append((run / p, n, 'text_group', g))
put(run / man['head'] / 'model.hbm', 'hbm/qwen3vl-emb-head.hbm'); names.append((run / man['head'], 'qwen3vl-emb-head.hbm', 'head', 0))
for pkg, n, role, i in names:
    meta = program_meta(pkg, n, role, i)
    (root / 'hbm' / (n + '.ainvr.json')).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + '\n')
    entries += ['hbm/' + n, 'hbm/' + n + '.ainvr.json']

# data files
emb = np.load(run / man['embedding'], mmap_mode='r')
assert emb.shape == (151936, 2048) and emb.dtype == np.uint16
t = root / 'data' / 'qwen3vl-embed-tokens-bf16.bin'
if not t.exists():
    with open(t, 'wb') as f:
        for i in range(0, emb.shape[0], 8192):
            f.write(np.ascontiguousarray(emb[i:i + 8192]).tobytes())
rope = np.load(run / man['vision_rope'])
(root / 'data' / 'qwen3vl-vision-rope.f32').write_bytes(np.concatenate([rope['cos'].astype('<f4').ravel(), rope['sin'].astype('<f4').ravel()]).tobytes())
kv = np.load(run / man['prefix_kv'])
assert kv['ids'].tolist() == [151644]
(root / 'data' / 'qwen3vl-prefix-kv.f32').write_bytes(b''.join(kv[f'{kind}{i}'].astype('<f4').tobytes() for i in range(28) for kind in 'kv'))
put(tok / 'vocab.json', 'tokenizers/qwen3vl-vocab.json'); put(tok / 'merges.txt', 'tokenizers/qwen3vl-merges.txt')
entries += ['data/qwen3vl-embed-tokens-bf16.bin', 'data/qwen3vl-vision-rope.f32', 'data/qwen3vl-prefix-kv.f32',
            'tokenizers/qwen3vl-vocab.json', 'tokenizers/qwen3vl-merges.txt']

# SHA256SUMS.txt: keep every existing line, replace/add ours.
sums = root / 'SHA256SUMS.txt'
lines = [l for l in sums.read_text().splitlines() if l.strip()]
mine = {'./' + e for e in entries}
kept = [l for l in lines if l[66:] not in mine and l[66:].lstrip('./') not in entries]
new = [f'{sha(root / e)}  ./{e}' for e in entries]
tmp = root / 'SHA256SUMS.txt.new'
tmp.write_text('\n'.join(kept + new) + '\n'); os.replace(tmp, sums)
print('ok', len(entries), 'artifacts')
