"""Compile a verified saved BC in a fresh process; never repeats calibration."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import shutil

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--bc', type=Path, required=True)
p.add_argument('--expected-sha256', required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--jobs', type=int, default=8)
p.add_argument('--opt', type=int, choices=[0, 1, 2], default=0)
p.add_argument('--cache-mode', choices=['enable', 'disable'], default='enable')
p.add_argument('--cache-source', type=Path,
               help='Copy a matching saved compiler-cache; completed steps may be reused, not a resume guarantee')
p.add_argument('--filename', default='gpen256.hbm',
               help='Output basename; model identity remains encoded in the saved BC')
a = p.parse_args()
assert Path(a.filename).name == a.filename and a.filename.endswith('.hbm')
assert a.filename not in ('.hbm', '..hbm') and '/' not in a.filename and '\\' not in a.filename
assert hashlib.sha256(a.bc.read_bytes()).hexdigest() == a.expected_sha256
assert 1 <= a.jobs <= 16
a.output.mkdir(exist_ok=False)
record = {'bc_sha256': a.expected_sha256, 'target': 'nash-m', 'jobs': a.jobs,
          'opt': a.opt, 'debug': False, 'cache_mode': a.cache_mode,
          'output_filename': a.filename,
          'calibration_repeated': False, 'accuracy_verified': False,
          'production_deployed': False, 'started_unix': time.time()}

def save():
    (a.output / 'status.json').write_text(json.dumps(record, indent=2))

save()
if a.cache_source:
    assert a.cache_mode == 'enable' and a.cache_source.is_dir()
    previous = json.loads((a.cache_source.parent / 'status.json').read_text())
    assert previous['bc_sha256'] == a.expected_sha256
    assert previous['target'] == 'nash-m' and previous['opt'] == a.opt
    shutil.copytree(a.cache_source, a.output / 'compiler-cache')
    record['cache_source'] = str(a.cache_source)
    record['cache_reuse_guaranteed'] = False
    save()
from hbdk4.compiler import load, compile
module = load(str(a.bc))
record['state'] = 'compiling'
save()
try:
    compile(module, str(a.output / a.filename), march='nash-m',
            opt=a.opt, jobs=a.jobs, debug=False, progress_bar=True,
            balance=100, input_no_padding=False, output_no_padding=False,
            cache_mode=a.cache_mode, cache_path=str(a.output / 'compiler-cache') if a.cache_mode == 'enable' else '')
    hbm = a.output / a.filename
    assert hbm.is_file() and hbm.stat().st_size > 0
    record.update(state='compiled_needs_validation',
                  hbm_sha256=hashlib.sha256(hbm.read_bytes()).hexdigest(),
                  hbm_bytes=hbm.stat().st_size)
except Exception as error:
    record.update(state='compile_failed', error=str(error))
    raise
finally:
    record['finished_unix'] = time.time()
    save()
