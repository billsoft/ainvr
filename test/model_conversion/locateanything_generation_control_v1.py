"""AINVR control-only generation/layout for original LocateAnything semantics.

No neural matrix, normalization, activation, embedding or head runs here.
The BPU runner supplies logits and hidden/KV arrays. Capacity violations fail
closed; they never silently shorten the prompt, cache or generated answer.
"""
from dataclasses import dataclass
import numpy as np

@dataclass(frozen=True)
class StepLayout:
    positions: np.ndarray
    visibility: np.ndarray
    query_length: int
    past_length: int
    keep_cache_length: int
    mtp: bool

def step_layout(history_length, past_length, mtp, future_tokens=6, causal_attn=False):
    assert 0<=past_length<history_length and future_tokens==6
    total=history_length+(future_tokens if mtp else 0)
    qlen=total-past_length
    positions=np.arange(past_length,total,dtype=np.int64)
    if mtp:positions[-future_tokens:]-=1
    row=np.arange(past_length,total)[:,None];column=np.arange(total)[None,:]
    visible=column<=row
    if mtp:
        if not causal_attn:visible[-future_tokens:,-future_tokens:]=True
        visible[-future_tokens:,-future_tokens-1]=False
    return StepLayout(positions,visible,qlen,past_length,history_length,bool(mtp))

def padded_attention(layout, sequence_size, past_capacity):
    assert layout.query_length<=sequence_size and layout.past_length<=past_capacity
    # Dummy/padded cache columns stay blocked for real queries. Match the
    # compiler's harmless column0 visibility for discarded padded query rows.
    mask=np.full((1,sequence_size,past_capacity+sequence_size),-1024.,np.float32)
    q,p=layout.query_length,layout.past_length
    mask[0,q:,0]=0.
    real=np.where(layout.visibility,0.,-1024.).astype(np.float32)
    mask[0,:q,:p]=real[:,:p]
    mask[0,:q,past_capacity:past_capacity+q]=real[:,p:]
    return mask

def handle_pattern(tokens, ids, generation_mode='hybrid'):
    """Original token grammar, including four-coordinate boxes and points."""
    assert generation_mode in ['fast','hybrid','slow']
    x=[int(t) for t in tokens];assert len(x)>=6
    null,eos=ids['null_token_id'],ids['im_end_token_id']
    start,end=ids['box_start_token_id'],ids['box_end_token_id']
    lo,hi=ids['coord_start_token_id'],ids['coord_end_token_id']
    if x[0] in [null,eos]:return dict(type='im_end',tokens=[eos],need_switch_to_ar=False,is_terminal=True)
    if x[:2]==[start,ids['none_token_id']]:return dict(type='empty_box',tokens=[start,ids['none_token_id'],end],need_switch_to_ar=False,is_terminal=False)
    if x[0]==start:
        coordinate_end=1
        for value in x[1:5]:
            if lo<=value<=hi:coordinate_end+=1
            else:break
        if coordinate_end==5 and x[5]==end:kind,accepted='coord_box',x
        elif coordinate_end==3 and x[3]==end:kind,accepted='point_box',x[:4]
        elif generation_mode=='fast':kind,accepted='coord_box',x
        else:return dict(type='error_box',tokens=x[:coordinate_end],need_switch_to_ar=True,is_terminal=False)
        return dict(type=kind,tokens=accepted,need_switch_to_ar=False,is_terminal=False)
    if null in x:x=x[:x.index(null)]
    if len(x)>=2 and x[-1]==x[-2]==ids['ref_end_token_id']:x=x[:-1]
    return dict(type='ref_object',tokens=x,need_switch_to_ar=False,is_terminal=False)

def ar_token_type(token,ids,generation_mode):
    if generation_mode=='hybrid':
        if token==ids['box_end_token_id']:return 'box_end_ar'
        if ids['coord_start_token_id']<=token<=ids['coord_end_token_id'] or token==ids['none_token_id']:return 'coord_ar'
        return 'im_end'
    return 'im_end' if token==ids['im_end_token_id'] else 'continue_ar'

class GenerationState:
    def __init__(self,prompt,ids,mode='hybrid',max_new_tokens=128,model_max_length=32768):
        assert mode in ['slow','hybrid','fast'] and max_new_tokens>0
        self.history=[int(x) for x in prompt];assert self.history
        self.prompt_length=len(self.history);self.ids=ids;self.mode=mode
        self.total_limit=min(model_max_length,len(self.history)+max_new_tokens)
        self.mtp=mode in ['hybrid','fast'];self.past_length=0;self.finished=False;self._pending=None

    def prepare(self):
        assert not self.finished and self._pending is None
        if len(self.history)>=self.total_limit:self.finished=True;return None
        layout=step_layout(len(self.history),self.past_length,self.mtp)
        assert layout.keep_cache_length<=512,'Current compiled KV capacity is512; no silent cache truncation'
        query=self.history[self.past_length:]
        if self.mtp:query=query+[self.history[-1]]+[self.ids['default_mask_token_id']]*5
        profile='prefill' if self.past_length==0 else ('ar' if layout.query_length==1 else 'mtp')
        length=256 if profile=='prefill' else (1 if profile=='ar' else 12)
        capacity=1 if profile=='prefill' else 512
        assert layout.query_length<=length,'Prompt/step exceeds compiled query profile; no silent token truncation'
        self._pending=layout
        return dict(token_ids=np.asarray(query,np.int64),layout=layout,profile=profile,sequence_size=length,past_capacity=capacity,mask=padded_attention(layout,length,capacity))

    def accept(self,tokens,kind):
        assert self._pending is not None
        accepted=[int(t) for t in tokens];assert accepted,'Original generation must make token progress'
        self.past_length=self._pending.keep_cache_length;self._pending=None
        self.history.extend(accepted)
        if kind=='im_end':self.finished=True
        if self.mode=='hybrid':
            if kind=='error_box':self.mtp=False
            elif kind=='box_end_ar':self.mtp=True
        # Native generate accepts a complete MTP pattern before the next length
        # check, even when it crosses max_new_tokens. Preserve that behavior.
        if len(self.history)>=self.total_limit:self.finished=True
