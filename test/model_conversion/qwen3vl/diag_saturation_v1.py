"""Diagnose activation saturation: re-run each text group's calibration exactly as build_text_group_v1 (same 32 calib
sequences, same deployment chunking, GPTQ codes), snapshot every quantizer range, then run the probe items and report
quantizers whose observed |x| exceeds the calibrated absmax (=> int16 saturation on the BPU).
usage: diag_saturation_v1.py PROBE_CAPTURE_DIR [groups e.g. 0,9,18,27]"""
import sys, json
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_bpu_text_v1 import *
from leap_llm.nn.modules import ConstFakeQuant

probe = Path(sys.argv[1]); groups = [int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '0,9,18,27').split(',')]
CAL = Path('/qwork/cap/text-calib-v2'); GPTQ = '/qwork/sim/gptq-v1/codes'; P = 256; dev = 'cuda'


def calls(seq):
    out, s = [], 0
    while seq - 1 - s > 0:
        q = min(P, seq - 1 - s); out.append((s, q, P)); s += q
    out.append((seq - 1, 1, 1)); return out


def run_seq(m, d, first, count):
    hidden, cos, sin, ds_full = load_capture(d, first, count)
    past = [(np.zeros((NKV, 0, HD), np.float32),) * 2 for _ in range(count)]
    for start, q, Pq in calls(hidden.shape[0]):
        o = [x.float().cpu().numpy() for x in m(*[torch.from_numpy(v).to(dev) for v in chunk_inputs(m, hidden, cos, sin, ds_full, past, start, q, Pq)])]
        past = [(np.concatenate([past[i][0], o[1 + 2 * i][:, :q]], 1), np.concatenate([past[i][1], o[2 + 2 * i][:, :q]], 1)) for i in range(count)]


def ranges(m):
    return {n: float(x.absmax) for n, x in m.named_modules() if type(x) is ConstFakeQuant and x.quantized}


report = {}
for first in groups:
    m = Group(first, 9, 1024, GPTQ).eval(); m.compile_mode(False); m = m.to(dev)
    with torch.inference_mode():
        for d in sorted(x for x in CAL.iterdir() if x.is_dir()):
            run_seq(m, d, first, 9)
        base = ranges(m); rep = {}
        for d in sorted(x for x in probe.iterdir() if x.is_dir()):
            for x in m.modules():          # fresh observation for this item only
                if type(x) is ConstFakeQuant:
                    x.absmax = torch.tensor(0.0)
            run_seq(m, d, first, 9)
            obs = ranges(m)
            over = sorted(((obs[n] / base[n], n, base[n], obs[n]) for n in base if base[n] > 0 and obs[n] > base[n] * 1.001), reverse=True)
            rep[d.name] = [dict(name=n, ratio=round(r, 3), calibrated=round(b, 4), observed=round(o, 4)) for r, n, b, o in over[:12]]
            for n in base:                 # restore calibrated ranges before the next item
                pass
            for n, x in m.named_modules():
                if type(x) is ConstFakeQuant:
                    x.absmax = torch.tensor(base.get(n, 0.0))
    report[first] = rep; print('group', first, json.dumps(rep, indent=1), flush=True)
    del m; torch.cuda.empty_cache()
(probe / 'saturation-report-v1.json').write_text(json.dumps(report, indent=1))
