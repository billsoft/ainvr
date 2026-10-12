"""Offline PTQ simulation oracle; never a production inference backend."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--model', type=Path, required=True)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
a.output.mkdir(exist_ok=False)
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
options.log_severity_level = 3
options.register_custom_ops_library(get_operators_path())
options.register_custom_ops_library(get_library_path())
session = ort.InferenceSession(str(a.model), sess_options=options,
                              providers=['CPUExecutionProvider'])
inputs = session.get_inputs()
assert len(inputs) == 1 and inputs[0].shape == [1, 3, 640, 640]
paths = sorted(a.inputs.glob('*.bin'))
assert len(paths) == 128
report = {'model_format': 'onnx_ptq_simulation', 'backend': 'offline_CPU_test_oracle',
          'production_cpu_inference': False, 'production_approved': False,
          'onnx_sha256': hashlib.sha256(a.model.read_bytes()).hexdigest(),
          'samples': []}
deadline = time.monotonic() + 1200
for i, path in enumerate(paths):
    assert time.monotonic() < deadline
    x = np.fromfile(path, dtype='<f4').reshape(inputs[0].shape)
    values = session.run(None, {inputs[0].name: x})
    assert len(values) == 1 and values[0].shape == (1, 300, 6)
    assert np.isfinite(values[0]).all()
    assert np.array_equal(values[0][:, :, 5], np.floor(values[0][:, :, 5]))
    np.savez_compressed(a.output / (path.stem + '.npz'), **{'0': values[0]})
    report['samples'].append({'id': path.stem,
        'input_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if i % 16 == 0:
        print(i, flush=True)
(a.output / 'manifest.json').write_text(json.dumps(report, indent=2))
print('128 offline PTQ outputs captured; real BPU validation remains required', flush=True)
