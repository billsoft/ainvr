"""PTQ simulation score for a vision tower: usage ptq_sim_vision.py PTQ.onnx EVAL_INPUTS.npy EVAL_FLOAT.npy [N]"""
import sys, numpy as np, onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path
o = ort.SessionOptions(); o.log_severity_level = 3; o.intra_op_num_threads = 4
o.register_custom_ops_library(get_operators_path()); o.register_custom_ops_library(get_library_path())
s = ort.InferenceSession(sys.argv[1], o, providers=['CPUExecutionProvider'])
x = np.load(sys.argv[2]); f = np.load(sys.argv[3]); N = int(sys.argv[4]) if len(sys.argv) > 4 else 48
idx = np.linspace(0, len(x) - 1, N).astype(int)
nm = s.get_inputs()[0].name
y = np.concatenate([s.run(None, {nm: x[i:i + 1]})[0].reshape(1, -1) for i in idx]); f = f[idx]
n = lambda a: a / np.linalg.norm(a, axis=1, keepdims=True)
c = (n(f) * n(y)).sum(1)
sf, sh = n(f) @ n(f).T, n(y) @ n(y).T
np.fill_diagonal(sf, -9); np.fill_diagonal(sh, -9)
print('vision PTQ sim cos mean/min %.5f %.5f nn-agree %.3f' % (c.mean(), c.min(), (sf.argmax(1) == sh.argmax(1)).mean()))
