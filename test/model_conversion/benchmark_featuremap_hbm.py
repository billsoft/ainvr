#!/usr/bin/env python3
"""AINVR bounded real-board featuremap HBM speed test; no accuracy claim."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import hbm_runtime
import numpy as np

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--model', type=Path, required=True)
p.add_argument('--input-f32', type=Path, required=True)
p.add_argument('--precision-report', type=Path, required=True)
p.add_argument('--report', type=Path, required=True)
p.add_argument('--frames', type=int, default=60)
args = p.parse_args()
assert 1 <= args.frames <= 120
assert not args.report.exists()
precision = json.loads(args.precision_report.read_text())
# Do not benchmark a neural CPU fallback as BPU inference. Integer indices,
# type casts and result ordering are recorded separately as output logic.
cpu_ops = precision.get('external_cpu_ops', [])
allowed = {'hbir.cast_type', 'hbir.gather_elements'}
allowed_integer_calls = {'/model.23/Mod', '/model.23/Div_1'}
assert all(op['op_type'] in allowed or
           (op['op_type'] == 'hbtl.call' and op['op_name'] in allowed_integer_calls
            and all(t.startswith('si') for t in op.get('input_types', []))) for op in cpu_ops), 'Neural CPU fallback is not allowed'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
model_hash = sha(args.model)
assert precision['hbm_sha256'] == model_hash
runtime = hbm_runtime.HB_HBMRuntime(str(args.model))
assert len(runtime.model_names) == 1
name = runtime.model_names[0]
names = runtime.input_names[name]
assert len(names) == 1, 'Single featuremap input is required'
key = names[0]
shape = tuple(runtime.input_shapes[name][key])
data = np.fromfile(args.input_f32, dtype='<f4')
assert np.prod(shape) == data.size and np.isfinite(data).all()
inputs = {name: {key: data.reshape(shape)}}
runtime.set_scheduling_params(bpu_cores={name: [0]})
deadline = time.monotonic() + 90
reference = runtime.run(inputs)[name]
reference = {k: v.copy() for k, v in reference.items()}
assert reference and all(v.size and np.isfinite(v).all() for v in reference.values())
for _ in range(9):
    assert time.monotonic() < deadline
    runtime.run(inputs)
latencies = []
for _ in range(args.frames):
    assert time.monotonic() < deadline
    start = time.perf_counter()
    result = runtime.run(inputs)[name]
    latencies.append((time.perf_counter() - start) * 1000)
    assert result.keys() == reference.keys()
    for key in result:
        np.testing.assert_allclose(result[key], reference[key], rtol=1e-5, atol=1e-6)
values = np.array(latencies)
report = {'passed': True, 'model': str(args.model), 'model_name': name,
          'model_sha256': model_hash, 'input_sha256': sha(args.input_f32),
          'precision_report': str(args.precision_report), 'actual_precision': precision,
          'input_shape': list(shape), 'output_shapes': {k: list(v.shape) for k, v in reference.items()},
          'frames': args.frames, 'warmup_frames': 10, 'bpu_cores': [0],
          'median_ms': float(np.median(values)), 'p95_ms': float(np.percentile(values, 95)),
          'mean_ms': float(values.mean()), 'sequential_fps': float(1000 / values.mean()),
          'timing': 'synchronous official HBM runtime; preloaded hardware-preprocessed input; excludes video decode, preprocessing, result validation',
          'cpu_neural_inference': False, 'external_cpu_output_logic_ops': cpu_ops,
          'accuracy_verified': False, 'production_model': False,
          'deterministic_finite_output': True}
assert sha(args.model) == model_hash
args.report.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k:report[k] for k in ('passed', 'median_ms', 'p95_ms', 'sequential_fps', 'accuracy_verified')}), flush=True)
