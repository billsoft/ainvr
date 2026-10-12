"""Compare a GPEN graph rewrite with original FP32 outputs, offline only."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--reference',type=Path,required=True)
p.add_argument('--inputs',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False)
reference=json.loads((a.reference/'manifest.json').read_text())
assert reference['onnx_sha256']=='bf7c7ced8e5f69fca6a3a226023a65f8f0689ae9c7d2e095b29c8c78dc3c6bb5'
expected={r['id']:r for r in reference['samples']}
files=sorted(a.inputs.glob('*.bin'));assert len(files)==len(expected)==128
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
options.use_deterministic_compute=True
assert 'CUDAExecutionProvider' in ort.get_available_providers()
session=ort.InferenceSession(str(a.model),options,providers=[
    ('CUDAExecutionProvider',{'gpu_mem_limit':2*1024**3,'use_tf32':0,'cudnn_conv_algo_search':'DEFAULT'}),
    'CPUExecutionProvider'])
inp=session.get_inputs()[0];assert inp.shape==[1,3,256,256]
rows=[]
for i,file in enumerate(files):
    sha=hashlib.sha256(file.read_bytes()).hexdigest()
    assert sha==expected[file.stem]['input_sha256']
    x=np.fromfile(file,dtype='<f4').reshape(inp.shape)
    t=time.perf_counter();actual=session.run(None,{inp.name:x})[0];elapsed=time.perf_counter()-t
    original=np.load(a.reference/(file.stem+'.npz'))['0']
    assert actual.shape==original.shape==(1,3,256,256)
    assert np.isfinite(actual).all() and np.isfinite(original).all()
    error=actual.astype(np.float64)-original.astype(np.float64)
    mse=float(np.mean(error*error))
    rows.append({'id':file.stem,'input_sha256':sha,'max_abs_error':float(np.abs(error).max()),
                 'psnr_db':float(10*np.log10(4/max(mse,1e-20))),'seconds':elapsed})
    np.savez_compressed(a.output/(file.stem+'.npz'),**{'0':actual})
    if i%16==0:print('validated',i,flush=True)
passed=max(r['max_abs_error'] for r in rows)<=1e-3 and min(r['psnr_db'] for r in rows)>=70
report={'model_sha256':hashlib.sha256(a.model.read_bytes()).hexdigest(),
        'original_model_sha256':reference['onnx_sha256'],'samples':rows,
        'fp32_rewrite_parity_passed':passed,'max_abs_error':max(r['max_abs_error'] for r in rows),
        'minimum_psnr_db':min(r['psnr_db'] for r in rows),'production_gpu_inference':False,
        'quantization_accuracy_verified':False,'production_approved':False}
(a.output/'manifest.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:report[k] for k in ['fp32_rewrite_parity_passed','max_abs_error','minimum_psnr_db']}))
if not passed:raise SystemExit(2)
