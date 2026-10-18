"""Complete original architecture composition for the official Q8 shared-program family.

Control and array routing only. Construction requires all27vision/all36decoder
and the full152681-token vocabulary. Artifact/proof admission belongs to its
separate checked contract loader;this source alone is not a release proof.
"""
import numpy as np
from locateanything_official_program_executor_v1 import ProgramSpec
from locateanything_official_group_routing_v1 import prepare_official_group_arrays,commit_official_group_arrays,OfficialRopeArrays
from locateanything_bpu_vision_v1 import FullVision,BpuVisionStage
from locateanything_bpu_vocabulary_v1 import BpuVocabulary
from locateanything_bpu_generation_v1 import FullBpuGenerator,TOKEN_KEYS
GROUPS=((0,8),(9,17),(18,26),(27,35))

class LegacyVisionProxy:
 def __init__(self,stage,spec):
  assert isinstance(stage,BpuVisionStage) and stage.kind in ['prefix','connector'] and isinstance(spec,ProgramSpec) and spec.key==stage.spec.key
  assert spec.input_shapes==stage.spec.input_shapes and spec.input_dtypes==stage.spec.input_dtypes
  self.kind=stage.kind;self.index=None;self.spec=spec;self.stage=stage
 def forward(self,executor,value):return self.stage.forward(executor,value)

class OfficialVisionBlock:
 def __init__(self,index,spec):
  assert type(index) is int and 0<=index<27 and isinstance(spec,ProgramSpec)
  assert spec.input_shapes==spec.output_shapes==((512,1152),) and spec.input_dtypes==spec.output_dtypes==('float32',)
  self.kind='block';self.index=index;self.spec=spec
 def forward(self,executor,value):
  assert value.shape==(512,1152) and value.dtype==np.float32 and value.flags.c_contiguous and np.isfinite(value).all()
  out=executor.run_ordered(self.spec.key,[value]);assert len(out)==1 and out[0].shape==(512,1152);return out[0]

class OfficialDecoderGroup:
 def __init__(self,start,end,profiles):
  assert (start,end) in GROUPS and set(profiles)=={'ar','prefill'}
  self.start=start;self.end=end;self.specs=dict(profiles)
  for name,length in [('ar',1),('prefill',256)]:
   s=profiles[name];assert isinstance(s,ProgramSpec)
   assert s.input_shapes==((length,2048),(length,128),(length,128),(length,512))+((2,512,128),)*18
   assert s.output_shapes==((length,2048),)+((2,length,128),)*18 and s.input_dtypes==('float32',)*22 and s.output_dtypes==('float32',)*19
  assert profiles['ar'].path==profiles['prefill'].path and profiles['ar'].hbm_sha256==profiles['prefill'].hbm_sha256,'Profiles must share their verified physical HBM'
 def forward(self,executor,hidden,caches,layout,profile,rope):
  assert profile in self.specs
  if profile=='prefill':assert layout.past_length==0
  length=1 if profile=='ar' else 256;inputs=prepare_official_group_arrays(hidden,caches,layout,length,rope);outputs=executor.run_ordered(self.specs[profile].key,inputs)
  return commit_official_group_arrays(outputs,caches,layout,length)

class OfficialFullDecoder:
 def __init__(self,groups):
  assert len(groups)==4 and all(isinstance(g,OfficialDecoderGroup) for g in groups) and [(g.start,g.end) for g in groups]==list(GROUPS)
  self.groups=tuple(groups);self.specs=tuple(s for g in groups for s in g.specs.values());self.layer_indices=tuple(range(36));self.compiled_profiles=frozenset(['ar','prefill']);self.profile_sequence_capacities={'ar':1,'prefill':256}
 def forward(self,executor,hidden,caches,layout,profile,rope):
  assert len(caches)==36 and profile in self.compiled_profiles;updated=[]
  for group in self.groups:
   hidden,new=group.forward(executor,hidden,caches[group.start:group.end+1],layout,profile,rope);updated.extend(new)
  assert len(updated)==36;return hidden,tuple(updated)

class OfficialVocabulary(BpuVocabulary):
 def __init__(self,embedding_specs,head_spec):
  assert len(embedding_specs)==38 and isinstance(head_spec,ProgramSpec);self.head=head_spec;self.tables={'embedding':[]};self.specs=[];start=0
  for i,spec in enumerate(embedding_specs):
   assert isinstance(spec,ProgramSpec) and spec.input_shapes==((1,),) and spec.input_dtypes==('int32',) and spec.output_shapes==((1,2048),) and spec.output_dtypes==('float32',)
   count=min(4096,152681-start);assert count>0;self.tables['embedding'].append(dict(key=spec.key,start=start,count=count));start+=count;self.specs.append(spec)
  assert start==152681 and head_spec.input_shapes==((1,2048),) and head_spec.output_shapes==((1,152681),(1,152681)) and head_spec.input_dtypes==('float32',) and head_spec.output_dtypes==('float32','float32');self.specs=tuple(self.specs+[head_spec])
 def project(self,executor,hidden_rows,return_raw=False):
  x=np.asarray(hidden_rows);assert x.ndim==2 and x.shape[1]==2048 and x.dtype==np.float32 and np.isfinite(x).all();formatted=[];raw=[]
  for i in range(len(x)):
   result=executor.run_ordered(self.head.key,[np.ascontiguousarray(x[i:i+1])]);assert len(result)==2;formatted.append(result[0]);raw.append(result[1])
  result=np.concatenate(formatted,axis=0);return (result,np.concatenate(raw,axis=0)) if return_raw else result

class OfficialFullBpuGenerator(FullBpuGenerator):
 def __init__(self,vision,decoder,vocabulary,rope,image_token_index,token_ids):
  assert isinstance(vision,FullVision) and len(vision.specs)==29 and isinstance(decoder,OfficialFullDecoder) and decoder.layer_indices==tuple(range(36))
  assert isinstance(vocabulary,OfficialVocabulary) and len(vocabulary.specs)==39 and isinstance(rope,OfficialRopeArrays)
  assert type(image_token_index) is int and 0<=image_token_index<152681 and TOKEN_KEYS<=set(token_ids) and all(type(token_ids[k]) is int and 0<=token_ids[k]<152681 for k in TOKEN_KEYS) and token_ids['coord_end_token_id']-token_ids['coord_start_token_id']==1000
  self.vision=vision;self.decoder=decoder;self.vocabulary=vocabulary;self.rope=rope;self.image_token_index=image_token_index;self.token_ids=dict(token_ids);self.enabled_modes=frozenset(['slow']);self.specs=tuple(vision.specs)+tuple(decoder.specs)+tuple(vocabulary.specs)
  assert len(self.specs)==76 and len({s.key for s in self.specs})==76 and all(isinstance(s,ProgramSpec) for s in self.specs)
 def generate(self,*args,mode='slow',**kwargs):
  if mode not in self.enabled_modes:raise ValueError('This original36-layer family has no compiled MTP profile')
  return super().generate(*args,mode=mode,**kwargs)
