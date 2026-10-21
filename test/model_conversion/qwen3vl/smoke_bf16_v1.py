"""Smoke test: BF16 Qwen3-VL alarm-review yes/no on a few COCO images; reports token counts and timing."""
import sys, time, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

model, proc = load_model()
y, n = answer_token_ids(proc)
root = Path('/qwork/la-images/locate-fresh-final-images-v1')
imgs = sorted(root.glob('*.jpg'))[:3]
cases = [('人员闯入', '检测到有人员进入监控区域'), ('烟火', '检测到画面中出现明火或烟雾')]
res = []
for p in imgs:
    im = load_image(p)
    for kind, desc in cases:
        enc = build_inputs(proc, im, kind, desc)
        torch.cuda.synchronize(); t = time.time()
        r = yes_no(model, proc, enc)
        torch.cuda.synchronize()
        r.update(image=p.name, kind=kind, seq=int(enc['input_ids'].shape[1]),
                 top1_text=proc.tokenizer.decode([r['top1']]), sec=round(time.time() - t, 3))
        res.append(r); print(json.dumps(r, ensure_ascii=False))
print('yes/no ids', y, n, 'gpu peak GB', torch.cuda.max_memory_allocated() / 1e9)
