"""Exercise actual mixed quantizer on CPU toy matrices, independently decode files.

No GPU context, model inference, calibration data, final images or production.
This tests the new UInt4/UInt8 artifact contract, not model accuracy.
"""
import ast
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import torch

source = Path('/work/official-llm-v1/prepare_locateanything_gptq_sequential_mixed_g32_v8.py')
assert hashlib.sha256(source.read_bytes()).hexdigest() == 'b7e1c671af7426f8c3aee90f2fa5112b392ca3daf67187766f2399a0dafdd1c7'
root = Path('/opt/locate-mixed-packing-contract-v1')
assert not root.exists()
root.mkdir()
assert not torch.cuda.is_initialized()
# The source routine synchronizes after quantization. For this isolated CPU-only
# contract test it must not initialize CUDA or consume the active job's headroom.
torch.cuda.synchronize = lambda: None
torch.set_num_threads(2)
tree = ast.parse(source.read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'quantize')
module = ast.Module(body=[function], type_ignores=[])
working = dict(modules=[])
namespace = dict(torch=torch, np=np, time=time, Path=Path, hashlib=hashlib,
                 GROUP_SIZE=32, packed=root, report=working, save=lambda: None,
                 available=lambda: int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024)
exec(compile(module, str(source), 'exec'), namespace)
result = dict(status='running', scope=__doc__, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
              started=time.time(), cases=[], board_calls=0, whole_model_verified=False)
generator = torch.Generator().manual_seed(4901)
for suffix, bits in [('mlp.gate_proj', 4), ('self_attn.q_proj', 8)]:
    layer = torch.nn.Linear(64, 8, bias=False, dtype=torch.float32)
    original = torch.randn(8, 64, generator=generator)*.3+.2
    with torch.no_grad():
        layer.weight.copy_(original)
    name = 'language_model.model.layers.0.'+suffix
    namespace['quantize'](name, layer, torch.eye(64))
    record = working['modules'][-1]
    assert record['logical_weight_bits'] == bits and record['packed_roundtrip_exact']
    with np.load(record['packed_file']) as data:
        assert int(data['weight_bits']) == bits and int(data['group_size']) == 32
        shape = data['shape'].tolist()
        assert shape == [8, 64]
        if bits == 4:
            assert 'codes' not in data and data['packed'].dtype == np.uint8
            payload = data['packed']
            decoded_codes = np.stack([payload & 15, payload >> 4], axis=-1).reshape(8, 64)
        else:
            assert 'packed' not in data and data['codes'].dtype == np.uint8
            payload = data['codes']
            decoded_codes = payload.copy()
            assert int(decoded_codes.max()) > 15, 'W8 must not silently clip to4bit range'
        assert payload.nbytes == 8*64*bits//8
        scales = np.repeat(data['scales'], 32, axis=1)
        zeros = np.repeat(data['zeros'], 32, axis=1)
        reconstructed = (decoded_codes.astype(np.float32)-zeros)*scales
        assert np.array_equal(reconstructed, layer.weight.detach().numpy())
        # Identity Hessian yields independent uniform rounding. Check against the
        # ORIGINAL input matrix, rather than comparing two copies of one decoder.
        assert np.all(np.abs(reconstructed-original.numpy()) <= .5001*scales+1e-6)
    result['cases'].append(dict(bits=bits, file_sha256=record['sha256'], packed_payload_bytes=payload.nbytes,
                                independent_file_decode_exact=True, original_uniform_error_bound_passed=True))
assert not torch.cuda.is_initialized()
result.update(status='completed', cuda_context_initialized=False, finished=time.time())
(root/'status.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result, indent=2))
