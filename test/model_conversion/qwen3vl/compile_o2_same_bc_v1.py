"""Same converted-BC O2 compile of a built package (text group: s1+s256; vision/head: single profile). No export/calibration
change versus the O0 package: load each converted.bc, compile(opt=2, balance=100, max_l2m_size=0), link, require all-BPU,
copy the O0 package's fixtures (compiler-reference outputs stay valid because O2 must be bitwise equal).
usage: setsid -w python3 compile_o2_same_bc_v1.py SRC_PKG OUT_PKG [jobs]"""
import os, sys, json, time, hashlib, subprocess, shutil, traceback
from pathlib import Path
SDK = Path('/opt/qsdk/sdk448-isolated/python'); sys.path.insert(0, str(SDK))
from hbdk4.compiler import load, compile


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


src, out = Path(sys.argv[1]), Path(sys.argv[2]); jobs = int(sys.argv[3]) if len(sys.argv) > 3 else 6
assert (src / 'status.json').exists() and json.loads((src / 'status.json').read_text())['status'] == 'done' and not out.exists()
assert os.getpgrp() == os.getpid()
out.mkdir(parents=True)
r = dict(status='start', started=time.time(), source=str(src), source_hbm_sha256=sha(src / 'model.hbm'),
         compile_arguments=dict(march='nash-m', opt=2, balance=100, max_l2m_size=0, jobs=jobs), profiles=[])


def persist():
    t = out / 'status.json.tmp'; t.write_text(json.dumps(r, indent=1)); t.replace(out / 'status.json')


try:
    bcs = sorted(src.glob('s*/converted.bc')) or [src / 'converted.bc']
    hbos = []
    for bc in bcs:
        e = dict(bc=str(bc), bc_sha256=sha(bc)); r['profiles'].append(e); r['status'] = f'compile {bc.parent.name}'; persist()
        m = load(str(bc)); assert len(m.functions) == 1; t = time.monotonic()
        dst = out / (bc.parent.name if bc.parent != src else '.'); dst.mkdir(exist_ok=True)
        compile(m, str(dst / 'model.hbo'), march='nash-m', opt=2, jobs=jobs, balance=100, max_l2m_size=0, progress_bar=False)
        e.update(seconds=time.monotonic() - t, hbo_sha256=sha(dst / 'model.hbo')); hbos.append(dst / 'model.hbo'); persist()
    r['status'] = 'linking'; persist()
    subprocess.run([str(SDK / 'hbdk4/compiler/_mlir_libs/hbdk-lld')] + [str(x) for x in hbos] + ['-o', str(out / 'model.hbm')], check=True)
    dis = json.loads(subprocess.check_output([str(SDK / 'hbdk4/compiler/_mlir_libs/hbrt4-disas'), '--json', str(out / 'model.hbm')], text=True))
    assert all(n['device'] == 'DEVICE_CATEGORY_BPU' for g in dis['graphs'] for n in g['nodes']), 'neural CPU fallback'
    for d in src.glob('s*'):               # ports + fixtures (inputs/compiler refs) for the bitwise O0==O2 board check
        if d.is_dir():
            (out / d.name).mkdir(exist_ok=True); shutil.copy2(d / 'ports.json', out / d.name / 'ports.json')
            for c in d.iterdir():
                if c.is_dir():
                    shutil.copytree(c, out / d.name / c.name, dirs_exist_ok=True)
    for extra in ['tokens.json']:
        if (src / extra).exists():
            shutil.copy2(src / extra, out / extra)
    r.update(status='done', hbm_sha256=sha(out / 'model.hbm'), hbm_bytes=(out / 'model.hbm').stat().st_size,
             compiler_memory=[g.get('modelMemoryRequirement') for g in dis['graphs']])
except BaseException:
    r.update(status='failed', error=traceback.format_exc()); raise
finally:
    r['finished'] = time.time(); persist()
print(r['status'], r.get('hbm_bytes'))
