"""Decision head HBM: final RMSNorm + tied lm_head restricted to the decision vocabulary (yes/no, choice letters, score digits).
Input: last hidden row [1,2560] (output of layer 35). Output: logits [1,K] for DECISION_TOKENS (order saved in tokens.json).
usage: setsid -w python3 build_head_v1.py --calib DIR --test DIR --out DIR"""
import sys, time, json, hashlib, argparse, traceback, subprocess
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_text_v1 import *
sys.path.insert(0, '/opt/qsdk/locate-reference-deps')
from transformers import AutoTokenizer

WORDS = ['是', '否', 'A', 'B', 'C', 'D', 'E', 'F', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Yes', 'No', 'yes', 'no']


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


class Head(Model):
    def __init__(self, ids):
        super().__init__()
        cfg = text_config(); idx = json.loads((MODEL / 'model.safetensors.index.json').read_text())['weight_map']
        def get(k):
            with safe_open(str(MODEL / idx[k]), framework='pt', device='cpu') as f:
                return f.get_tensor(k).float()
        self.norm = Qwen2RMSNorm(HID, eps=cfg.rms_norm_eps, preserve_precision=True, fp16_tiny=False)
        self.norm.weight.data.copy_(get('model.language_model.norm.weight'))
        self.proj = FakeQuantLinear(HID, len(ids), bias=False, quant_bits=16)
        self.proj.weight.data.copy_(get('model.language_model.embed_tokens.weight')[ids])
        self.set_children_parent()

    def forward(self, h):
        return self.proj(self.norm(h))

    def build(self, h):
        return self.proj(self.norm(h))


p = argparse.ArgumentParser(); p.add_argument('--calib', type=Path, required=True); p.add_argument('--test', type=Path, required=True)
p.add_argument('--out', type=Path, required=True); p.add_argument('--opt', type=int, default=0)
a = p.parse_args(); assert not a.out.exists() and os.getpgrp() == os.getpid(); a.out.mkdir(parents=True)
tok = AutoTokenizer.from_pretrained(str(MODEL)); ids = []
for w in WORDS:
    e = tok.encode(w, add_special_tokens=False); assert len(e) == 1, (w, e); ids.append(e[0])
(a.out / 'tokens.json').write_text(json.dumps(dict(words=WORDS, ids=ids), ensure_ascii=False))
r = dict(status='start', tokens=dict(zip(WORDS, ids)), source_sha256=sha(__file__))
try:
    m = Head(ids).eval(); m.compile_mode(False)
    rows = lambda d: np.load(Path(d) / 'out-35.npy')[-1:].astype(np.float32)
    with torch.inference_mode():
        for d in sorted(x for x in a.calib.iterdir() if x.is_dir()):
            m(torch.from_numpy(np.load(d / 'out-35.npy').astype(np.float32)))   # every row: ranges for any position
    m.compile_mode(True)
    bc = m.export_module([leap.TensorType([1, HID], leap.float32)], name='qwen3vl_decision_head', save_path=str(a.out / 'export.bc'), high_precision_qpp=True)
    low = m.convert_mlir(bc, save_path=str(a.out / 'converted.bc'), enable_vpu=True, march='nash-m'); f = low.functions[0]
    r['compiler_vs_bf16'] = []; fx = a.out / 's1'; fx.mkdir()
    for k, d in enumerate(sorted(x for x in a.test.iterdir() if x.is_dir())):
        x = rows(d); o = np.asarray(f(x)[0]).copy(); ref = np.load(d / 'last_logits.npy')[ids]
        gap, gref = float(o[0, 0] - o[0, 1]), float(ref[0] - ref[1])
        r['compiler_vs_bf16'].append(dict(item=d.name, yes_no_gap=gap, yes_no_gap_bf16=gref, max_abs=float(np.abs(o[0] - ref).max())))
        cd = fx / d.name; cd.mkdir(); np.save(cd / 'input-00.npy', x); np.save(cd / 'compiler-00.npy', o)
    (fx / 'ports.json').write_text(json.dumps(dict(inputs=[dict(name=t.name, shape=list(t.type.shape)) for t in f.inputs],
                                                     outputs=[dict(name=t.name, shape=list(t.type.shape)) for t in f.outputs])))
    print(json.dumps(r['compiler_vs_bf16'], indent=1), flush=True)
    hbo = m.compile_hbo(low, save_path=str(a.out / 'model.hbo'), march='nash-m', opt=a.opt, jobs=2); m.link_models([hbo], str(a.out / 'model.hbm'))
    tool = SDK / 'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas'
    dis = json.loads(subprocess.check_output([str(tool), '--json', str(a.out / 'model.hbm')], text=True))
    assert all(n['device'] == 'DEVICE_CATEGORY_BPU' for g in dis['graphs'] for n in g['nodes'])
    r.update(status='done', hbm_sha256=sha(a.out / 'model.hbm'), hbm_bytes=(a.out / 'model.hbm').stat().st_size)
except BaseException:
    r.update(status='failed', error=traceback.format_exc()); raise
finally:
    t = a.out / 'status.json'; t.write_text(json.dumps(r, indent=1, ensure_ascii=False))
print(r['status'], r.get('hbm_bytes'))
