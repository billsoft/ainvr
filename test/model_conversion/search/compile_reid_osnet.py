"""AINVR OSNet-AIN x1.0 person ReID: export -> PTQ (real field crops) -> placement audit -> HBM.

Offline compile candidate; deployment and accuracy approval are separate steps.
Input: float32 NCHW (1,3,256,128), ImageNet-normalized RGB; output: 512-d feature (L2-normalize on host).
"""
import argparse, hashlib, json, logging, sys, time
from pathlib import Path
import numpy as np
import torch
import onnx

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--weights', type=Path, required=True)
p.add_argument('--source-dir', type=Path, required=True, help='dir containing osnet_ain.py')
p.add_argument('--calibration', type=Path, required=True, help='dir of person jpg crops')
p.add_argument('--eval', type=Path, required=True, help='dir of held-out person jpg crops')
p.add_argument('--output', type=Path, required=True)
p.add_argument('--precision', choices=['int8', 'int16'], default='int8')
p.add_argument('--opt', type=int, choices=[0, 2], default=2)
p.add_argument('--jobs', type=int, default=4)
a = p.parse_args()
a.output.mkdir(exist_ok=False)
logging.basicConfig(level=logging.INFO)
sys.path.insert(0, str(a.source_dir))
H, W = 256, 128
MEAN, STD = np.array([0.485, 0.456, 0.406], 'f4'), np.array([0.229, 0.224, 0.225], 'f4')
digest = lambda q: hashlib.sha256(q.read_bytes()).hexdigest()
r = {'state': 'exporting', 'started_unix': time.time(), 'target': 'nash-m', 'precision': a.precision, 'opt': a.opt,
     'weights_sha256': digest(a.weights), 'production_approved': False, 'accuracy_verified': False}


def save():
    (a.output / 'status.json').write_text(json.dumps(r, indent=2))


def load_images(d):
    import cv2
    out = []
    for f in sorted(d.glob('*.jpg')):
        im = cv2.imread(str(f))
        if im is None:
            continue
        im = cv2.cvtColor(cv2.resize(im, (W, H), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB)
        x = ((im.astype('f4') / 255.0 - MEAN) / STD).transpose(2, 0, 1)[None]
        out.append(np.ascontiguousarray(x))
    return out


save()
try:
    from osnet_ain import osnet_ain_x1_0
    m = osnet_ain_x1_0(num_classes=1000, pretrained=False, loss='softmax')
    sd = torch.load(a.weights, map_location='cpu', weights_only=True)
    miss = m.load_state_dict(sd, strict=False)
    assert set(miss.missing_keys) == {'classifier.weight', 'classifier.bias'} and not miss.unexpected_keys, miss
    m.eval()
    calib, held = load_images(a.calibration), load_images(a.eval)
    assert len(calib) >= 256 and len(held) >= 128, (len(calib), len(held))
    onnx_path = a.output / 'osnet_ain_x1_0.onnx'
    torch.onnx.export(m, (torch.from_numpy(calib[0]),), str(onnx_path), input_names=['input'], output_names=['feature'],
                      opset_version=17, do_constant_folding=True, dynamo=False)
    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    err = 0.0
    with torch.no_grad():
        for x in held[:16]:
            err = max(err, float(np.abs(sess.run(None, {'input': x})[0] - m(torch.from_numpy(x)).numpy()).max()))
    assert err < 1e-3, err
    # float reference features of the held-out set, for later board-side comparison
    ref = np.concatenate([sess.run(None, {'input': x})[0] for x in held])
    np.save(a.output / 'eval_float_features.npy', ref)
    np.save(a.output / 'eval_inputs.npy', np.concatenate(held))
    g = onnx.load(str(onnx_path))
    r.update(state='quantizing', onnx_max_abs_err=err, onnx_ops=sorted({n.op_type for n in g.graph.node}),
             calibration_samples=len(calib), eval_samples=len(held), onnx_sha256=digest(onnx_path)); save()

    from hmct.ir import OnnxModel
    from hmct.builder.model_builder import ModelBuilder
    from hbdk4.compiler.onnx import export
    from hbdk4.compiler import convert, compile, save as save_bc
    qc = {'model_config': {'all_node_type': a.precision, 'activation': {'calibration_type': 'max'}}}
    b = ModelBuilder(OnnxModel(g), 'nash-m', save_model=True, verbose=False, name_prefix=str(a.output / 'reid'),
                     cali_dict={'calibration_data': {'input': calib}}, user_quant_config=qc)
    ptq = b.build()
    assert ptq is not None
    onnx.save(ptq, a.output / 'ptq.onnx')
    r['state'] = 'converting'; save()
    mod = export(proto=ptq, name='osnet_ain')
    mod = convert(mod, march='nash-m', advice=True, advice_path=str(a.output) + '/')
    ops = json.loads((a.output / 'osnet_ain_advice.json').read_text())
    cpu = [x for x in ops if x['backend'] == 'external_cpu']
    r.update(external_cpu_ops=cpu, op_count=len(ops)); save()
    assert ops and not cpu, 'neural CPU fallback: ' + json.dumps(cpu)[:600]
    save_bc(mod, str(a.output / 'quantized.bc'))
    r.update(state='compiling', bc_sha256=digest(a.output / 'quantized.bc')); save()
    compile(mod, str(a.output / 'osnet_ain_x1_0.hbm'), march='nash-m', opt=a.opt, jobs=a.jobs, debug=False, progress_bar=True)
    r.update(state='compiled_needs_validation', hbm_sha256=digest(a.output / 'osnet_ain_x1_0.hbm'))
except BaseException as e:
    r.update(state='failed', error=repr(e))
    raise
finally:
    r['finished_unix'] = time.time(); save()
print(json.dumps(r, indent=2), flush=True)
