#!/usr/bin/env python3
"""Test-only CPU preprocessing and Python BPU oracle. Run under a board guard.
No independent validation-set items are selected by this development tool.
"""
import argparse
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'test/model_conversion/qwen3vl'))
import qwen3vl_host_v1 as ref


def prepare(output, count):
    output=Path(output); output.mkdir(parents=True,exist_ok=True)
    root=Path('/mnt/ainvr-ssd/qwen3vl/run-v1')
    items=[json.loads(s) for s in (root/'items-dev-v2.jsonl').read_text().splitlines()][:count]
    fixtures=[]
    for it in items:
        path=output/(it['id']+'.patches.f32')
        rgb=np.asarray(Image.open(root/it['image_path']).convert('RGB'))
        ref.patchify(rgb).astype('<f4').tofile(path)
        fixtures.append(dict(id=it['id'],input_ids=it['input_ids'],patches=str(path)))
    (output/'fixtures.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in fixtures))
    (output/'reference-items.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in items))
    print(json.dumps(dict(items=len(items),output=str(output))))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--count',type=int,default=20)
    a=p.parse_args()
    if not 1<=a.count<=20:raise ValueError('development reference limit 1..20')
    prepare(a.output,a.count)
