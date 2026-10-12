"""AINVR board-only validation of the small runtime-prompt MatMul HBM.

Not a full YOLOE detector or a semantic quality benchmark.
"""
import argparse, hashlib, json, time
from pathlib import Path
import numpy as np
import hbm_runtime

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists();s=json.loads((a.candidate/'status.json').read_text())
assert s['state']=='compiled_needs_board_validation' and all(x['backend']=='bpu' for x in s['placement'])
assert hashlib.sha256((a.candidate/'probe.hbm').read_bytes()).hexdigest()==s['hbm_sha256']
runtime=hbm_runtime.HB_HBMRuntime(str(a.candidate/'probe.hbm'));name=runtime.model_names[0]
runtime.set_scheduling_params(bpu_cores={name:[0]});keys=runtime.input_names[name]
assert set(keys)=={'prompt_embeddings','region_features'}
outputs=[];rows=[]
for n in ['a','b']:
    d=np.load(a.candidate/(n+'.npz'));result=runtime.run({name:{k:np.ascontiguousarray(d[k]) for k in keys}})[name]
    assert len(result)==1;got=next(iter(result.values()));ref=d['reference']
    assert got.shape==ref.shape and np.isfinite(got).all()
    cos=float(np.dot(got.ravel(),ref.ravel())/(np.linalg.norm(got)*np.linalg.norm(ref)))
    rmse=float(np.sqrt(np.mean((got-ref)**2)));assert cos>.999 and rmse<.03
    rows.append({'case':n,'cosine_to_float_reference':cos,'rmse':rmse,'max_abs_error':float(np.max(np.abs(got-ref)))})
    outputs.append(got.copy())
delta=float(np.max(np.abs(outputs[0]-outputs[1])));assert delta>.1
r={'timestamp':time.time(),'scope':'Two-input MatMul only, not full YOLOE',
   'BPU_operator_verified':True,'full_yoloe_hbm_verified':False,
   'semantic_detection_verified':False,'production_approved':False,
   'model_sha256':s['hbm_sha256'],'inputs':s['inputs'],'placement':s['placement'],
   'cases':rows,'runtime_prompt_switch_max_output_delta':delta,'cpu_neural_fallback':False,
   'note':'Synthetic functionality probe. MatMul lowering has mixed si16/si8 inputs, despite global int16 request.'}
a.output.write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2))
