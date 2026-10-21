"""Debug: final vision merger alone (and variants) — torch fake-quant vs compiler reference on captured block-23 output."""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_vision_v1 import *


def rel(a, b):
    return float(np.linalg.norm(np.asarray(a, np.float64) - b) / np.linalg.norm(b))


class Only(Model):
    def __init__(self, variant):
        super().__init__(); self.v = variant
        self.m = Merger(False); self.m.load(vstate('model.visual.merger.')); self.set_children_parent()

    def forward(self, h):
        if self.v == 'norm':
            return self.m.norm(h)
        return self.m(h)

    def build(self, h):
        if self.v == 'norm':
            return self.m.norm(h)
        return self.m(h)


d = Path('/qwork/cap/vision-dev-v1/img-000'); x = np.load(d / 'blocks.npy')[23].astype(np.float32); ref = np.load(d / 'merged.npy')
print('block23 absmax', float(np.abs(x).max()), 'row-norm max', float(np.linalg.norm(x, axis=1).max()))
cal = [np.load(p / 'blocks.npy')[23].astype(np.float32) for p in sorted(Path('/qwork/cap/vision-calib-v1').iterdir()) if p.is_dir()][:8]
for variant in sys.argv[1:] or ['norm', 'full']:
    m = Only(variant).eval(); m.compile_mode(False)
    with torch.inference_mode():
        for c in cal:
            m(torch.from_numpy(c))
        t = m(torch.from_numpy(x)).numpy()
    m.compile_mode(True)
    bc = m.export_module([leap.TensorType([N, D], leap.float32)], name=f'dbg_{variant}', save_path=f'/tmp/dbg_{variant}.bc', high_precision_qpp=True)
    f = m.convert_mlir(bc, save_path=f'/tmp/dbg_{variant}_c.bc', enable_vpu=True, march='nash-m').functions[0]
    o = np.asarray(f(x)[0])
    if variant == 'norm':
        hf = torch.nn.functional.layer_norm(torch.from_numpy(x), [D], m.m.norm.weight.data, m.m.norm.bias.data, 1e-6).numpy()
        print(variant, 'torch_vs_hf', rel(t, hf), 'compiler_vs_hf', rel(o, hf), 'i_scale', m.m.norm.i_scale)
    else:
        print(variant, 'torch_vs_ref', rel(t, ref), 'compiler_vs_ref', rel(o, ref))
