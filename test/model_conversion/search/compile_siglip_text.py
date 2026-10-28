"""AINVR SigLIP text tower: PTQ -> advice (placement audit) -> BC -> HBM.

Offline compile candidate. No deployment, no accuracy approval. Embedding lookup,
LayerNorm, attention and MLP must all stay on BPU; any neural CPU fallback rejects the build.
usage: compile_siglip_text.py --onnx X --calibration DIR --output OUT --precision int16|mixed --opt 0|2
"""
import argparse, hashlib, json, logging, os, time
from pathlib import Path
import numpy as np
import onnx
from hmct.ir import OnnxModel
from hmct.builder.model_builder import ModelBuilder
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert, compile, save as save_bc

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--onnx', type=Path, required=True)
p.add_argument('--calibration', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--precision', choices=['int16', 'int8', 'mixed', 'int16-lnf16', 'int16-lnbf16', 'int16-lnf32'], default='int16')
p.add_argument('--opt', type=int, choices=[0, 2], default=2)
p.add_argument('--jobs', type=int, default=4)
p.add_argument('--name', default='siglip_text')
p.add_argument('--stop-after-advice', action='store_true')
p.add_argument('--resume-ptq', type=Path, help='existing HMCT *_ptq_model.onnx (skips calibration/quantization)')
a = p.parse_args()
a.output.mkdir(exist_ok=False)
logging.basicConfig(level=logging.INFO)
digest = lambda q: hashlib.sha256(q.read_bytes()).hexdigest()
r = {'state': 'preparing', 'started_unix': time.time(), 'target': 'nash-m', 'precision': a.precision, 'opt': a.opt,
     'source_onnx_sha256': digest(a.onnx), 'production_approved': False, 'accuracy_verified': False}


def save():
    (a.output / 'status.json').write_text(json.dumps(r, indent=2))


save()
try:
    files = sorted(a.calibration.glob('*.npy'))
    assert len(files) >= 256, len(files)
    data = []
    for f in files:
        t = np.load(f)
        assert t.dtype == np.int64 and t.shape == (1, 64) and t.min() >= 0 and t.max() < 250000
        data.append(t)
    r.update(state='quantizing', calibration_samples=len(data)); save()
    if a.precision == 'int16':
        qc = {'model_config': {'all_node_type': 'int16', 'activation': {'calibration_type': 'max'}}}
    elif a.precision.startswith('int16-ln'):
        # native LayerNorm kept (float variance) so massive-activation channels do not wreck the fixed-point chain
        t = {'int16-lnf16': 'float16', 'int16-lnbf16': 'bfloat16', 'int16-lnf32': 'float32'}[a.precision]
        qc = {'model_config': {'all_node_type': 'int16', 'activation': {'calibration_type': 'max'}},
              'op_config': {'LayerNormalization': {'qtype': t}}}
    elif a.precision == 'int8':
        qc = {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'max'}}}
    else:   # int8 weights/activations for matmul-heavy nodes; normalization/softmax/residual path in int16
        qc = {'model_config': {'all_node_type': 'int8', 'activation': {'calibration_type': 'max'}},
              'op_config': {'LayerNormalization': {'qtype': 'int16'}, 'Softmax': {'qtype': 'int16'},
                            'Gather': {'qtype': 'int16'}}}
    if a.resume_ptq:
        # HMCT already wrote text_ptq_model.onnx (+ external data); the 2 GB protobuf limit only bites on re-save.
        ptq = onnx.load(str(a.resume_ptq))
        r['resumed_from_ptq'] = str(a.resume_ptq)
    else:
        g = onnx.load(str(a.onnx))
        b = ModelBuilder(OnnxModel(g), 'nash-m', save_model=True, verbose=False, name_prefix=str(a.output / 'text'),
                         cali_dict={'calibration_data': {'input_ids': data}}, user_quant_config=qc)
        ptq = b.build()
        assert ptq is not None
    r['state'] = 'converting'; save()
    m = export(proto=ptq, name=a.name)
    m = convert(m, march='nash-m', advice=True, advice_path=str(a.output) + '/')
    ops = json.loads((a.output / f'{a.name}_advice.json').read_text())
    cpu = [x for x in ops if x['backend'] == 'external_cpu']
    r.update(external_cpu_ops=cpu, op_count=len(ops))
    save()
    # Only pure integer token-id index logic (clamp/compare/cast of int64 ids) may stay on the host.
    # Any op touching floating point activations or weights is a neural fallback and rejects the build.
    is_int = lambda x: bool(x.get('input_types')) and all(t.startswith(('si', 'ui')) for t in x['input_types'])
    rejected = [x for x in cpu if not is_int(x)]
    r.update(cpu_integer_index_ops=[{'op': x.get('op_name') or x['check_info'][0].get('op_detail', '')[:80],
                                    'input_types': x.get('input_types')} for x in cpu if is_int(x)],
             cpu_neural_fallback_rejected_ops=rejected)
    save()
    assert ops and not rejected, 'neural CPU fallback present; do not deploy: ' + json.dumps(rejected)[:600]
    save_bc(m, str(a.output / 'quantized.bc'))
    r.update(state='bc_saved', bc_sha256=digest(a.output / 'quantized.bc')); save()
    if a.stop_after_advice:
        r['state'] = 'stopped_after_bc'
    else:
        r['state'] = 'compiling'; save()
        compile(m, str(a.output / f'{a.name}.hbm'), march='nash-m', opt=a.opt, jobs=a.jobs, debug=False, progress_bar=True)
        r.update(state='compiled_needs_validation', hbm_sha256=digest(a.output / f'{a.name}.hbm'))
except BaseException as e:
    r.update(state='failed', error=repr(e))
    raise
finally:
    r['finished_unix'] = time.time(); save()
print(json.dumps(r, indent=2), flush=True)
