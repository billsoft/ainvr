"""Independent written-payload test of the active group32 activation-order GPTQ.

CPU toy matrices only; no GPU context, model execution or deployment claim.
Exercise static original-column grouping and permutation inversion against the
actual saved NPZ, including correlated Hessian and BF16 weight storage.
"""
import ast
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import torch
source=Path('/work/official-llm-v1/prepare_locateanything_gptq_g32_actorder_v7.py')
assert hashlib.sha256(source.read_bytes()).hexdigest()=='e3c05111a25f0ed818e7eb25f2d915d067cace49b671d0cbd2b14bd68341dc87'
root=Path('/opt/locate-actorder-packing-contract-v1');assert not root.exists();root.mkdir()
assert not torch.cuda.is_initialized()
torch.cuda.synchronize=lambda:None
torch.set_num_threads(2)
function=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='quantize')
working=dict(modules=[])
namespace=dict(torch=torch,np=np,time=time,Path=Path,hashlib=hashlib,GROUP_SIZE=32,packed=root,report=working,save=lambda:None)
exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
result=dict(status='running',scope=__doc__,started=time.time(),source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),cases=[],board_calls=0,whole_model_verified=False)
rng=torch.Generator().manual_seed(1907)
for case,kind,dtype in [(0,'identity',torch.float32),(1,'reverse_diagonal',torch.bfloat16),(2,'correlated',torch.bfloat16)]:
    original=(torch.randn(8,64,generator=rng)*.3+.2).to(dtype)
    layer=torch.nn.Linear(64,8,bias=False,dtype=dtype)
    with torch.no_grad():layer.weight.copy_(original)
    if kind=='identity':hessian=torch.eye(64)
    elif kind=='reverse_diagonal':hessian=torch.diag(torch.linspace(.2,3.,64))
    else:
        a=torch.randn(64,80,generator=rng);hessian=a@a.T/80+torch.eye(64)*.1
    name=f'language_model.model.layers.{case}.mlp.gate_proj'
    namespace['quantize'](name,layer,hessian)
    record=working['modules'][-1]
    with np.load(record['packed_file']) as data:
        payload=data['packed'];assert payload.dtype==np.uint8 and payload.shape==(8,32)
        codes=np.stack([payload&15,payload>>4],axis=-1).reshape(8,64)
        scales=np.repeat(data['scales'],32,axis=1);zeros=np.repeat(data['zeros'],32,axis=1)
        decoded=(codes.astype(np.float32)-zeros)*scales
        assert torch.equal(torch.from_numpy(decoded).to(dtype),layer.weight.detach())
        expected=torch.argsort(hessian.diagonal(),descending=True).numpy()
        assert np.array_equal(data['activation_order'],expected)
        if kind=='reverse_diagonal':assert not np.array_equal(expected,np.arange(64))
        if kind in ['identity','reverse_diagonal']:
            assert np.all(np.abs(decoded-original.float().numpy())<=.5001*scales+1e-6)
    result['cases'].append(dict(hessian=kind,storage_dtype=str(dtype),written_file_decode_exact=True,input_permutation_required=False,payload_bytes=payload.nbytes,sha256=record['sha256']))
assert not torch.cuda.is_initialized()
result.update(status='completed',cuda_context_initialized=False,finished=time.time())
(root/'status.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
