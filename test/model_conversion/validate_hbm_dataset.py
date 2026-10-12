"""AINVR bounded BPU validation capture on independent dataset inputs.

Writes raw outputs for comparison with offline FP32 oracles. Finite outputs
and FPS alone are not an accuracy pass and never authorize deployment.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import hbm_runtime

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--inputs',type=Path,required=True)
p.add_argument('--precision-report',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
precision=json.loads(a.precision_report.read_text())
assert sha(a.model)==precision['hbm_sha256']
assert precision.get('placement_passed') is True, 'Placement audit did not pass'
assert not precision.get('cpu_neural_fallback_rejected_ops'), 'Neural CPU fallback rejected'
assert precision.get('backend_counts',{}).get('bpu',0)>0
for op in precision.get('external_cpu_ops',[]):
    assert op['op_type'] in {'hbir.cast_type','hbir.gather_elements','hbtl.call'}
    assert op['op_name'].startswith('/model.23/')
    assert op.get('input_types') and all(t.startswith('si') for t in op['input_types']),op
    if op['op_type']=='hbtl.call':
        assert op['op_name'] in {'/model.23/Mod','/model.23/Div_1'},op
a.output.mkdir(parents=True,exist_ok=False)
runtime=hbm_runtime.HB_HBMRuntime(str(a.model))
assert len(runtime.model_names)==1
name=runtime.model_names[0]; keys=runtime.input_names[name]; assert len(keys)==1
key=keys[0]; shape=tuple(runtime.input_shapes[name][key])
runtime.set_scheduling_params(bpu_cores={name:[0]})
files=sorted(a.inputs.glob('*.bin')); assert len(files)==128
deadline=time.monotonic()+900
latencies=[]; rows=[]
first=np.fromfile(files[0],dtype='<f4').reshape(shape)
for _ in range(10): runtime.run({name:{key:first}})
for i,path in enumerate(files):
    assert time.monotonic()<deadline
    data=np.fromfile(path,dtype='<f4').reshape(shape)
    start=time.perf_counter(); result=runtime.run({name:{key:data}})[name]
    elapsed=(time.perf_counter()-start)*1000; latencies.append(elapsed)
    assert result and all(v.size and np.isfinite(v).all() for v in result.values()),path
    names=list(result)
    np.savez_compressed(a.output/(path.stem+'.npz'),**{str(j):result[k] for j,k in enumerate(names)})
    rows.append({'id':path.stem,'input_sha256':sha(path),'output_names':names,
                 'output_shapes':[list(result[k].shape) for k in names],'latency_ms':elapsed})
    if i%16==0: print(i,flush=True)
report={'model_sha256':sha(a.model),'precision':precision,'samples':rows,
        'backend':'BPU core 0, official HBM runtime','cpu_neural_inference':False,
        'warmup':10,'sequential_fps':1000/float(np.mean(latencies)),
        'median_ms':float(np.median(latencies)),'p95_ms':float(np.percentile(latencies,95)),
        'timing':'Preloaded tensor inference only; excludes decode/preprocessing/disk IO',
        'accuracy_verified':False,'production_deployed':False}
(a.output/'manifest.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:report[k] for k in ['sequential_fps','median_ms','p95_ms','accuracy_verified']}),flush=True)
