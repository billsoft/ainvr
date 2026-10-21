"""Frozen BF16 reference v2 (items v2)."""
import sys, json, time
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

model, proc = load_model()
outdir = Path('/qwork/ref'); outdir.mkdir(exist_ok=True)
for split in sys.argv[1:] or ['calib', 'dev', 'final']:
    items = [json.loads(l) for l in Path(f'/qwork/data/items-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()]
    dst = outdir / f'bf16-{split}-v2.jsonl'
    t0 = time.time()
    with dst.open('w', encoding='utf-8') as f:
        for it in items:
            p = Path('/qwork/data') / it['image']
            enc = build_inputs(proc, load_image(p), it['kind'], it['desc'])
            r = yes_no(model, proc, enc)
            r.update(id=it['id'], image_sha256=sha256_file(p), seq=int(enc['input_ids'].shape[1]))
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(split, len(items), round(time.time() - t0, 1), 's')
