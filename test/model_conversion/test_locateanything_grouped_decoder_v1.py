"""Control-only grouped layout/cache tests: no HBM is loaded or executed."""
from pathlib import Path
import hashlib,json,types
import numpy as np
from locateanything_generation_control_v1 import step_layout
from locateanything_bpu_grouped_decoder_v1 import prepare_group_arrays,commit_group_arrays,GroupedFullDecoder,BpuDecoderGroup
ROOT=Path('/home/sunrise/ainvr');checks=[]
def check(name,value):assert value,name;checks.append(name)
class Rope:
 def padded(self,positions,length):
  cos=np.ones((1,length,128),np.float32);sin=np.zeros_like(cos)
  cos[0,:len(positions)]=np.asarray(positions,np.float32)[:,None];sin[0,:len(positions)]=-np.asarray(positions,np.float32)[:,None]
  return cos,sin
rope=Rope()
for history,past,mtp,length,label in [(156,155,False,12,'ar1'),(158,155,True,12,'mtp9'),(161,155,True,12,'mtp12'),(155,0,False,256,'prefill155')]:
 layout=step_layout(history,past,mtp);q=layout.query_length
 hidden=np.arange(q*2048,dtype=np.float32).reshape(q,2048)
 caches=[]
 for i in range(9):
  caches.append(tuple(np.broadcast_to(np.arange(past,dtype=np.float32)[None,:,None]+i*1000+j*100,(2,past,128)).copy() for j in range(2)))
 arrays=prepare_group_arrays(hidden,tuple(caches),layout,length,rope)
 check(label+' port order and shapes',len(arrays)==22 and arrays[0].shape==(length,2048) and arrays[3].shape==(length,512))
 check(label+' query and positions preserved',np.array_equal(arrays[0][:q],hidden) and np.array_equal(arrays[1][:q,0],layout.positions.astype(np.float32)))
 left=512-length-past
 check(label+' native visibility preserved',np.array_equal(arrays[3][:q,left:left+past]==0,layout.visibility[:,:past]) and np.array_equal(arrays[3][:q,512-length:512-length+q]==0,layout.visibility[:,past:]))
 if left:check(label+' left padding blocked',np.all(arrays[3][:q,:left]<0))
 if q<length:check(label+' padded keys blocked',np.all(arrays[3][:q,512-length+q:]<0))
 for i in range(9):
  for j in range(2):
   port=4+i+j*9
   assert np.array_equal(arrays[port][:,512-past:] if past else arrays[port][:,:0],caches[i][j])
   assert np.all(arrays[port][:,:512-past]==0)
 check(label+' all9 KV inputs ordered/right-aligned',True)
 outputs=[np.full((length,2048),7.,np.float32)]
 outputs += [np.broadcast_to(np.arange(length,dtype=np.float32)[None,:,None]+i*100+1000,(2,length,128)).copy() for i in range(9)]
 outputs += [np.broadcast_to(np.arange(length,dtype=np.float32)[None,:,None]+i*100+10000,(2,length,128)).copy() for i in range(9)]
 result,updated=commit_group_arrays(outputs,tuple(caches),layout,length);keep=history-past
 check(label+' only committed prefix retained',len(updated)==9 and all(x.shape==(2,history,128) for pair in updated for x in pair))
 for i in range(9):
  for j in range(2):
   assert np.array_equal(updated[i][j][:,:past],caches[i][j])
   assert np.array_equal(updated[i][j][:,past:],outputs[1+i+j*9][:,:keep])
 check(label+' all9 KV outputs ordered',True)
 before=result.copy();saved=updated[0][0].copy();outputs[0].fill(-9);outputs[1].fill(-10)
 check(label+' copied buffers survive reuse',np.array_equal(result,before) and np.array_equal(updated[0][0],saved))
try:GroupedFullDecoder([])
except AssertionError:check('missing groups rejected',True)
else:raise AssertionError('Incomplete group list accepted')
groups=[]
for start in [0,9,18,27]:
 group=object.__new__(BpuDecoderGroup);group.start=start;group.end=start+8
 group.specs={p:types.SimpleNamespace(key=f'unit-group-{start}-{p}') for p in ['decode','prefill']};groups.append(group)
decoder=GroupedFullDecoder(groups);check('all36 covered once',decoder.layer_indices==tuple(range(36)) and len(decoder.specs)==8)
class Executor:
 def __init__(self):self.keys=[]
 def run_ordered(self,key,values):
  self.keys.append(key);length=len(values[0]);start=int(key.split('-')[2])
  return [values[0]+1]+[np.full((2,length,128),start+i,np.float32) for i in range(9)]+[np.full((2,length,128),100+start+i,np.float32) for i in range(9)]
executor=Executor();layout=step_layout(1,0,False);hidden=np.zeros((1,2048),np.float32)
result,caches=decoder.forward(executor,hidden,(None,)*36,layout,'ar',rope)
check('four groups dispatched in order',executor.keys==[f'unit-group-{i}-decode' for i in [0,9,18,27]])
check('hidden propagated across all groups',np.all(result==4))
check('global layer KV slots preserved',len(caches)==36 and all(np.all(k==i) and np.all(v==100+i) for i,(k,v) in enumerate(caches)))
try:prepare_group_arrays(np.zeros((1,2048),np.float32),(None,)*9,step_layout(502,501,False),12,rope)
except AssertionError:check('cache overflow fails closed',True)
else:raise AssertionError('Overflow accepted')
report={'status':'passed','scope':'array/control dispatch only; fake executor and no real HBM model','actual_bpu_calls':0,'checks':checks,'source_sha256':hashlib.sha256((ROOT/'test/model_conversion/locateanything_bpu_grouped_decoder_v1.py').read_bytes()).hexdigest(),'production_code_or_configuration_changed':False,'whole_model_quality_verified':False}
p=ROOT/'test/results/locateanything-grouped-decoder-controls-v1.json';assert not p.exists();p.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))