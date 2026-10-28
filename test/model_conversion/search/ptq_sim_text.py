"""PTQ simulation score for a text-tower PTQ ONNX vs its float ONNX. usage: ptq_sim_text.py PTQ.onnx FLOAT.onnx TOKENS.npy [N]"""
import sys, numpy as np, onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path
o = ort.SessionOptions(); o.log_severity_level = 3; o.intra_op_num_threads = 4
o.register_custom_ops_library(get_operators_path()); o.register_custom_ops_library(get_library_path())
s = ort.InferenceSession(sys.argv[1], o, providers=['CPUExecutionProvider'])
fl = ort.InferenceSession(sys.argv[2], providers=['CPUExecutionProvider'])
t = np.load(sys.argv[3])[:int(sys.argv[4]) if len(sys.argv) > 4 else 48]
n = lambda a: a / np.linalg.norm(a, axis=1, keepdims=True)
y = np.concatenate([s.run(None, {'input_ids': r.reshape(1, 64)})[0] for r in t])
x = np.concatenate([fl.run(None, {'input_ids': r.reshape(1, 64)})[0] for r in t])
c = (n(x) * n(y)).sum(1)
sf, sh = n(x) @ n(x).T, n(y) @ n(y).T
np.fill_diagonal(sf, -9); np.fill_diagonal(sh, -9)
print('PTQ sim cos mean/min %.5f %.5f  nn-agree %.3f' % (c.mean(), c.min(), (sf.argmax(1) == sh.argmax(1)).mean()))
