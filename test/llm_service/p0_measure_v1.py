"""P0 measurements for the AINVR LLM service design (docs/S100P-LLM-SERVICE-DESIGN.md §12 P0).
Run as root inside board_guard_eval_v2.sh (production AI + LocateAnything paused; recorder/ingest untouched).
  A. pure BPU latency per Qwen3-VL O2 package/profile (hrt_model_exec perf) vs Python hbm_runtime wall time
  B. hbUCP priority behaviour on the single BPU core: latency of a short high-priority task while a long
     low-priority task loops (does priority reorder / preempt?)
  C. LocateAnything ION footprint after its lazy preload (one bounded generate request, gray image)
usage: python3 p0_measure_v1.py OUT_DIR
"""
import sys, os, json, time, subprocess, re, socket, struct
from pathlib import Path
import numpy as np

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path('/mnt/ainvr-ssd/qwen3vl')
PKGS = ['vis-0-6-o2-v3', 'vis-6-12-o2-v3', 'vis-12-18-o2-v3', 'vis-18-24-o2-v3',
        'txt-0-8-o2-v3', 'txt-9-17-o2-v3', 'txt-18-26-o2-v3', 'txt-27-35-o2-v3', 'head-o2-v3']
PY = '/home/sunrise/ainvr/ai-service/runtime/.venv-locateanything/bin/python'
LA_SOCK = '/home/sunrise/ainvr/data/ai/locateanything-official-bpu.sock'
LA_SHA = 'a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381'
R = dict(started=time.time())


def save():
    (OUT / 'p0-result.json').write_text(json.dumps(R, indent=1, ensure_ascii=False))


def ion():
    raise RuntimeError('已禁用：读取 /sys/kernel/debug/ion 会使本板内核崩溃（2026-10-22 事故），不要再运行本脚本')


def model_names(pkg):
    code = ('import hbm_runtime,json,sys;r=hbm_runtime.HB_HBMRuntime(sys.argv[1]);'
            'print(json.dumps({n:{k:list(v) for k,v in dict(r.input_shapes[n]).items()} for n in r.model_names}))')
    out = subprocess.run([PY, '-c', code, str(ROOT / pkg / 'model.hbm')], capture_output=True, text=True, timeout=180).stdout
    return json.loads(out.strip().splitlines()[-1])


# ---------- A: pure BPU latency ----------
R['A'] = {}
R['ion_idle'] = ion(); save()
for pkg in PKGS:
    names = model_names(pkg); R['A'][pkg] = {}
    for n, shapes in names.items():
        prof = None
        if pkg == 'txt-0-8-o2-v3' and max(s[0] for s in shapes.values() if len(s) == 2) == 256:
            prof = OUT / 'profile-txt-0-8-s256'; prof.mkdir(exist_ok=True)
        cmd = ['hrt_model_exec', 'perf', '--model_file', str(ROOT / pkg / 'model.hbm'), '--model_name', n,
               '--frame_count', '20', '--core_id', '1'] + (['--profile_path', str(prof)] if prof else [])
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        txt = p.stdout + p.stderr
        (OUT / f'hrt-{pkg}-{n}.log').write_text(txt)
        m = {k: re.findall(rf'{k}\s+is:\s*([0-9.]+)', txt) for k in ('Average\\s+latency', 'Frame\\s+rate')}
        m = {'Average latency': m['Average\\s+latency'], 'Frame rate': m['Frame\\s+rate']}
        R['A'][pkg][n] = dict(rc=p.returncode, shapes=shapes, avg_latency_ms=float(m['Average latency'][0]) if m['Average latency'] else None,
                              fps=float(m['Frame rate'][0]) if m['Frame rate'] else None)
        save(); print(pkg, n, R['A'][pkg][n]['avg_latency_ms'], flush=True)

# Python hbm_runtime wall time for the same programs, zero inputs (includes numpy in/out copies)
code = r'''
import hbm_runtime,json,sys,time,numpy as np
r=hbm_runtime.HB_HBMRuntime(sys.argv[1]);out={}
for n in r.model_names:
    r.set_scheduling_params(bpu_cores={n:[0]})
    xs={k:np.zeros(v,np.float32) for k,v in dict(r.input_shapes[n]).items()}
    r.run({n:xs});ts=[]
    for _ in range(10):
        t=time.perf_counter();r.run({n:xs});ts.append((time.perf_counter()-t)*1000)
    out[n]=dict(median_ms=float(np.median(ts)),min_ms=float(min(ts)))
print(json.dumps(out))
'''
R['A_python'] = {}
for pkg in PKGS:
    p = subprocess.run([PY, '-c', code, str(ROOT / pkg / 'model.hbm')], capture_output=True, text=True, timeout=600)
    try:
        R['A_python'][pkg] = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        R['A_python'][pkg] = dict(error=p.stderr[-800:])
    save(); print('py', pkg, R['A_python'][pkg], flush=True)

# ---------- B: priority on the single core ----------
WORKER = r'''
import hbm_runtime,json,sys,time,numpy as np
path,prio,mode,seconds=sys.argv[1],int(sys.argv[2]),sys.argv[3],float(sys.argv[4])
r=hbm_runtime.HB_HBMRuntime(path)
n=[m for m in r.model_names if mode!='long' or max(s[0] for s in dict(r.input_shapes[m]).values() if len(s)==2)==256][0]
r.set_scheduling_params(priority={n:prio},bpu_cores={n:[0]})
xs={k:np.zeros(v,np.float32) for k,v in dict(r.input_shapes[n]).items()}
r.run({n:xs})
print('READY',flush=True)
end=time.time()+seconds;ts=[]
while time.time()<end:
    t=time.perf_counter();r.run({n:xs});ts.append((time.perf_counter()-t)*1000)
    if mode=='short':time.sleep(0.25)
print(json.dumps(dict(model=n,prio=prio,count=len(ts),median=float(np.median(ts)),p95=float(np.percentile(ts,95)),max=float(max(ts)))))
'''
wf = OUT / 'prio_worker.py'; wf.write_text(WORKER)
SHORT, LONG = str(ROOT / 'vis-0-6-o2-v3' / 'model.hbm'), str(ROOT / 'txt-0-8-o2-v3' / 'model.hbm')


def run_short(prio, seconds=12):
    p = subprocess.run([PY, str(wf), SHORT, str(prio), 'short', str(seconds)], capture_output=True, text=True, timeout=300)
    return json.loads(p.stdout.strip().splitlines()[-1])


R['B'] = dict(short_alone=run_short(255)); save()
for sp, lp in ((255, 0), (0, 0), (0, 255)):
    lg = subprocess.Popen([PY, str(wf), LONG, str(lp), 'long', '20'], stdout=subprocess.PIPE, text=True)
    while 'READY' not in lg.stdout.readline():
        pass
    s = run_short(sp)
    lo = json.loads(lg.communicate(timeout=300)[0].strip().splitlines()[-1])
    R['B'][f'short_p{sp}_vs_long_p{lp}'] = dict(short=s, long=lo); save(); print('B', sp, lp, s, flush=True)

# ---------- C: LocateAnything ION after lazy preload ----------
def la_call(req, payload=b''):
    s = socket.socket(socket.AF_UNIX); s.settimeout(120); s.connect(LA_SOCK)
    h = json.dumps(req).encode(); s.sendall(struct.pack('!I', len(h)) + h + payload)
    buf = b''
    while True:
        c = s.recv(65536)
        if not c:
            break
        buf += c
    s.close(); return buf


R['C'] = dict(ion_before_start=ion())
subprocess.run(['systemctl', 'start', 'ainvr-locateanything-official-bpu'], timeout=700)
R['C']['ion_after_start'] = ion(); save()
pix = np.full((3, 224, 448), 0.5, '<f4').tobytes()
peak = [0]; t0 = time.time()
import threading
stop = threading.Event()


def sampler():
    while not stop.is_set():
        peak[0] = max(peak[0], ion()['used']); time.sleep(0.2)


th = threading.Thread(target=sampler); th.start()
try:
    resp = la_call(dict(schema_version=1, operation='generate', contract_sha256=LA_SHA, description='person', tokens=8,
                        input_bytes=len(pix), input_shape=[3, 224, 448], pixel_format='rgb-chw-f32le'), pix)
    R['C']['response_head'] = resp[:600].decode('utf-8', 'replace')
except Exception as e:
    R['C']['error'] = repr(e)
stop.set(); th.join()
R['C'].update(request_seconds=time.time() - t0, ion_peak_used=peak[0], ion_after_request=ion())
subprocess.run(['systemctl', 'stop', 'ainvr-locateanything-official-bpu'], timeout=120)
time.sleep(2); R['C']['ion_after_stop'] = ion()
R['finished'] = time.time(); save(); print(json.dumps(R['C']), flush=True)
