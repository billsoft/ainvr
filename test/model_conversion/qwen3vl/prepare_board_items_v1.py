"""PC: board evaluation bundle — prompt token ids per item (processor-exact), 896x448 images, BF16 token-embedding table
(fp16 copy, exact for bf16 values), vision rotary cos/sin. Output dir OUT (copied to the board SSD)."""
import sys, json, shutil
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *
from transformers import AutoProcessor
from safetensors import safe_open

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True); (out / 'images').mkdir(exist_ok=True)
proc = AutoProcessor.from_pretrained(str(MODEL)); proc.image_processor.size = {'shortest_edge': PIXELS, 'longest_edge': PIXELS}
for split in sys.argv[2:]:
    rows = []
    for it in [json.loads(l) for l in Path(f'/qwork/data/items-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()]:
        src = Path('/qwork/data') / it['image']; im = load_image(src)
        name = it['image'].replace('/', '__'); dst = out / 'images' / (Path(name).stem + '.png')
        if not dst.exists():
            im.save(dst)          # lossless: board sees exactly the pixels the PC reference saw
        enc = build_inputs(proc, im, it['kind'], it['desc'])
        rows.append(dict(id=it['id'], image_path=f'images/{dst.name}', input_ids=enc['input_ids'][0].tolist()))
    (out / f'items-{split}-v2.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
    print(split, len(rows))
if not (out / 'embed_tokens_bf16bits.npy').exists():
    idx = json.loads((MODEL / 'model.safetensors.index.json').read_text())['weight_map']; k = 'model.language_model.embed_tokens.weight'
    with safe_open(str(MODEL / idx[k]), framework='pt', device='cpu') as f:
        w = f.get_tensor(k)
    assert w.dtype == torch.bfloat16
    np.save(out / 'embed_tokens_bf16bits.npy', w.view(torch.int16).numpy().view(np.uint16))   # raw bf16 bits, exact
sys.path.insert(0, '/qwork/scripts')
import qwen3vl_bpu_vision_v1 as qv
_, c, s = qv.constants(); np.savez(out / 'vision_rope.npz', cos=c[:, 0].numpy(), sin=s[:, 0].numpy())
print('ok')
