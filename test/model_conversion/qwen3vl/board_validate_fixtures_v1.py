"""Board: run a linked multi-profile HBM on fixture dirs (input-XX.npy -> compiler-XX.npy), require bitwise equality, time calls.
usage: python3 board_validate_fixtures_v1.py PACKAGE_DIR [repeats]"""
import sys, json, time, hashlib
from pathlib import Path
import numpy as np
import hbm_runtime

root = Path(sys.argv[1]); reps = int(sys.argv[2]) if len(sys.argv) > 2 else 5
rt = hbm_runtime.HB_HBMRuntime(str(root / 'model.hbm'))
names = list(rt.model_names)
rt.set_scheduling_params(bpu_cores={n: [0] for n in names})
res = dict(package=str(root), models=names, cases=[], all_bitwise_exact=True)
for prof_dir in sorted(d for d in root.glob('s*') if d.is_dir()):
    ports = json.loads((prof_dir / 'ports.json').read_text())
    shapes = {x['name']: list(x['shape']) for x in ports['inputs']}
    name = [n for n in names if {k: list(v) for k, v in dict(rt.input_shapes[n]).items()} == shapes]
    assert len(name) == 1, (prof_dir, name)
    name = name[0]; in_names = [x['name'] for x in ports['inputs']]; out_names = [x['name'] for x in ports['outputs']]
    assert set(in_names) == set(rt.input_names[name]) and set(out_names) == set(rt.output_names[name])
    for case in sorted(d for d in prof_dir.iterdir() if d.is_dir()):
        xs = [np.load(case / f'input-{i:02d}.npy') for i in range(len(in_names))]
        refs = [np.load(case / f'compiler-{i:02d}.npy') for i in range(len(out_names))]
        feed = {n: x for n, x in zip(in_names, xs)}
        times = []
        for _ in range(reps):
            t = time.perf_counter(); out = rt.run({name: feed})[name]; times.append((time.perf_counter() - t) * 1000)
        outs = [np.asarray(out[n]) for n in out_names]
        exact = all(o.shape == r.shape and o.dtype == r.dtype and np.array_equal(o, r) for o, r in zip(outs, refs))
        diff = max(float(np.abs(o.astype(np.float64) - r).max()) for o, r in zip(outs, refs))
        res['all_bitwise_exact'] &= exact
        res['cases'].append(dict(profile=prof_dir.name, case=case.name, model=name, bitwise_exact=exact, max_abs_diff=diff,
                                 ms_median=float(np.median(times)), ms_min=float(min(times))))
        print(json.dumps(res['cases'][-1]), flush=True)
(root / 'board-validate-v1.json').write_text(json.dumps(res, indent=1))
print('ALL_BITWISE_EXACT', res['all_bitwise_exact'])
