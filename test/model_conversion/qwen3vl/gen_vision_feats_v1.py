"""PC: BF16 vision-tower outputs per bundle image (merged + 3 deepstack), stored as raw bf16 bits (exact) for a
text-only board attribution run. usage: gen_vision_feats_v1.py BUNDLE_DIR SPLIT"""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

bundle, split = Path(sys.argv[1]), sys.argv[2]
out = bundle / 'vision-bf16'; out.mkdir(exist_ok=True)
model, proc = load_model(); vis = model.model.visual
rows = [json.loads(l) for l in (bundle / f'items-{split}-v2.jsonl').read_text().splitlines()]
done = 0
with torch.inference_mode():
    for r in rows:
        dst = out / (Path(r['image_path']).stem + '.npy')
        if dst.exists():
            continue
        im = load_image(bundle / r['image_path'])
        enc = proc.image_processor(images=[im], return_tensors='pt')
        merged, ds = vis(enc['pixel_values'].cuda().to(vis.dtype), grid_thw=enc['image_grid_thw'].cuda())
        a = torch.stack([merged] + list(ds)).to(torch.bfloat16).cpu()
        np.save(dst, a.view(torch.int16).numpy().view(np.uint16)); done += 1
print('saved', done)
