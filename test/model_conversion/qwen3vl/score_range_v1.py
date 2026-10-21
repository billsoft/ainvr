"""Max raw attention score (q.k/sqrt(d), before masking) over UNMASKED entries for every layer of BF16 runs — sizes the mask value."""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *
model, proc = load_model(device='cpu')
from transformers.models.qwen3_vl import modeling_qwen3_vl as M
stats = {}
orig = M.eager_attention_forward
def spy(module, q, k, v, mask, scaling, **kw):
    kk = M.repeat_kv(k, module.num_key_value_groups); s = (q.float() @ kk.float().transpose(2, 3)) * scaling
    if mask is not None:
        s = s.masked_fill(mask[:, :, :, :kk.shape[-2]] < -1, float('nan'))
    li = getattr(module, 'layer_idx', -1)
    if li >= 0:
        cur = stats.get(li, [-1e9, 1e9]); stats[li] = [max(cur[0], float(np.nanmax(s.numpy()))), min(cur[1], float(np.nanmin(s.numpy())))]
    return orig(module, q, k, v, mask, scaling, **kw)
M.eager_attention_forward = spy
model.config.text_config._attn_implementation = 'eager'
for l in model.model.language_model.layers: l.self_attn.config._attn_implementation = 'eager'
items = [json.loads(l) for l in Path('/qwork/data/items-dev-v2.jsonl').read_text(encoding='utf-8').splitlines()][:3]
with torch.inference_mode():
    for it in items:
        model(**build_inputs(proc, load_image(Path('/qwork/data') / it['image']), it['kind'], it['desc']))
print('global max', max(v[0] for v in stats.values()), 'global min', min(v[1] for v in stats.values()))
print({k: [round(x, 1) for x in v] for k, v in sorted(stats.items())})
