import json,time,hashlib,traceback
from pathlib import Path
import numpy as np
from hbdk4.compiler import load
r=Path('/opt/locate-oellm-research-v1/original-decoder-stack-36-v6');f=r/'native-reference-v1';out={'status':'running','scope':'complete36 decoder+final norm compiler simulator versus original BF16 CPU SDPA component reference; old activation, no image/connector/vocabulary/generation','board_calls':0,'started':time.time(),'full_model_quality':False}
def save():(r/'native-simulator-saved-v1.json').write_text(json.dumps(out,indent=2))
save()
try:
 source=json.loads((r/'savedcompile-v1.json').read_text());ref=json.loads((f/'status.json').read_text());assert source['status']=='completed' and source['layer_count']==36 and source['original_final_norm_included'];assert set(source['devices'])=={'DEVICE_CATEGORY_BPU'};assert ref['status']=='reference_prepared' and ref['layers']==36 and ref['inputs']==76 and ref['outputs']==73
 digest=hashlib.sha256()
 with (r/source['hbm_file']).open('rb') as handle:
  for chunk in iter(lambda:handle.read(4*1024**2),b''):digest.update(chunk)
 assert digest.hexdigest()==source['hbm_sha256']
 inputs=[np.load(f/('input-'+str(i)+'.npy')) for i in range(76)];actual=load(str(r/'stack-converted.bc')).functions[0](*inputs);assert len(actual)==73
 out['outputs']=[]
 for i,x in enumerate(actual):
  x=np.asarray(x);y=np.load(f/('native-output-'+str(i)+'.npy'));assert x.shape==y.shape,(i,x.shape,y.shape);np.save(f/('compiler-output-'+str(i)+'.npy'),x);diff=x.reshape(-1).astype(np.float64)-y.reshape(-1).astype(np.float64);out['outputs'].append({'index':i,'shape':list(x.shape),'maxabs':float(abs(diff).max()),'relative_l2':float(np.linalg.norm(diff)/(np.linalg.norm(y)+1e-20)),'finite':bool(np.isfinite(x).all())})
 ports={'inputs':[{'name':'_input_'+str(i),'file':'native-reference-v1/input-'+str(i)+'.npy'} for i in range(76)],'outputs':[{'name':'_output_'+str(i),'file':'native-reference-v1/compiler-output-'+str(i)+'.npy','fp32_file':'native-reference-v1/native-output-'+str(i)+'.npy'} for i in range(73)],'reference_type':'original BF16 CPU SDPA component; legacy fp32_file port key does not imply FP32 oracle'};(r/'ports.json').write_text(json.dumps(ports,indent=2))
 out.update(status='completed',hbm_sha256=source['hbm_sha256'],all_outputs_finite=all(x['finite'] for x in out['outputs']))
except BaseException:out.update(status='failed',error=traceback.format_exc())
out['finished']=time.time();save();print(json.dumps(out,indent=2))
