#!/usr/bin/env python3
"""AINVR board-side HBM feature runner (real BPU, hbm_runtime).

usage: board_run_hbm.py MODEL.hbm INPUTS.npy OUT.npy [--model-name N] [--limit K]
INPUTS.npy has shape (N, *input_shape_without_batch) or (N, 1, ...) matching the model's batch-1 input; each
row is run separately. Output rows are stacked into OUT.npy as float32 (N, ...). Prints mean latency.
"""
import argparse, json, time
import numpy as np
import hbm_runtime

ap = argparse.ArgumentParser()
ap.add_argument('model')
ap.add_argument('inputs')
ap.add_argument('out')
ap.add_argument('--model-name')
ap.add_argument('--limit', type=int)
a = ap.parse_args()
rt = hbm_runtime.HB_HBMRuntime(a.model)
name = a.model_name or rt.model_names[0]
key = rt.input_names[name][0]
shape = tuple(rt.input_shapes[name][key])
dt = str(rt.input_dtypes[name][key])
np_dt = {'F32': np.float32, 'S64': np.int64, 'S32': np.int32, 'S16': np.int16, 'S8': np.int8, 'U8': np.uint8}.get(
    dt.split('.')[-1].split(':')[0].strip(), np.float32)
x = np.load(a.inputs)
if a.limit:
    x = x[:a.limit]
rt.set_scheduling_params(bpu_cores={name: [0]})
outs, lat = [], []
for row in x:
    row = np.ascontiguousarray(row.reshape(shape), dtype=np_dt)
    t = time.perf_counter()
    res = rt.run({name: {key: row}})[name]
    lat.append((time.perf_counter() - t) * 1000)
    k = rt.output_names[name][0]
    outs.append(np.asarray(res[k], dtype=np.float32).reshape(-1))
np.save(a.out, np.stack(outs))
print(json.dumps({'model': a.model, 'name': name, 'rows': len(outs), 'input_dtype': dt, 'mean_ms': float(np.mean(lat)),
                  'p95_ms': float(np.percentile(lat, 95))}))
