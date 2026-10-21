"""Debug: vision blocks [a,b) without the final merger — torch fake-quant vs compiler reference vs BF16 block output.
usage: debug_block_v1.py A B"""
import sys
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_vision_v1 import *

a, b = int(sys.argv[1]), int(sys.argv[2])


def rel(x, y):
    return float(np.linalg.norm(np.asarray(x, np.float64) - y) / np.linalg.norm(y))


g = VisionGroup(a, b, rope_inputs=True).eval(); g.final = None; g.compile_mode(False); extra = g.rope_arrays()
cal = sorted(p for p in Path('/qwork/cap/vision-calib-v1').iterdir() if p.is_dir())[:12]
with torch.inference_mode():
    for p in cal:
        g(torch.from_numpy(np.load(p / 'blocks.npy')[a - 1].astype(np.float32)), *[torch.from_numpy(e) for e in extra])
d = Path('/qwork/cap/vision-dev-v1/img-000'); blocks = np.load(d / 'blocks.npy').astype(np.float32)
x, ref = blocks[a - 1], blocks[b - 1]
with torch.inference_mode():
    t = g(torch.from_numpy(x), *[torch.from_numpy(e) for e in extra])[0].numpy()
g.compile_mode(True)
bc = g.export_module(g.input_types(), name=f'dbg_blk_{a}_{b}', save_path=f'/tmp/dbg_blk_{a}_{b}.bc', high_precision_qpp=True)
f = g.convert_mlir(bc, save_path=f'/tmp/dbg_blk_{a}_{b}_c.bc', enable_vpu=True, march='nash-m').functions[0]
o = np.asarray(f(x, *extra)[0])
print(f'blocks[{a},{b})', 'torch_vs_bf16', rel(t, ref), 'compiler_vs_bf16', rel(o, ref), 'compiler absmax', float(np.abs(o).max()),
      'worst channels', np.argsort(-np.abs(o - ref).max(0))[:5].tolist())
for n, mod in g.named_modules():
    if hasattr(mod, 'absmax') and getattr(mod, 'absmax', None) is not None and ('fc2' in n or 'proj' in n) and 'blocks.%d' % (b - a - 1) in n:
        print(n, getattr(mod, 'bits', None), float(mod.absmax))
