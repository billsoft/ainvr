"""AINVR ReID PTQ sweep: build several quant configs, score PTQ simulation vs float on held-out crops. No HBM."""
import json, sys, time
from pathlib import Path
import numpy as np
import cv2
import onnx
import onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path
from hmct.ir import OnnxModel
from hmct.builder.model_builder import ModelBuilder

run = Path(sys.argv[1]); calib_dir = Path(sys.argv[2]); out = Path(sys.argv[3]); out.mkdir(exist_ok=True)
names = sys.argv[4:]
H, W = 256, 128
MEAN, STD = np.array([0.485, 0.456, 0.406], 'f4'), np.array([0.229, 0.224, 0.225], 'f4')


def load(d):
    r = []
    for f in sorted(Path(d).glob('*.jpg')):
        im = cv2.imread(str(f))
        im = cv2.cvtColor(cv2.resize(im, (W, H)), cv2.COLOR_BGR2RGB)
        r.append(np.ascontiguousarray(((im.astype('f4') / 255 - MEAN) / STD).transpose(2, 0, 1)[None]))
    return r


calib = load(calib_dir)
held = np.load(run / 'eval_inputs.npy')[:96]
ref = np.load(run / 'eval_float_features.npy')[:96]
n = lambda a: a / np.linalg.norm(a, axis=1, keepdims=True)
CONFIGS = {
    'int8_max': {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'max'}}},
    'int8_kl': {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'kl'}}},
    'int16_max': {'model_config': {'all_node_type': 'int16', 'activation': {'calibration_type': 'max'}}},
    'int8_default': {'model_config': {'all_node_type': 'int8'}},
    'int8_inorm16': {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'max'}},
                     'op_config': {'InstanceNormalization': {'qtype': 'int16'}, 'Sigmoid': {'qtype': 'int16'},
                                   'Gemm': {'qtype': 'int16'}}},
    'int8_perchannel_kl': {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'kl'},
                                            'weight': {'bias_correction': {'num_sample': 32, 'metric': 'cosine-similarity'}}}},
}
g = onnx.load(str(run / 'osnet_ain_x1_0.onnx'))
res = {}
for nm in names:
    t = time.time()
    try:
        b = ModelBuilder(OnnxModel(g), 'nash-m', save_model=False, verbose=False, name_prefix=str(out / nm),
                         cali_dict={'calibration_data': {'input': calib}}, user_quant_config=CONFIGS[nm])
        ptq = b.build()
        o = ort.SessionOptions(); o.log_severity_level = 3
        o.register_custom_ops_library(get_operators_path()); o.register_custom_ops_library(get_library_path())
        s = ort.InferenceSession(ptq.SerializeToString(), o, providers=['CPUExecutionProvider'])
        i = s.get_inputs()[0].name
        y = np.concatenate([s.run(None, {i: r[None]})[0].reshape(1, -1) for r in held])
        c = (n(y) * n(ref)).sum(1)
        sf, sh = n(ref) @ n(ref).T, n(y) @ n(y).T
        np.fill_diagonal(sf, -9); np.fill_diagonal(sh, -9)
        res[nm] = {'cos_mean': float(c.mean()), 'cos_min': float(c.min()), 'nn_agree': float((sf.argmax(1) == sh.argmax(1)).mean()),
                   'sec': round(time.time() - t, 1)}
        onnx.save(ptq, str(out / f'{nm}.ptq.onnx'))
    except Exception as e:
        res[nm] = {'error': repr(e)[:300]}
    print(nm, res[nm], flush=True)
(out / ('sweep_' + '_'.join(names)[:60] + '.json')).write_text(json.dumps(res, indent=1))
