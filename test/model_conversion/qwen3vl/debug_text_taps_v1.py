"""Debug: one Qwen3 text layer, s1 (last token) and s256 calls with intermediate taps — compiler vs torch fake-quant.
usage: debug_text_taps_v1.py LAYER   (capture dir must contain in-LAYER: uses /qwork/cap/text-*-v2)"""
import sys
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_text_v1 import *

li = int(sys.argv[1]); CAP = 1024
TAPS = ['ln1', 'attn', 'h1', 'ln2', 'gate', 'act', 'up', 'mul', 'down', 'out']


class Tap(Model):
    def __init__(self):
        super().__init__(); self.l = make_layer(text_config(), li, layer_state(li)); self.set_children_parent()

    def _run(self, x, cos, sin, mask, ck, cv, building):
        L = self.l; mlp = L.mlp
        if building:
            q = x.type.shape[0]
            h = leap.reshape(x, [1, q, HID]); c = leap.reshape(cos, [1, 1, q, HD]); s = leap.reshape(sin, [1, 1, q, HD])
            m = leap.reshape(mask, [1, 1, q, CAP]); ck = leap.reshape(ck, [1, NKV, CAP, HD]); cv = leap.reshape(cv, [1, NKV, CAP, HD])
            f16 = lambda t: leap.cast_type(t, output_type=leap.float16); f32 = lambda t: leap.cast_type(t, output_type=leap.float32)
        else:
            h, c, s, m, ck, cv = x[None], cos[None, None], sin[None, None], mask[None, None], ck[None], cv[None]
            f16 = f32 = lambda t: t
        ln1 = L.input_layernorm(h)
        at, _, _ = L.self_attn(ln1, attention_mask=m, position_embeddings=(c, s), cache_k=ck, cache_v=cv)
        h1 = f32(L.add1(f16(h), f16(at))); ln2 = L.post_attention_layernorm(h1)
        g = mlp.gate_proj(ln2); a = mlp.act_fn(g); u = mlp.up_proj(ln2); mu = mlp.mul(a, u); dn = mlp.down_proj(mu)
        out = f32(L.add2(f16(h1), f16(dn)))
        return ln1, at, h1, ln2, g, a, u, mu, dn, out

    def forward(self, *a):
        return self._run(*a, False)

    def build(self, *a):
        return self._run(*a, True)


def rel(x, y):
    return float(np.linalg.norm(np.asarray(x, np.float64) - y) / max(np.linalg.norm(y), 1e-12))


class G:      # minimal stand-in for chunk_inputs
    cap = CAP; ds = []


src = 'in-%02d.npy' % li
cal = [p for p in sorted(Path(os.environ.get('QCAL', '/qwork/cap/text-calib-v2')).iterdir()) if p.is_dir()][:12]
test = sorted(p for p in Path(os.environ.get('QTEST', '/qwork/cap/text-dev-v2')).iterdir() if p.is_dir())[0]
m = Tap().eval(); m.compile_mode(False)


def calls(d):
    hid = np.load(d / src); cs = np.load(d / 'cos.npy'); sn = np.load(d / 'sin.npy'); L = hid.shape[0]
    past = [(np.zeros((NKV, 0, HD), np.float32),) * 2]; out = []
    plan = [(0, 256, 256), (256, L - 1 - 256, 256), (L - 1, 1, 1)]
    for start, q, P in plan:
        v = chunk_inputs(G, hid, cs, sn, {}, past, start, q, P)
        with torch.inference_mode():
            o = m.l(torch.from_numpy(v[0])[None], attention_mask=torch.from_numpy(v[3])[None, None],
                    position_embeddings=(torch.from_numpy(v[1])[None, None], torch.from_numpy(v[2])[None, None]),
                    cache_k=torch.from_numpy(v[4])[None], cache_v=torch.from_numpy(v[5])[None])
        k, vv = o[1][0].numpy(), o[2][0].numpy()
        past = [(np.concatenate([past[0][0], k[:, :q]], 1), np.concatenate([past[0][1], vv[:, :q]], 1))]
        out.append((start, q, P, v))
    return out


S1CAL = os.environ.get('QS1CAL') == '1'
with torch.inference_mode():
    for d in cal:
        for start, q, P, v in calls(d):
            if S1CAL and P != 1:
                continue      # s1-only ranges (decision row); the s256 profile would keep its own wide ranges
            m(*[torch.from_numpy(x) for x in v])
    fx = calls(test); sel = [fx[0], fx[2]]
    tor = [[y[0].numpy() if y.dim() == 3 else y.numpy() for y in m(*[torch.from_numpy(x) for x in v])] for _, _, _, v in sel]
m.compile_mode(True)
for (start, q, P, v), t in zip(sel, tor):
    if S1CAL and P != 1:
        continue
    types = [leap.TensorType(list(x.shape), leap.float32) for x in v]
    bc = m.export_module(types, name=f'dbg_txt_{li}_s{P}', save_path=f'/tmp/dbg_txt_{li}_{P}.bc', high_precision_qpp=True)
    f = m.convert_mlir(bc, save_path=f'/tmp/dbg_txt_{li}_{P}_c.bc', enable_vpu=True, march='nash-m').functions[0]
    o = [np.asarray(y) for y in f(*v)]
    for name, a, b in zip(TAPS, o, t):
        a = a.reshape(b.shape)[:q]; b = b[:q]
        print(f's{P}', name, 'compiler_vs_torch', round(rel(a, b), 5), 'absmax c/t', round(float(np.abs(a).max()), 2), round(float(np.abs(b).max()), 2), flush=True)
