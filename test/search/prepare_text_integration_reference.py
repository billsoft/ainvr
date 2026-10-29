#!/usr/bin/env python3
"""Prepare read-only text integration references. No neural inference."""
import argparse, hashlib, json, re
from pathlib import Path
import numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--all', action='store_true', help='Use the bounded complete 128-query numerical set')
args = parser.parse_args()
root = Path('/mnt/ainvr-ssd/search-models/text-siglip2-tbl8')
texts = json.loads((root/'prompts.json').read_text())['eval']
reference = np.load(root/'eval_text_float.npy', allow_pickle=False)
board = np.load(root/'eval_text_hbm.npy', allow_pickle=False)
assert reference.shape == board.shape == (len(texts),768)
indices = [next(i for i,x in enumerate(texts) if re.search('[\u3400-\u9fff]',x)),
           next(i for i,x in enumerate(texts) if re.search('[A-Za-z]',x) and not re.search('[\u3400-\u9fff]',x))]
if args.all:
    assert len(texts) <= 128
    indices = list(range(len(texts)))
rows = [dict(id=i,text=texts[i],reference=reference[i].astype(float).tolist(),previous_hbm=board[i].astype(float).tolist()) for i in indices]
output = Path('/home/sunrise/ainvr/test/results/search-text-integration') / ('input-all.json' if args.all else 'input.json')
output.parent.mkdir(parents=True,exist_ok=True)
value = dict(model='siglip2-base-full-int8',inputs=rows,source_sha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'prompts.json',root/'eval_text_float.npy',root/'eval_text_hbm.npy']})
output.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
print(json.dumps(dict(rows=len(rows),indices=indices,texts=[texts[i] for i in indices],input_file=str(output)),ensure_ascii=False))
