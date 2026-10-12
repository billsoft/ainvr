"""AINVR board validation of matching RepRTA on 128 independent raw vectors."""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import hbm_runtime
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
s=json.loads((a.candidate/'status.json').read_text());assert s['kind']=='reprta' and s['state']=='compiled_needs_validation'
assert not s['external_cpu_ops'] and not s['cpu_neural_fallback_rejected_ops']
model=a.candidate/'reprta.hbm';assert hashlib.sha256(model.read_bytes()).hexdigest()==s['hbm_sha256']
rt=hbm_runtime.HB_HBMRuntime(str(model));assert len(rt.model_names)==1
name=rt.model_names[0];assert rt.input_names[name]==['text_embeddings']
assert tuple(rt.input_shapes[name]['text_embeddings'])==(1,8,512)
rt.set_scheduling_params(bpu_cores={name:[0]})
files=sorted(a.references.glob('*.npz'));assert len(files)==16
first=np.load(files[0])['input']
for _ in range(5):rt.run({name:{'text_embeddings':first}})
rows=[];latencies=[]
for path in files:
    data=np.load(path);input_=data['input'];ref=data['reference'].astype(np.float64)
    start=time.perf_counter();result=rt.run({name:{'text_embeddings':input_}})[name]
    latencies.append((time.perf_counter()-start)*1000)
    assert len(result)==1;got=next(iter(result.values())).astype(np.float64)
    assert got.shape==ref.shape==(1,8,512) and np.isfinite(got).all()
    for i,phrase in enumerate(data['phrases']):
        x=ref[0,i];y=got[0,i]
        rows.append({'phrase':str(phrase),'cosine':float(np.dot(x,y)/(np.linalg.norm(x)*np.linalg.norm(y))),
                     'relative_l2':float(np.linalg.norm(x-y)/np.linalg.norm(x)),'output_norm':float(np.linalg.norm(y))})
passed=all(x['cosine']>=.995 and x['relative_l2']<=.1 for x in rows)
r={'scope':'RepRTA only on original FP32 encoder embeddings; not the complete BPU text/detector pipeline',
   'samples':128,'hbm_sha256':s['hbm_sha256'],'bc_sha256':s['bc_sha256'],
   'min_cosine':min(x['cosine'] for x in rows),'max_relative_l2':max(x['relative_l2'] for x in rows),
   'batch8_fps_with_production_running':1000/float(np.mean(latencies)),
   'cpu_neural_fallback':False,'reprta_parity_passed':passed,'full_yoloe_hbm_verified':False,
   'production_approved':False,'rows':rows}
a.output.write_text(json.dumps(r,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='rows'},indent=2))
if not passed:raise SystemExit(2)
