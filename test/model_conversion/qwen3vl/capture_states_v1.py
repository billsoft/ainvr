"""Capture BF16 decoder states for items: per requested layer its input hidden, output hidden, cached k/v (post norm+rope);
plus cos/sin, deepstack embeds and visual mask. Optional teacher-forced answer token appended.
usage: capture_states_v1.py SPLIT N LAYERS(comma) OUTDIR [--answer]"""
import sys, json, os
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

split, count, layers, outdir = sys.argv[1], int(sys.argv[2]), [int(x) for x in sys.argv[3].split(',')], Path(sys.argv[4])
teacher = '--answer' in sys.argv
outdir.mkdir(parents=True, exist_ok=True)
DEV = os.environ.get('QDEV', 'cuda')
model, proc = load_model(device=DEV)
ref = {json.loads(l)['id']: json.loads(l) for l in Path(f'/qwork/ref/bf16-{split}-{os.environ.get("QITEMS", "v1")}.jsonl').read_text(encoding='utf-8').splitlines()} if teacher else {}
VER = os.environ.get('QITEMS', 'v1')
items = [json.loads(l) for l in Path(f'/qwork/data/items-{split}-{VER}.jsonl').read_text(encoding='utf-8').splitlines()]
if os.environ.get('QIDS'):
    items = [x for x in items if x['id'] in os.environ['QIDS'].split(',')]
items = items[:count]
lm = model.model.language_model
grab = {}


def pre(i):
    def f(mod, args, kwargs):
        h = args[0] if args else kwargs['hidden_states']
        grab[('in', i)] = h[0].float().cpu().numpy()
        if i == layers[0]:
            c, s = kwargs['position_embeddings']
            grab['cos'] = c[0].float().cpu().numpy(); grab['sin'] = s[0].float().cpu().numpy()
    return f


def post(i):
    def f(mod, args, kwargs, out):
        o = out[0] if isinstance(out, tuple) else out
        grab[('out', i)] = o[0].float().cpu().numpy()
    return f


hooks = []
for i in layers:
    hooks.append(lm.layers[i].register_forward_pre_hook(pre(i), with_kwargs=True))
    hooks.append(lm.layers[i].register_forward_hook(post(i), with_kwargs=True))
orig_ds = lm._deepstack_process


def ds_spy(h, mask, emb):
    grab.setdefault('ds', []).append(emb.float().cpu().numpy()); grab['vmask'] = mask[0].cpu().numpy()
    return orig_ds(h, mask, emb)


lm._deepstack_process = ds_spy
meta = []
with torch.inference_mode():
    for it in items:
        grab.clear()
        ans = None
        if teacher:
            ans = YES if ref[it['id']]['p_yes'] >= 0.5 else NO
        enc = build_inputs(proc, load_image(Path('/qwork/data') / it['image']), it['kind'], it['desc'], answer=ans)
        out = model(**{k: v.to(DEV) for k, v in enc.items()}, use_cache=True)
        d = outdir / it['id']; d.mkdir(exist_ok=True)
        pkv = out.past_key_values
        for i in layers:
            np.save(d / f'in-{i:02d}.npy', grab[('in', i)].astype(np.float32))
            np.save(d / f'out-{i:02d}.npy', grab[('out', i)].astype(np.float32))
            k, v = pkv.layers[i].keys, pkv.layers[i].values
            np.save(d / f'k-{i:02d}.npy', k[0].float().cpu().numpy()); np.save(d / f'v-{i:02d}.npy', v[0].float().cpu().numpy())
        np.save(d / 'cos.npy', grab['cos']); np.save(d / 'sin.npy', grab['sin'])
        np.save(d / 'deepstack.npy', np.stack(grab['ds']).astype(np.float32)); np.save(d / 'vmask.npy', grab['vmask'])
        np.save(d / 'last_logits.npy', out.logits[0, -1].float().cpu().numpy())
        meta.append(dict(id=it['id'], seq=int(enc['input_ids'].shape[1]), teacher_answer=ans))
for h in hooks:
    h.remove()
(outdir / 'meta.json').write_text(json.dumps(dict(split=split, layers=layers, teacher=teacher, items=meta), ensure_ascii=False, indent=1))
print('captured', len(meta))
