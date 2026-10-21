"""Capture BF16 vision references: pixel patches [1568,1536], block outputs (all 24), deepstack feats [3,392,2560], merged [392,2560].
usage: capture_vision_v1.py SPLIT COUNT OUTDIR [ITEMS_VERSION]"""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

split, count, outdir = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3]); ver = sys.argv[4] if len(sys.argv) > 4 else 'v2'
outdir.mkdir(parents=True, exist_ok=True)
model, proc = load_model()
vis = model.model.visual
items = [json.loads(l) for l in Path(f'/qwork/data/items-{split}-{ver}.jsonl').read_text(encoding='utf-8').splitlines()]
images = list(dict.fromkeys(it['image'] for it in items))[:count]
grab = {}
hooks = [b.register_forward_hook(lambda m, a, o, i=i: grab.__setitem__(i, o[0].float().cpu().numpy() if isinstance(o, tuple) else o.float().cpu().numpy())) for i, b in enumerate(vis.blocks)]
meta = []
with torch.inference_mode():
    for n, img in enumerate(images):
        grab.clear()
        enc = build_inputs(proc, load_image(Path('/qwork/data') / img), '人员', '画面中出现人员')
        pv = enc['pixel_values'].cuda(); thw = enc['image_grid_thw'].cuda()
        merged, ds = vis(pv.to(vis.dtype), grid_thw=thw)
        d = outdir / f'img-{n:03d}'; d.mkdir(exist_ok=True)
        np.save(d / 'patches.npy', pv.float().cpu().numpy())
        np.save(d / 'blocks.npy', np.stack([grab[i] for i in range(len(vis.blocks))]).astype(np.float16))
        np.save(d / 'deepstack.npy', np.stack([x.float().cpu().numpy() for x in ds])); np.save(d / 'merged.npy', merged.float().cpu().numpy())
        meta.append(dict(dir=d.name, image=img))
for h in hooks:
    h.remove()
(outdir / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
print('captured', len(meta))
