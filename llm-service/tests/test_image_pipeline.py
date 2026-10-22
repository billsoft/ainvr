"""Hardware preprocessing parity; Pillow/numpy are test oracles only."""
import json
from pathlib import Path
import subprocess
import sys
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'test/model_conversion/qwen3vl'))
from qwen3vl_host_v1 import patchify
work=Path('/mnt/ainvr-ssd/llm-eval/image-pipeline');work.mkdir(exist_ok=True)
probe='/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_image_probe'
cases=[]
for width,height in [(896,448),(1920,960),(1280,640),(448,224)]:
    rng=np.random.default_rng(42)
    rgb=rng.integers(0,256,(height,width,3),dtype=np.uint8)
    rgba=np.concatenate([rgb,np.full((height,width,1),255,np.uint8)],axis=2)
    src=work/f'{width}.rgba';dst=work/f'{width}.f32';rgba.tofile(src)
    p=subprocess.run([probe,'rgba',str(src),str(width),str(height),str(dst)],capture_output=True,text=True,timeout=30)
    (work/f'{width}.log').write_text(p.stdout+p.stderr)
    if p.returncode:raise RuntimeError(p.stderr[-2000:])
    expected=patchify(np.asarray(Image.fromarray(rgb).resize((896,448),Image.BICUBIC)))
    actual=np.fromfile(dst,np.float32).reshape(expected.shape)
    cases.append(dict(width=width,height=height,bitwise_equal=bool(np.array_equal(actual.view(np.uint32),expected.view(np.uint32))),
                      maximum_error=float(np.max(np.abs(actual-expected))),mean_error=float(np.mean(np.abs(actual-expected)))))
    if width==896:assert cases[-1]['bitwise_equal'],cases[-1]
(ROOT/'test/results/llm-service-development/image-pipeline.json').write_text(json.dumps(cases,indent=2))
print(json.dumps(cases))
