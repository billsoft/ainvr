"""Build one Qwen3-VL vision group [first,last) at O0: calibrate on captured patches (feeding BF16 block outputs as
group inputs), compare torch fake-quant and compiler reference vs BF16, compile, link, reject non-BPU nodes.
usage: setsid -w python3 build_vision_group_v1.py --first A --last B --calib DIR --test DIR --out DIR"""
import sys, time, json, hashlib, argparse, traceback, subprocess, gc
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_vision_v1 import *


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def metric(a, b):
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64); assert a.shape == b.shape, (a.shape, b.shape)
    return dict(rel_l2=float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-12)), cos=float((a * b).sum() / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-12)))


p = argparse.ArgumentParser()
p.add_argument('--first', type=int, required=True); p.add_argument('--last', type=int, required=True)
p.add_argument('--calib', type=Path, required=True); p.add_argument('--test', type=Path, required=True)
p.add_argument('--out', type=Path, required=True); p.add_argument('--rope-inputs', action='store_true'); p.add_argument('--device', default='cuda'); p.add_argument('--opt', type=int, default=0); p.add_argument('--jobs', type=int, default=4)
a = p.parse_args()
assert 0 <= a.first < a.last <= 24 and not a.out.exists() and os.getpgrp() == os.getpid()
a.out.mkdir(parents=True); torch.set_num_threads(4)
r = dict(status='start', started=time.time(), first=a.first, last=a.last,
         source_sha256={n: sha(f'/qwork/scripts/{n}') for n in ['qwen3vl_bpu_vision_v1.py', 'build_vision_group_v1.py']})


def persist():
    t = a.out / 'status.json.tmp'; t.write_text(json.dumps(r, indent=1) + '\n'); t.replace(a.out / 'status.json')


def io(d):
    d = Path(d); blocks = np.load(d / 'blocks.npy').astype(np.float32)
    x = np.load(d / 'patches.npy') if a.first == 0 else blocks[a.first - 1]
    refs = [np.load(d / 'merged.npy') if a.last == 24 else blocks[a.last - 1]]
    ds = np.load(d / 'deepstack.npy')
    refs += [ds[DEEPSTACK.index(i)] for i in DEEPSTACK if a.first <= i < a.last]
    return x.astype(np.float32), refs


persist()
try:
    m = VisionGroup(a.first, a.last, a.rope_inputs).eval(); extra = m.rope_arrays(); m.compile_mode(False); m = m.to(a.device)
    r['status'] = 'calibrating'; persist()
    with torch.inference_mode():
        for d in sorted(x for x in a.calib.iterdir() if x.is_dir()):
            m(torch.from_numpy(io(d)[0]).to(a.device), *[torch.from_numpy(e).to(a.device) for e in extra])
        tests = sorted(x for x in a.test.iterdir() if x.is_dir())[:2]; fixtures = {}; r['torch_fakequant_vs_bf16'] = []   # 2 compiler-reference fixtures (CPU sim is slow)
        for d in tests:
            x, refs = io(d); o = [t.float().cpu().numpy() for t in m(torch.from_numpy(x).to(a.device), *[torch.from_numpy(e).to(a.device) for e in extra])]
            r['torch_fakequant_vs_bf16'].append(dict(item=d.name, outputs=[metric(u, v) for u, v in zip(o, refs)])); fixtures[d.name] = (x, refs)
    persist(); print(json.dumps(r['torch_fakequant_vs_bf16'], indent=1), flush=True)
    m = m.cpu(); torch.cuda.empty_cache(); m.compile_mode(True)
    r['status'] = 'export'; persist()
    bc = m.export_module(m.input_types(), name=f'qwen3vl_vision_{a.first}_{a.last - 1}', save_path=str(a.out / 'export.bc'), high_precision_qpp=True)
    r['status'] = 'convert'; persist()
    low = m.convert_mlir(bc, save_path=str(a.out / 'converted.bc'), enable_vpu=True, march='nash-m'); f = low.functions[0]
    r['converted_bc_sha256'] = sha(a.out / 'converted.bc'); r['compiler_vs_bf16'] = []
    fx = a.out / 's1'; fx.mkdir()
    for k, (name, (x, refs)) in enumerate(fixtures.items()):
        o = [np.asarray(t).copy() for t in f(x, *extra)]
        r['compiler_vs_bf16'].append(dict(item=name, outputs=[metric(u, v) for u, v in zip(o, refs)]))
        if k < 2:
            cd = fx / name; cd.mkdir()
            for i, v in enumerate([x, *extra]):
                np.save(cd / f'input-{i:02d}.npy', v)
            for i, v in enumerate(o):
                np.save(cd / f'compiler-{i:02d}.npy', v)
    ports = dict(inputs=[dict(name=t.name, shape=list(t.type.shape)) for t in f.inputs], outputs=[dict(name=t.name, shape=list(t.type.shape)) for t in f.outputs])
    (fx / 'ports.json').write_text(json.dumps(ports, indent=1)); persist(); print(json.dumps(r['compiler_vs_bf16'], indent=1), flush=True)
    r['status'] = 'compile'; persist(); t = time.monotonic()
    hbo = m.compile_hbo(low, save_path=str(a.out / 'model.hbo'), march='nash-m', opt=a.opt, jobs=a.jobs); r['compile_seconds'] = time.monotonic() - t
    m.link_models([hbo], str(a.out / 'model.hbm'))
    tool = SDK / 'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas'
    dis = json.loads(subprocess.check_output([str(tool), '--json', str(a.out / 'model.hbm')], text=True)); (a.out / 'disas.json').write_text(json.dumps(dis, indent=1))
    devices = [n['device'] for g in dis['graphs'] for n in g['nodes']]
    assert devices and all(x == 'DEVICE_CATEGORY_BPU' for x in devices), 'neural CPU fallback'
    r.update(status='done', hbm_sha256=sha(a.out / 'model.hbm'), hbm_bytes=(a.out / 'model.hbm').stat().st_size,
             compiler_memory=[g.get('modelMemoryRequirement') for g in dis['graphs']])
except BaseException:
    r.update(status='failed', error=traceback.format_exc()); raise
finally:
    r['finished'] = time.time(); persist()
print(json.dumps({k: r.get(k) for k in ['status', 'hbm_bytes', 'error']}, indent=1))
