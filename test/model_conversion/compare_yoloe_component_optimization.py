"""AINVR same-BC O0/O2 comparison for token or dual-input detector HBMs."""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import hbm_runtime
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--kind',choices=['text','detector'],required=True)
p.add_argument('--baseline',type=Path,required=True)
p.add_argument('--optimized',type=Path,required=True)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--images',type=Path)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--production-paused',action='store_true',help='Record isolated timing with the AI production service stopped')
a=p.parse_args();assert not a.output.exists()
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
b=json.loads((a.baseline/'status.json').read_text());o=json.loads((a.optimized/'status.json').read_text())
assert b['state']==o['state']=='compiled_needs_validation'
assert b['bc_sha256']==o['bc_sha256'] and b['target']==o['target']=='nash-m' and b['opt']==0 and o['opt']==2
assert not b['cpu_neural_fallback_rejected_ops']
for op in b['external_cpu_ops']:
    assert a.kind=='text' and op['op_name'] in {'token_low_index','token_hi_offset','token_high_index'}
    assert op['input_types']==['si32','si32']
filename='mobileclip2-text.hbm' if a.kind=='text' else 'detector.hbm'
models=[a.baseline/filename,a.optimized/filename];states=[b,o];runtimes=[];names=[]
for model,state in zip(models,states):
    assert sha(model)==state['hbm_sha256']
    rt=hbm_runtime.HB_HBMRuntime(str(model));assert len(rt.model_names)==1
    name=rt.model_names[0];rt.set_scheduling_params(bpu_cores={name:[0]});runtimes.append(rt);names.append(name)
assert runtimes[0].input_names[names[0]]==runtimes[1].input_names[names[1]]
assert runtimes[0].input_shapes[names[0]]==runtimes[1].input_shapes[names[1]]
manifest=json.loads((a.references/'manifest.json').read_text())
if a.kind=='text':
    items=manifest['samples'];assert manifest['calibration_overlap']==0
    def inputs(item):return {'tokens':np.load(a.references/item['file'])['tokens']}
else:
    assert a.images
    slots=manifest.get('prompt_slots',8);assert slots in (8,32)
    items=[x for x in manifest['samples'] if x['split']=='validation']
    def inputs(item):
        image=a.images/item['image_tensor'];prompt=a.references/item['prompt_file']
        assert sha(image)==item['image_sha256'] and sha(prompt)==item['prompt_sha256']
        return {'images':np.fromfile(image,dtype='<f4').reshape(1,3,640,640),
                'prompt_embeddings':np.fromfile(prompt,dtype='<f4').reshape(1,slots,512)}
assert len(items)==128
first=inputs(items[0])
for rt,name in zip(runtimes,names):
    for _ in range(5):rt.run({name:first})
times=[[],[]];exact=True;maximum=0;deadline=time.monotonic()+900
for i,item in enumerate(items):
    assert time.monotonic()<deadline
    values=inputs(item);results=[]
    for j,(rt,name) in enumerate(zip(runtimes,names)):
        start=time.perf_counter();result=rt.run({name:values})[name];times[j].append((time.perf_counter()-start)*1000);results.append(result)
    assert results[0].keys()==results[1].keys()
    for key in results[0]:
        x,y=results[0][key],results[1][key];assert x.shape==y.shape and np.isfinite(x).all() and np.isfinite(y).all()
        exact &= np.array_equal(x,y);maximum=max(maximum,float(np.max(np.abs(x.astype(np.float64)-y.astype(np.float64)))))
    if i%32==0:print('compared',i,flush=True)
fps=[1000/float(np.mean(x)) for x in times]
report={'scope':a.kind+' component optimization only; full YOLOE accuracy/service/UI remain separate',
        'samples':128,'bc_sha256':b['bc_sha256'],'baseline_sha256':b['hbm_sha256'],'optimized_sha256':o['hbm_sha256'],
        'outputs_exact':bool(exact),'max_abs_difference':maximum,'baseline_fps':fps[0],'optimized_fps':fps[1],
        'speedup':fps[1]/fps[0],'production_concurrently_running':not a.production_paused,
        'optimized_component_verified':bool(exact and fps[1]>fps[0]),'full_yoloe_pipeline_approved':False,
        'calibration_repeated':False,'cpu_neural_fallback':False}
a.output.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
if not report['optimized_component_verified']:raise SystemExit(2)
