"""Full original HBM generation composition; no neural CPU/CUDA fallback.

Requires complete29-stage vision,108 decoder profiles and76 vocabulary HBMs.
Only token grammar, masks, array placement and sampling run on CPU. The module
must still pass complete-model actual-board tests before trial installation.
"""
import time
import numpy as np
from locateanything_bpu_vision_v1 import FullVision
from locateanything_bpu_decoder_v1 import FullDecoder,RopeTables
from locateanything_bpu_vocabulary_v1 import BpuVocabulary
from locateanything_generation_control_v1 import GenerationState
from locateanything_sampling_v1 import select_tokens

TOKEN_KEYS={'null_token_id','im_end_token_id','box_start_token_id',
 'box_end_token_id','coord_start_token_id','coord_end_token_id',
 'none_token_id','ref_start_token_id','ref_end_token_id','default_mask_token_id'}

def place_image_features(query_ids,language_embeddings,image_features,image_token_index):
 """Original indexed image-token assignment, using BPU-produced arrays only.

Unused text embeddings for image placeholders need not be computed: native
forward overwrites every such row before any decoder neural operation.
 """
 query_ids=np.asarray(query_ids)
 assert query_ids.ndim==1 and np.issubdtype(query_ids.dtype,np.integer)
 selected=query_ids==image_token_index
 assert int(selected.sum())==128,'Exactly128 image placeholders required by this image profile'
 assert image_features.shape==(128,2048) and image_features.dtype==np.float32
 assert language_embeddings.shape==(int((~selected).sum()),2048) and language_embeddings.dtype==np.float32
 assert np.isfinite(image_features).all() and np.isfinite(language_embeddings).all()
 output=np.empty((len(query_ids),2048),np.float32)
 output[selected]=image_features;output[~selected]=language_embeddings
 return output

class FullBpuGenerator:
 def __init__(self,vision,decoder,vocabulary,rope,image_token_index,token_ids):
  assert isinstance(vision,FullVision) and isinstance(decoder,FullDecoder)
  assert isinstance(vocabulary,BpuVocabulary) and isinstance(rope,RopeTables)
  assert isinstance(image_token_index,int) and 0<=image_token_index<152681
  assert TOKEN_KEYS<=set(token_ids)
  assert all(isinstance(token_ids[key],int) and 0<=token_ids[key]<152681 for key in TOKEN_KEYS)
  assert token_ids['coord_end_token_id']-token_ids['coord_start_token_id']==1000
  self.vision=vision;self.decoder=decoder;self.vocabulary=vocabulary;self.rope=rope
  self.image_token_index=image_token_index;self.token_ids=dict(token_ids)
  self.specs=tuple(vision.specs)+tuple(decoder.specs)+tuple(vocabulary.specs)
  assert len(self.specs)==213 and len({spec.key for spec in self.specs})==213,'All original neural components are mandatory'

 def generate(self,executor,pixels,grid_hws,input_ids,*,mode='hybrid',
              max_new_tokens=128,model_max_length=32768,temperature=0.,
              repetition_penalty=1.,top_p=None,top_k=None,
              keep_k_avg=4,maximum_seconds=None,cancelled=None):
  assert temperature==0.,'Only validated original greedy decoding is enabled'
  assert mode in ['slow','hybrid','fast']
  assert set(spec.key for spec in self.specs)<=set(executor.specs)
  assert isinstance(input_ids,np.ndarray) and input_ids.ndim==1 and np.issubdtype(input_ids.dtype,np.integer)
  assert len(input_ids)>0 and np.all(input_ids>=0) and np.all(input_ids<152681)
  assert int(np.count_nonzero(input_ids==self.image_token_index))==128
  assert max_new_tokens>0 and model_max_length>len(input_ids)
  assert maximum_seconds is None or maximum_seconds>0
  initial_queries=len(input_ids)+(6 if mode!='slow' else 0)
  assert initial_queries<=256,'Prompt exceeds compiled prefill profile;no silent truncation'
  started=time.perf_counter();traces=[];logprobs=[];first_token_seconds=None
  calls_before=executor.stats['calls'];loads_before=executor.stats['loads']
  def check_request():
   if cancelled is not None and cancelled():raise RuntimeError('Inference request cancelled')
   if maximum_seconds is not None and time.perf_counter()-started>maximum_seconds:raise TimeoutError('Inference request exceeded its explicit bound')
  check_request();features=self.vision.forward(executor,pixels,grid_hws)
  vision_seconds=time.perf_counter()-started
  state=GenerationState(input_ids,self.token_ids,mode,max_new_tokens,model_max_length)
  caches=(None,)*36
  while not state.finished:
   check_request();request=state.prepare()
   if request is None:break
   query=request['token_ids'];layout=request['layout'];step_started=time.perf_counter()
   if not traces:
    selection=query!=self.image_token_index
    text=self.vocabulary.embed(executor,query[selection])
    hidden=place_image_features(query,text,features,self.image_token_index)
   else:hidden=self.vocabulary.embed(executor,query)
   check_request()
   hidden,next_caches=self.decoder.forward(executor,hidden,caches,layout,request['profile'],self.rope)
   assert len(next_caches)==36 and all(len(pair)==2 and pair[0].shape==pair[1].shape==(2,layout.keep_cache_length,128) for pair in next_caches)
   check_request();needed=hidden[-6:] if layout.mtp else hidden[-1:]
   logits=self.vocabulary.project(executor,np.ascontiguousarray(needed))
   selected=select_tokens(logits,state.history,self.token_ids,mode=mode,mtp=layout.mtp,
       temperature=temperature,repetition_penalty=repetition_penalty,top_p=top_p,top_k=top_k,keep_k_avg=keep_k_avg)
   accepted=selected['tokens'];kind=selected['pattern']['type']
   # KV is committed only through history length BEFORE accepting speculative
   # tokens. Every layer's six dummy future slots are already excluded.
   state.accept(accepted,kind);caches=next_caches
   logprobs.extend(float(v) if np.isfinite(v) else None for v in selected['chosen_logprobs'])
   traces.append(dict(profile=request['profile'],mtp=layout.mtp,query_length=layout.query_length,
       past_length=layout.past_length,kept_cache_length=layout.keep_cache_length,
       accepted_tokens=accepted.tolist(),pattern=kind,seconds=time.perf_counter()-step_started,
       topk_ties=selected['topk_ties']))
   if first_token_seconds is None:first_token_seconds=time.perf_counter()-started
  generated=state.history[state.prompt_length:]
  assert len(generated)==len(logprobs) and traces
  # Consumers convert this explicit integer vector to JSON after generation.
  # Keep one token-array contract for both actual validation and the service.
  return dict(generated_ids=np.asarray(generated,dtype=np.int64),token_logprobs=logprobs,steps=traces,
      terminal=traces[-1]['pattern']=='im_end',stopped_at_token_limit=traces[-1]['pattern']!='im_end',
      generation_mode=mode,vision_seconds=vision_seconds,first_token_seconds=first_token_seconds,
      total_seconds=time.perf_counter()-started,bpu_calls=executor.stats['calls']-calls_before,
      model_loads=executor.stats['loads']-loads_before,neural_cpu_fallback=False,
      limits=dict(image_profile=[224,448],patch_grid=[16,32],prefill=256,kv_capacity=512,greedy_temperature=0.))
