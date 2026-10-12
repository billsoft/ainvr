"""AINVR offline CUDA execution probe; never a board inference backend.

Profiles actual node placement rather than trusting provider availability.
Runs only four existing validation inputs and caps the CUDA arena at 4 GiB.
No process or production configuration is modified.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--inputs',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
assert 'CUDAExecutionProvider' in ort.get_available_providers()
a.output.mkdir(parents=True,exist_ok=False)
options=ort.SessionOptions()
options.intra_op_num_threads=2
options.inter_op_num_threads=1
options.use_deterministic_compute=True
options.enable_profiling=True
options.profile_file_prefix=str(a.output/'ort-profile')
options.register_custom_ops_library(get_operators_path())
options.register_custom_ops_library(get_library_path())
providers=[('CUDAExecutionProvider',{'gpu_mem_limit':4*1024**3,
    'arena_extend_strategy':'kSameAsRequested','cudnn_conv_algo_search':'DEFAULT',
    'use_tf32':0}), 'CPUExecutionProvider']
session=ort.InferenceSession(str(a.model),sess_options=options,providers=providers)
assert session.get_providers()[0]=='CUDAExecutionProvider', session.get_providers()
inputs=session.get_inputs(); assert len(inputs)==1
node=inputs[0]; assert node.type=='tensor(float)'
files=sorted(a.inputs.glob('*.bin'))[:4]; assert len(files)==4
first=np.fromfile(files[0],dtype='<f4').reshape(node.shape)
for _ in range(3): session.run(None,{node.name:first})
rows=[]
for path in files:
    tensor=np.fromfile(path,dtype='<f4').reshape(node.shape)
    started=time.perf_counter()
    result=session.run(None,{node.name:tensor})
    elapsed=time.perf_counter()-started
    assert all(np.isfinite(v).all() for v in result)
    np.savez_compressed(a.output/(path.stem+'.npz'),**{str(i):v for i,v in enumerate(result)})
    rows.append({'id':path.stem,'seconds':elapsed,
        'input_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'output_shapes':[list(v.shape) for v in result]})
profile=Path(session.end_profiling())
events=json.loads(profile.read_text())
placements=Counter((e['args'].get('provider'),e['args'].get('op_name'))
    for e in events if e.get('cat')=='Node' and e.get('args',{}).get('provider'))
cuda_events=sum(v for (provider,op),v in placements.items() if provider=='CUDAExecutionProvider')
assert cuda_events>0, 'CUDA provider loaded but no CUDA node execution was recorded'
report={'onnx_sha256':hashlib.sha256(a.model.read_bytes()).hexdigest(),
    'providers':session.get_providers(),'samples':rows,
    'median_ms':float(np.median([r['seconds'] for r in rows])*1000),
    'placement_events':[{'provider':provider,'op':op,'events':n}
        for (provider,op),n in sorted(placements.items())],
    'offline_probe_only':True,'calibration_speed_verified':False,
    'production_gpu_inference':False,'accuracy_verified':False}
(a.output/'manifest.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'median_ms':report['median_ms'],'cuda_events':cuda_events}))
