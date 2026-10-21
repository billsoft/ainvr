"""Build one Qwen3-VL text group (official W8/A16 + q/k norm), profiles s1 + s<P>, shared HBM, O0 (or --opt).
Calibrates ranges on captured BF16 sequences (chunked like deployment), checks torch fake-quant and compiler
reference against BF16 layer outputs, compiles HBO, links, rejects any non-BPU node.
usage: setsid -w python3 build_text_group_v1.py --first F --count N --calib DIR --test DIR --out DIR [--gptq DIR] [--prefill 256]"""
import sys, time, json, hashlib, argparse, traceback, subprocess, gc
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_text_v1 import *


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def metric(a, b):
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64); assert a.shape == b.shape, (a.shape, b.shape)
    return dict(rel_l2=float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-12)), max_abs=float(np.abs(a - b).max()),
                cos=float((a * b).sum() / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12)))


p = argparse.ArgumentParser()
p.add_argument('--first', type=int, required=True); p.add_argument('--count', type=int, required=True)
p.add_argument('--calib', type=Path, required=True); p.add_argument('--test', type=Path, required=True)
p.add_argument('--out', type=Path, required=True); p.add_argument('--gptq', type=Path)
p.add_argument('--prefill', type=int, default=256); p.add_argument('--cap', type=int, default=1024)
p.add_argument('--opt', type=int, default=0); p.add_argument('--jobs', type=int, default=4)
p.add_argument('--no-compile', action='store_true'); p.add_argument('--device', default='cuda')
a = p.parse_args()
assert 0 <= a.first and a.first + a.count <= 36 and not a.out.exists() and os.getpgrp() == os.getpid()
a.out.mkdir(parents=True); torch.set_num_threads(4); torch.backends.cuda.matmul.allow_tf32 = False
last = a.first + a.count - 1; P = a.prefill
r = dict(status='start', started=time.time(), source_sha256={n: sha(f'/qwork/scripts/{n}') for n in ['qwen3vl_bpu_text_v1.py', 'build_text_group_v1.py']},
         first=a.first, count=a.count, cap=a.cap, prefill=P, gptq=str(a.gptq) if a.gptq else None, weight_bits=8, attention_activation_bits=16,
         deepstack_layers=[i for i in range(a.first, a.first + a.count) if i < 3], profiles=[], neural_cpu_fallback=False)


def persist():
    t = a.out / 'status.json.tmp'; t.write_text(json.dumps(r, indent=1) + '\n'); t.replace(a.out / 'status.json')


def calls(seq):
    """Deployment chunking of a full prompt: prefill chunks of P, last token as s1 (yes/no read-out)."""
    out, s = [], 0
    while seq - 1 - s > 0:
        q = min(P, seq - 1 - s); out.append((s, q, P)); s += q
    out.append((seq - 1, 1, 1))
    return out


def run_seq(m, d, dev):
    hidden, cos, sin, ds_full = load_capture(d, a.first, a.count)
    past = [(np.zeros((NKV, 0, HD), np.float32),) * 2 for _ in range(a.count)]
    outs, fixtures = [], []
    for start, q, Pq in calls(hidden.shape[0]):
        vals = chunk_inputs(m, hidden, cos, sin, ds_full, past, start, q, Pq)
        o = m(*[torch.from_numpy(v).to(dev) for v in vals])
        o = [x.float().cpu().numpy() for x in o]
        outs.append(o[0][:q]); fixtures.append((start, q, Pq, vals))
        past = [(np.concatenate([past[i][0], o[1 + 2 * i][:, :q]], 1), np.concatenate([past[i][1], o[2 + 2 * i][:, :q]], 1)) for i in range(a.count)]
    return np.concatenate(outs), past, fixtures


def bf16_ref(d, seq):
    out = np.load(Path(d) / f'out-{last:02d}.npy')
    if last < 3:
        out = out + load_capture(d, a.first, a.count)[3][last]
    return out


persist()
try:
    m = Group(a.first, a.count, a.cap, a.gptq).eval(); m.compile_mode(False); dev = a.device; m = m.to(dev)
    r['status'] = 'calibrating'; persist(); calib = sorted(x for x in a.calib.iterdir() if x.is_dir())
    with torch.inference_mode():
        for d in calib:
            run_seq(m, d, dev)
        r['calibration_items'] = [x.name for x in calib]
        tests = sorted(x for x in a.test.iterdir() if x.is_dir())[:int(os.environ.get('QREFN', '2'))]; r['torch_fakequant_vs_bf16'] = []; fixtures = {}   # compiler-reference fixtures (CPU sim is memory-heavy)
        for d in tests:
            out, past, fx = run_seq(m, d, dev)
            ref = bf16_ref(d, out.shape[0])
            kv = [metric(past[i][0], np.load(d / f'k-{a.first + i:02d}.npy')) for i in range(a.count) if (d / f'k-{a.first + i:02d}.npy').exists()]
            r['torch_fakequant_vs_bf16'].append(dict(item=d.name, hidden=metric(out, ref), last_row=metric(out[-1:], ref[-1:]),
                                                     k_worst_rel=max([x['rel_l2'] for x in kv], default=None)))
            fixtures[d.name] = (fx, ref)
    persist(); print(json.dumps(r['torch_fakequant_vs_bf16'], indent=1), flush=True)
    m = m.cpu(); torch.cuda.empty_cache() if torch.cuda.is_available() else None; m.compile_mode(True); hbos = []
    for prof in sorted({1, P}):
        d = a.out / f's{prof}'; d.mkdir(); e = dict(profile=prof); r['profiles'].append(e)
        r['status'] = f'export_s{prof}'; persist()
        bc = m.export_module(m.input_types(prof), name=f'qwen3vl_text_{a.first}_{last}_s{prof}', save_path=str(d / 'export.bc'), high_precision_qpp=True)
        r['status'] = f'convert_s{prof}'; persist()
        low = m.convert_mlir(bc, save_path=str(d / 'converted.bc'), enable_vpu=True, march='nash-m'); f = low.functions[0]
        e['converted_bc_sha256'] = sha(d / 'converted.bc')
        e['compiler_vs_bf16'] = []
        for item, (fx, ref) in fixtures.items():
            for ci, (start, q, Pq, vals) in enumerate(fx):
                if Pq != prof:
                    continue
                o = [np.asarray(x).copy() for x in f(*vals)]
                if ci < 2 or Pq == 1:
                    cd = d / f'{item}-call{ci}'; cd.mkdir()
                    for i, v in enumerate(vals):
                        np.save(cd / f'input-{i:02d}.npy', v)
                    for i, v in enumerate(o):
                        np.save(cd / f'compiler-{i:02d}.npy', v)
                e['compiler_vs_bf16'].append(dict(item=item, call=ci, start=start, rows=q, hidden=metric(o[0][:q], ref[start:start + q])))
        persist(); print(json.dumps(e['compiler_vs_bf16'], indent=1), flush=True)
        ports = dict(inputs=[dict(name=x.name, shape=list(x.type.shape)) for x in f.inputs], outputs=[dict(name=x.name, shape=list(x.type.shape)) for x in f.outputs])
        (d / 'ports.json').write_text(json.dumps(ports, indent=1))
        if a.no_compile:
            continue
        r['status'] = f'compile_s{prof}'; persist(); t = time.monotonic()
        hbos.append(m.compile_hbo(low, save_path=str(d / 'model.hbo'), march='nash-m', opt=a.opt, jobs=a.jobs))
        e['compile_seconds'] = time.monotonic() - t; e['hbo_sha256'] = sha(d / 'model.hbo'); del bc, low, f; gc.collect(); persist()
    if not a.no_compile:
        r['status'] = 'linking'; persist(); m.link_models(hbos, str(a.out / 'model.hbm'))
        tool = SDK / 'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas'
        dis = json.loads(subprocess.check_output([str(tool), '--json', str(a.out / 'model.hbm')], text=True))
        (a.out / 'disas.json').write_text(json.dumps(dis, indent=1))
        devices = [n['device'] for g in dis['graphs'] for n in g['nodes']]
        assert devices and all(x == 'DEVICE_CATEGORY_BPU' for x in devices), 'neural CPU fallback'
        r.update(hbm_sha256=sha(a.out / 'model.hbm'), hbm_bytes=(a.out / 'model.hbm').stat().st_size,
                 compiler_memory=[g.get('modelMemoryRequirement') for g in dis['graphs']])
    r['status'] = 'done'
except BaseException:
    r.update(status='failed', error=traceback.format_exc()); raise
finally:
    r['finished'] = time.time(); persist()
print(json.dumps({k: r.get(k) for k in ['status', 'hbm_bytes', 'error']}, indent=1))
