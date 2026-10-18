"""Complete original27-block visual HBM composition; CPU only routes arrays.

This profile accepts original prepared224x448/16x32 patch-grid inputs. It does
not silently truncate images, replace missing stages or compute neural layers
on CPU. FullVision cannot be instantiated with an incomplete vision chain.
"""
from pathlib import Path
import json
import numpy as np
from locateanything_bpu_components_v2 import ComponentSpec

BUILDER_SHA256={
 'prefix':'10324bf871e1c5dedf705f186ffd292f8f9420c3ed426fe1e95fa39eb5775a3a',
 'block':'eca0b9b7362bca5df584a88acf47e59e81f8b8656b93287c69930bc589644e8e',
 'connector':'10324bf871e1c5dedf705f186ffd292f8f9420c3ed426fe1e95fa39eb5775a3a'}

class BpuVisionStage:
 def __init__(self,kind,root,hbm_sha256,index=None):
  assert kind in BUILDER_SHA256
  assert (kind=='block' and isinstance(index,int) and 0<=index<27) or (kind!='block' and index is None)
  root=Path(root).resolve();assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
  assert (root/'model.hbm').is_file(),'Missing required vision HBM'
  state=json.loads((root/'status.json').read_text());ports=json.loads((root/'ports.json').read_text())
  assert state['status']=='compiled_bpu_only' and state['bpu_only'] and state['cpu_fallback_count']==0
  assert state['source_sha256']==BUILDER_SHA256[kind] and state['hbm_sha256']==hbm_sha256
  assert state['per_operation_bf16_rounding'] is False
  assert state['nodes'] and all('bpu' in node['device'].lower() for node in state['nodes'])
  if kind=='block':assert state['stage']==index
  else:assert state['kind']==kind and state['final_feature_bf16_format']==(kind=='connector')
  assert len(ports['inputs'])==2 and len(ports['outputs'])==1
  assert [p['file'] for p in ports['inputs']]==['input.npy','neutral.npy']
  self.kind=kind;self.index=index
  self.input_shape=(512,3,14,14) if kind=='prefix' else (512,1152)
  self.output_shape=(128,2048) if kind=='connector' else (512,1152)
  assert state['input_shapes']==[list(self.input_shape),[1]]
  key='vision-'+kind+(('-'+str(index).zfill(2)) if kind=='block' else '')
  self.spec=ComponentSpec(key,root,hbm_sha256,(self.input_shape,(1,)),('float32','float32'))

 def forward(self,executor,value):
  assert isinstance(value,np.ndarray) and value.shape==self.input_shape and value.dtype==np.float32
  assert value.flags.c_contiguous and np.isfinite(value).all()
  outputs=executor.run_ordered(self.spec.key,[value,np.zeros([1],np.float32)])
  assert len(outputs)==1 and outputs[0].shape==self.output_shape and outputs[0].dtype==np.float32 and np.isfinite(outputs[0]).all()
  return outputs[0]

class FullVision:
 def __init__(self,prefix,blocks,connector):
  assert prefix.kind=='prefix' and connector.kind=='connector'
  assert len(blocks)==27 and [b.index for b in blocks]==list(range(27)),'All27 original MoonViT blocks required'
  assert all(b.kind=='block' for b in blocks)
  self.stages=(prefix,*blocks,connector);self.specs=tuple(stage.spec for stage in self.stages)
  assert len(self.specs)==29 and len({spec.key for spec in self.specs})==29

 def forward(self,executor,pixels,grid_hws):
  assert isinstance(grid_hws,np.ndarray) and np.issubdtype(grid_hws.dtype,np.integer)
  assert grid_hws.shape==(1,2) and grid_hws.tolist()==[[16,32]],'Unsupported image grid;use the declared model profile'
  value=pixels
  for stage in self.stages:value=stage.forward(executor,value)
  assert value.shape==(128,2048)
  return value
