"""Debug v2: attention internals of one Qwen3 text layer, s1 (last token) and s256 calls with intermediate taps — compiler vs torch fake-quant.
usage: debug_text_taps_v1.py LAYER   (capture dir must contain in-LAYER: uses /qwork/cap/text-*-v2)"""
import sys
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_text_v1 import *

li = int(sys.argv[1]); CAP = 1024
TAPS = ['ln1', 'q_proj', 'q_norm', 'q_rope', 'k_rope', 'scores', 'probs', 'attn']


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
        A = L.self_attn; ln1 = L.input_layernorm(h)
        R = (lambda t, sh: leap.reshape(t, sh)) if building else (lambda t, sh: t.reshape(sh))
        T = (lambda t, p: leap.transpose(t, p)) if building else (lambda t, p: t.permute(*p))
        q = A.q_proj(ln1); k = A.k_proj(ln1); v = A.v_proj(ln1)
        qn = T(A.q_norm(R(q, [1, -1, NH, HD])), [0, 2, 1, 3]); kn = T(A.k_norm(R(k, [1, -1, NKV, HD])), [0, 2, 1, 3])
        qr, kr = A.apply_rotary_pos_emb(qn, kn, c, s)
        if building:
            qq = qr.type.shape[2]
            ckk = leap.concat([leap.slice(ck, [0, 0, qq, 0], [1, NKV, CAP, HD], [1, 1, 1, 1]), kr], -2)
            kt = leap.transpose(ckk, [0, 1, 3, 2]); qg = leap.reshape(qr, [1, NKV, (NH // NKV) * qq, HD])
            sc = leap.reshape(A.qk(qg, kt), [1, -1, qq, CAP])
        else:
            qq = qr.shape[2]; ckk = torch.cat([ck[..., qq:, :], kr], -2)
            sc = A.qk(qr.reshape(1, NKV, (NH // NKV) * qq, HD), ckk.transpose(2, 3)).reshape(1, -1, qq, CAP)
        sc = A.mul_attn_weight(sc, 1.0 / math.sqrt(HD)); sc = A.add_mask(sc, m); pr = A.softmax(sc)
        at, _, _ = A(ln1, attention_mask=m, position_embeddings=(c, s), cache_k=ck, cache_v=cv)
        return ln1, q, qn, qr, kr, sc, pr, at

    def forward(self, *a):
        return self._run(*a, False)

    def build(self, *a):
        return self._run(*a, True)


def rel(x, y):
    return float(np.linalg.norm(np.asarray(x, np.float64) - y) / max(np.linalg.norm(y), 1e-12))


class G:      # minimal stand-in for chunk_inputs
    cap = CAP; ds = []


src = 'in-%02d.npy' % li
cal = [p for p in sorted(Path('/qwork/cap/text-calib-v2').iterdir()) if p.is_dir()][:12]
test = sorted(p for p in Path('/qwork/cap/text-dev-v2').iterdir() if p.is_dir())[0]
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


with torch.inference_mode():
    for d in cal:
        for start, q, P, v in calls(d):
            m(*[torch.from_numpy(x) for x in v])
    fx = calls(test); sel = [fx[0], fx[2]]
    tor = [[y[0].numpy() if y.dim() == 3 else y.numpy() for y in m(*[torch.from_numpy(x) for x in v])] for _, _, _, v in sel]
m.compile_mode(True)
for (start, q, P, v), t in zip(sel, tor):
    types = [leap.TensorType(list(x.shape), leap.float32) for x in v]
    bc = m.export_module(types, name=f'dbg_txt_{li}_s{P}', save_path=f'/tmp/dbg_txt_{li}_{P}.bc', high_precision_qpp=True)
    f = m.convert_mlir(bc, save_path=f'/tmp/dbg_txt_{li}_{P}_c.bc', enable_vpu=True, march='nash-m').functions[0]
    o = [np.asarray(y) for y in f(*v)]
    for name, a, b in zip(TAPS, o, t):
        a = a.reshape(b.shape)
        if a.ndim == 2:
            a, b = a[:q], b[:q]
        print(f's{P}', name, 'compiler_vs_torch', round(rel(a, b), 5), 'absmax c/t', round(float(np.abs(a).max()), 2), round(float(np.abs(b).max()), 2), flush=True)
