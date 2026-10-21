"""Debug: one vision block with intermediate taps (norm1, attn, h1, norm2, fc1, gelu, fc2, out) — compiler vs torch fake-quant.
usage: debug_block_taps_v1.py BLOCK"""
import sys
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_vision_v1 import *

bi = int(sys.argv[1])
TAPS = ['norm1', 'attn', 'h1', 'norm2', 'fc1', 'gelu', 'fc2', 'out']


class Tap(Model):
    def __init__(self):
        super().__init__(); self.b = Block(); self.b.load(vstate(f'model.visual.blocks.{bi}.'))
        _, c, s = constants(); self.register_buffer('cos', c); self.register_buffer('sin', s); self.set_children_parent()

    def _run(self, h, building):
        b = self.b; n1 = b.norm1(h)
        at = b.attn(n1, window_attention=False, rotary_pos_emb_cos=self.cos, rotary_pos_emb_sin=self.sin)
        h1 = b._res(h, at, b.add1, building); n2 = b.norm2(h1); f1 = b.fc1(n2); ge = b.act(f1); f2 = b.fc2(ge)
        out = b._res(h1, f2, b.add2, building)
        return n1, at, h1, n2, f1, ge, f2, out

    def forward(self, h):
        return self._run(h, False)

    def build(self, h):
        return self._run(h, True)


def rel(x, y):
    return float(np.linalg.norm(np.asarray(x, np.float64) - y) / max(np.linalg.norm(y), 1e-12))


m = Tap().eval(); m.compile_mode(False)
cal = sorted(p for p in Path('/qwork/cap/vision-calib-v1').iterdir() if p.is_dir())[:12]
with torch.inference_mode():
    for p in cal:
        m(torch.from_numpy(np.load(p / 'blocks.npy')[bi - 1].astype(np.float32)))
x = np.load('/qwork/cap/vision-dev-v1/img-000/blocks.npy')[bi - 1].astype(np.float32)
with torch.inference_mode():
    t = [y.numpy() for y in m(torch.from_numpy(x))]
m.compile_mode(True)
bc = m.export_module([leap.TensorType([N, D], leap.float32)], name=f'dbg_tap_{bi}', save_path=f'/tmp/dbg_tap_{bi}.bc', high_precision_qpp=True)
f = m.convert_mlir(bc, save_path=f'/tmp/dbg_tap_{bi}_c.bc', enable_vpu=True, march='nash-m').functions[0]
o = [np.asarray(y) for y in f(x)]
for name, a, b in zip(TAPS, o, t):
    print(name, 'compiler_vs_torch', round(rel(a, b), 5), 'absmax c/t', round(float(np.abs(a).max()), 2), round(float(np.abs(b).max()), 2))
