"""Verify numpy host glue against HF: patches, MRoPE positions, cos/sin (layer-0 position embeddings)."""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *
import qwen3vl_host_v1 as hv

model, proc = load_model(device="cpu")
items = [json.loads(l) for l in Path('/qwork/data/items-dev-v2.jsonl').read_text(encoding='utf-8').splitlines()][:4]
grab = {}
h = model.model.language_model.layers[0].register_forward_pre_hook(lambda m, a, k: grab.update(pe=k['position_embeddings']), with_kwargs=True)
for it in items:
    im = load_image(Path('/qwork/data') / it['image'])
    enc = build_inputs(proc, im, it['kind'], it['desc'])
    p_np = hv.patchify(np.asarray(im, np.uint8)); p_hf = enc['pixel_values'].float().numpy()
    ids = enc['input_ids'][0].tolist()
    pos_hf, _ = model.model.get_rope_index(enc['input_ids'], enc['image_grid_thw'], None, enc['attention_mask'])
    pos = hv.rope_index(ids)
    with torch.inference_mode():
        model(**enc)
    c_hf, s_hf = [x[0].float().cpu().numpy() for x in grab['pe']]
    c, s = hv.mrope_cos_sin(pos)
    print(it['id'], 'patch_maxabs', float(np.abs(p_np - p_hf).max()), 'pos_equal', bool((pos == pos_hf[:, 0].numpy()).all()),
          'cos_maxabs', float(np.abs(c - c_hf).max()), 'sin_maxabs', float(np.abs(s - s_hf).max()))
h.remove()
