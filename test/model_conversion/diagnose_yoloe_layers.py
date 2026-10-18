"""Host-only layer diagnostic of preserved FP32 and PTQ YOLOE graphs."""
import argparse,json,re,hashlib,gc
from pathlib import Path
import numpy as np
import onnx
from hmct.executor import ORTExecutor
p=argparse.ArgumentParser()
for k in ('float-model','ptq-model','prepared','images','output'):p.add_argument('--'+k,type=Path,required=True)
p.add_argument('--attention-detail',action='store_true')
a=p.parse_args(); assert not a.output.exists(); a.output.mkdir()
f=onnx.load(a.float_model);q=onnx.load(a.ptq_model)
qnames={o for n in q.graph.node for o in n.output}
selected={}
for n in f.graph.node:
    match=re.match(r'/model\.(\d+)/',n.name)
    if match and int(match[1])<23:
        for out in n.output:
            if out in qnames:selected[int(match[1])]=out
names=[selected[k] for k in sorted(selected)]
assert len(names)>=20
if a.attention_detail:
    names=[o for n in f.graph.node if n.name.startswith('/model.10/') and n.op_type in ('Conv','Add','Mul','MatMul','Softmax','HzSwish') for o in n.output if o in qnames]
    assert len(names)>=10

manifest=json.loads((a.prepared/'manifest.json').read_text())
samples=[s for s in manifest['samples'] if s['split']=='validation'][:2]
for m in (f,q):
    existing={o.name for o in m.graph.output}
    m.graph.output.extend(onnx.helper.make_tensor_value_info(n,onnx.TensorProto.FLOAT,None) for n in names if n not in existing)
references=[]
runtime=ORTExecutor(f).to('cpu').create_session()
def inputs(s):
    ip=a.images/s['image_tensor']; pp=a.prepared/s['prompt_file']
    assert hashlib.sha256(ip.read_bytes()).hexdigest()==s['image_sha256']
    assert hashlib.sha256(pp.read_bytes()).hexdigest()==s['prompt_sha256']
    return {'images':np.fromfile(ip,dtype='<f4').reshape(1,3,640,640),'prompt_embeddings':np.fromfile(pp,dtype='<f4').reshape(1,32,512)}
for s in samples:references.append(runtime.forward(inputs(s),output_names=names))
del runtime,f;gc.collect()
runtime=ORTExecutor(q).to('cpu').create_session()
rows=[]
for s,refs in zip(samples,references):
    outputs=runtime.forward(inputs(s),output_names=names)
    for n in names:
        x=refs[n].astype(np.float64).ravel(); y=outputs[n].astype(np.float64).ravel()
        d=y-x
        rows.append({'image':s['image_tensor'],'tensor':n,'relative_l2':float(np.linalg.norm(d)/max(np.linalg.norm(x),1e-12)),'cosine':float(np.dot(x,y)/max(np.linalg.norm(x)*np.linalg.norm(y),1e-12)),'max_abs':float(np.abs(d).max())})
report={'diagnostic_only':True,'samples':len(samples),'rows':rows,'note':'CPU host simulation only, no production fallback or accuracy approval.'}
(a.output/'report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
