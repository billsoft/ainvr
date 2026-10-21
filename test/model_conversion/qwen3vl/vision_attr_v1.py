"""Vision attribution on PC: chain the 4 fake-quant vision groups (activation fake-quant as built; weights per --weights
float|rtn|gptq-dir) from pixel patches; report chained feature error vs BF16 and, with --e2e, the yes/no agreement when
these features replace the BF16 vision tower inside the BF16 text model.
usage: vision_attr_v1.py OUT --weights rtn [--e2e]"""
import sys, json, time
sys.path.insert(0, '/qwork/scripts')
import qwen3vl_bpu_vision_v1 as qv
from qwen3vl_common_v1 import *
from leap_llm.nn.modules import FakeQuantLinear

out = Path(sys.argv[1]); mode = sys.argv[sys.argv.index('--weights') + 1]; e2e = '--e2e' in sys.argv
out.mkdir(parents=True, exist_ok=True)
SPLITS = [(0, 6), (6, 12), (12, 18), (18, 24)]
dev = 'cuda'


def rel(a, b):
    return float(np.linalg.norm(a - b) / np.linalg.norm(b))


groups = []
for a, b in SPLITS:
    g = qv.VisionGroup(a, b, rope_inputs=True).eval(); g.compile_mode(False)
    if mode != 'float':
        for n, m in g.named_modules():
            if isinstance(m, FakeQuantLinear):
                W = m.weight.data.float(); s = (W.abs().amax(1, keepdim=True) / 127).clamp_min(1e-12)
                m.weight.data.copy_(torch.round(W / s).clamp(-127, 127) * s); m.absmax_weight = None
    groups.append(g.to(dev))
cs = [torch.from_numpy(x).to(dev) for x in groups[0].rope_arrays()]
calib = sorted(x for x in Path('/qwork/cap/vision-calib-v1').iterdir() if x.is_dir())
with torch.inference_mode():
    for d in calib:          # same calibration feeding as the builders: each group sees BF16 block outputs
        blocks = np.load(d / 'blocks.npy').astype(np.float32)
        for (a, b), g in zip(SPLITS, groups):
            x = np.load(d / 'patches.npy') if a == 0 else blocks[a - 1]
            g(torch.from_numpy(x.astype(np.float32)).to(dev), *cs)


def chain(patches):
    h = patches; ds = []
    for g in groups:
        o = g(h, *cs); h = o[0]; ds += list(o[1:])
    return h, ds


r = dict(mode=mode, chained=[])
with torch.inference_mode():
    for d in sorted(x for x in Path('/qwork/cap/vision-dev-v1').iterdir() if x.is_dir()):
        merged, ds = chain(torch.from_numpy(np.load(d / 'patches.npy')).to(dev))
        ref_ds = np.load(d / 'deepstack.npy')
        r['chained'].append(dict(item=d.name, merged=rel(merged.float().cpu().numpy(), np.load(d / 'merged.npy')),
                                 deepstack=[rel(x.float().cpu().numpy(), y) for x, y in zip(ds, ref_ds)]))
print(json.dumps(r['chained'], indent=1), flush=True)
if e2e:
    model, proc = load_model()

    class FQVisual(torch.nn.Module):
        def __init__(self, orig):
            super().__init__(); self.orig = orig; self.dtype = orig.dtype; self.spatial_merge_size = orig.spatial_merge_size

        def forward(self, pv, grid_thw=None, **kw):
            merged, ds = chain(pv.float())
            return merged.to(self.dtype), [x.to(self.dtype) for x in ds]

    model.model.visual = FQVisual(model.model.visual)
    for split in ['dev', 'final']:
        ref = {json.loads(l)['id']: json.loads(l) for l in Path(f'/qwork/ref/bf16-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()}
        rows = []
        for it in [json.loads(l) for l in Path(f'/qwork/data/items-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()]:
            enc = build_inputs(proc, load_image(Path('/qwork/data') / it['image']), it['kind'], it['desc'])
            q = yes_no(model, proc, enc); b = ref[it['id']]
            rows.append(dict(id=it['id'], label=it['label'], p_ref=b['p_yes'], p=q['p_yes'], d_ref=b['logit_yes'] - b['logit_no'], d=q['logit_yes'] - q['logit_no']))
        (out / f'eval-{split}.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in rows))
(out / 'status.json').write_text(json.dumps(r, indent=1))
print('done')
