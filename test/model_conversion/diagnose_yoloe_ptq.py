"""Host-only HMCT PTQ diagnostic; never a deployment or accuracy approval."""
import argparse, hashlib, json, time
from pathlib import Path
import numpy as np
from hmct.executor import ORTExecutor
p=argparse.ArgumentParser()
for name in ('model','prepared','images','reference','board','output'):p.add_argument('--'+name,type=Path,required=True)
p.add_argument('--device',choices=['cuda','cpu'],default='cuda')
a=p.parse_args()
assert not a.output.exists()
a.output.mkdir()
manifest=json.loads((a.prepared/'manifest.json').read_text())
rows=[x for x in manifest['samples'] if x['split']=='validation'][:8]
runtime=ORTExecutor(str(a.model)).to(a.device).create_session()
report={'diagnostic_only':True,'host_simulation_device':a.device,'model_sha256':hashlib.sha256(a.model.read_bytes()).hexdigest(),'rows':[]}
for item in rows:
    key=Path(item['image_tensor']).stem
    ip=a.images/item['image_tensor']; pp=a.prepared/item['prompt_file']
    assert hashlib.sha256(ip.read_bytes()).hexdigest()==item['image_sha256']
    assert hashlib.sha256(pp.read_bytes()).hexdigest()==item['prompt_sha256']
    ins={'images':np.fromfile(ip,dtype='<f4').reshape(1,3,640,640),'prompt_embeddings':np.fromfile(pp,dtype='<f4').reshape(1,32,512)}
    t=time.monotonic(); out=next(iter(runtime.forward(ins).values()))
    assert out.shape==(1,36,8400) and np.isfinite(out).all()
    np.savez_compressed(a.output/(key+'.npz'),output=out)
    ref=np.load(a.reference/(key+'.npz'))['output']
    board=np.load(a.board/(key+'.npz'))['output']
    active=item['active_count']; mask=ref[:,4:4+active]>.1
    row={'id':key,'seconds':time.monotonic()-t}
    for name,other in [('fp32',ref),('bpu',board)]:
        delta=out[:,4:4+active]-other[:,4:4+active]
        row[name]={'max_abs':float(np.abs(delta).max()),'near_objects_mae':float(np.abs(delta[mask]).mean()),'near_objects_bias':float(delta[mask].mean())}
    report['rows'].append(row)
    (a.output/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(row),flush=True)
report['completed']=True
(a.output/'report.json').write_text(json.dumps(report,indent=2))
