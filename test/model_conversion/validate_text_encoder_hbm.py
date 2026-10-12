"""AINVR real-token encoder validation on S100P BPU, before RepRTA."""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import hbm_runtime
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
s=json.loads((a.candidate/'status.json').read_text())
model=a.candidate/'mobileclip2-text.hbm'
assert s['state']=='compiled_needs_validation'
assert hashlib.sha256(model.read_bytes()).hexdigest()==s['hbm_sha256']
assert not s['cpu_neural_fallback_rejected_ops']
for op in s['external_cpu_ops']:
    assert op['op_name'] in {'token_low_index','token_hi_offset','token_high_index'}
    assert op['op_type'] in {'hbir.min','hbir.sub','hbir.max'}
    assert op['input_types']==['si32','si32']
refs=json.loads((a.references/'manifest.json').read_text());assert len(refs['samples'])==128
assert refs['calibration_overlap']==0
rt=hbm_runtime.HB_HBMRuntime(str(model));assert len(rt.model_names)==1
name=rt.model_names[0];assert rt.input_names[name]==['tokens']
assert tuple(rt.input_shapes[name]['tokens'])==(1,77)
rt.set_scheduling_params(bpu_cores={name:[0]})
first=np.load(a.references/refs['samples'][0]['file'])['tokens']
for _ in range(5):rt.run({name:{'tokens':first}})
rows=[];latencies=[];deadline=time.monotonic()+900
for i,item in enumerate(refs['samples']):
    assert time.monotonic()<deadline
    d=np.load(a.references/item['file']);tokens=d['tokens'];ref=d['reference'].astype(np.float64)
    assert tokens.dtype==np.int32 and tokens.min()>=0 and tokens.max()<=49407
    start=time.perf_counter();res=rt.run({name:{'tokens':tokens}})[name]
    latencies.append((time.perf_counter()-start)*1000)
    assert len(res)==1;got=next(iter(res.values())).astype(np.float64)
    assert got.shape==ref.shape==(1,512) and np.isfinite(got).all()
    cos=float(np.dot(got.ravel(),ref.ravel())/(np.linalg.norm(got)*np.linalg.norm(ref)))
    relative_l2=float(np.linalg.norm(got-ref)/np.linalg.norm(ref))
    rows.append({'phrase':item['phrase'],'cosine':cos,'relative_l2':relative_l2,
                 'max_abs_error':float(np.max(np.abs(got-ref))),'latency_ms':latencies[-1]})
    if i%32==0:print('texts',i,flush=True)
passed=all(x['cosine']>=.995 and x['relative_l2']<=.1 for x in rows)
r={'scope':'MobileCLIP2 encoder only; excludes RepRTA and full YOLOE detector',
   'hbm_sha256':s['hbm_sha256'],'bc_sha256':s['bc_sha256'],'samples':128,
   'calibration_overlap':0,'min_cosine':min(x['cosine'] for x in rows),
   'mean_cosine':float(np.mean([x['cosine'] for x in rows])),
   'max_relative_l2':max(x['relative_l2'] for x in rows),
   'max_abs_error':max(x['max_abs_error'] for x in rows),
   'sequential_fps_with_production_running':1000/float(np.mean(latencies)),
   'gates':{'minimum_cosine_per_text':.995,'maximum_relative_l2_per_text':.1},
   'cpu_neural_fallback':False,'cpu_integer_index_ops':3,
   'encoder_quantization_parity_passed':passed,'full_yoloe_hbm_verified':False,
   'production_approved':False,'rows':rows}
a.output.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:v for k,v in r.items() if k!='rows'},indent=2),flush=True)
if not passed:raise SystemExit(2)
