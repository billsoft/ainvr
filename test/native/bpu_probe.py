"""HB_HBMRuntime experiment based on the installed official ResNet18 example."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import hbm_runtime
import numpy as np

p = argparse.ArgumentParser()
p.add_argument("model")
p.add_argument("frames", type=int)
args = p.parse_args()
model = hbm_runtime.HB_HBMRuntime(args.model)
name = model.model_names[0]
names = model.input_names[name]
shapes = model.input_shapes[name]
inputs = {}
for index, key in enumerate(names):
    shape = tuple(shapes[key])
    # This experiment deliberately supports the installed two-plane NV12 models.
    if len(names) != 2 or len(shape) != 4:
        raise SystemExit("Unsupported input contract: supply an NV12 two-plane model")
    inputs[key] = np.full(shape, 73 if index == 0 else 128, dtype=np.uint8)
model.set_scheduling_params(bpu_cores={name: [0]})
data = {name: inputs}
reference = model.run(data)[name]
if not reference or any(v.size == 0 or not np.isfinite(v).all() for v in reference.values()):
    raise RuntimeError("Empty or non-finite inference output")
reference = {k: v.copy() for k, v in reference.items()}
for _ in range(3):
    model.run(data)
latencies = []
for _ in range(args.frames):
    start = time.perf_counter()
    result = model.run(data)[name]
    latencies.append(time.perf_counter() - start)
    if result.keys() != reference.keys():
        raise RuntimeError("Output keys changed")
    for key in reference:
        if not np.allclose(result[key], reference[key], rtol=1e-5, atol=1e-6):
            raise RuntimeError("Identical input produced inconsistent output: " + key)
samples = np.array(latencies) * 1000
print("HWJSON " + json.dumps({
    "model": str(Path(args.model).resolve()), "model_name": name,
    "input_shapes": {k: list(v.shape) for k, v in inputs.items()},
    "output_shapes": {k: list(v.shape) for k, v in reference.items()},
    "output_sha256": {k: hashlib.sha256(v.tobytes()).hexdigest() for k, v in reference.items()},
    "frames": args.frames, "warmup_frames": 4, "bpu_core": 0,
    "latency_ms_mean": float(samples.mean()), "latency_ms_p50": float(np.percentile(samples, 50)),
    "latency_ms_p95": float(np.percentile(samples, 95)),
    "sequential_fps": args.frames / sum(latencies),
    "validation": "finite, nonempty, deterministic output; no labeled accuracy claim",
    "timing": "synchronous HB_HBMRuntime.run, including runtime overhead"}))
