"""All36 original decoder layers via grouped BPU HBMs; CPU only copies I/O.

Candidate integration. Actual full-generation board quality/deployment pending.
The complete vocabulary BPU heads own the original final RMSNorm.
"""
from pathlib import Path
from dataclasses import dataclass
import json
import numpy as np
from locateanything_bpu_components_v2 import ComponentSpec
from locateanything_bpu_decoder_v1 import FullDecoder
from locateanything_bpu_generation_v1 import FullBpuGenerator,TOKEN_KEYS
from locateanything_bpu_vision_v1 import FullVision
from locateanything_bpu_vocabulary_v1 import BpuVocabulary
from locateanything_bpu_decoder_v1 import RopeTables

PROFILES={'decode':12,'prefill':256}

def prepare_group_arrays(hidden,caches,layout,length,rope):
    q,p=layout.query_length,layout.past_length
    assert length in PROFILES.values() and 0<q<=length and p+length<=512
    assert hidden.shape==(q,2048) and hidden.dtype==np.float32 and np.isfinite(hidden).all()
    assert len(caches)==9 and layout.visibility.shape==(q,p+q)
    padded=np.zeros((length,2048),np.float32);padded[:q]=hidden
    cos,sin=rope.padded(layout.positions,length)
    assert cos.shape==sin.shape==(1,length,128)
    mask=np.full((length,512),-32767.,np.float32)
    left=512-length-p
    mask[:q,left:left+p]=np.where(layout.visibility[:,:p],0.,-32767.)
    mask[:q,512-length:512-length+q]=np.where(layout.visibility[:,p:],0.,-32767.)
    # Discarded query rows may attend neutral column0; no valid query sees them.
    mask[q:,0]=0.
    keys=[];values=[]
    for pair in caches:
        if pair is None:
            assert p==0
            pair=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
        assert len(pair)==2
        prepared=[]
        for value in pair:
            assert value.shape==(2,p,128) and value.dtype==np.float32 and np.isfinite(value).all()
            array=np.zeros((2,512,128),np.float32)
            if p:array[:,512-p:]=value
            prepared.append(array)
        keys.append(prepared[0]);values.append(prepared[1])
    return [padded,np.ascontiguousarray(cos[0]),np.ascontiguousarray(sin[0]),mask,*keys,*values]


def commit_group_arrays(outputs,caches,layout,length):
    q,p=layout.query_length,layout.past_length;keep=layout.keep_cache_length-p
    assert len(outputs)==19 and outputs[0].shape==(length,2048)
    assert all(x.dtype==np.float32 and np.isfinite(x).all() for x in outputs)
    assert all(x.shape==(2,length,128) for x in outputs[1:])
    assert 0<keep<=q<=length and len(caches)==9
    result=[]
    for i,pair in enumerate(caches):
        if pair is None:
            assert p==0
            pair=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
        assert all(x.shape==(2,p,128) for x in pair)
        updated=tuple(np.concatenate([old,new[:,:keep]],axis=1) for old,new in zip(pair,[outputs[1+i],outputs[10+i]]))
        assert all(x.shape==(2,layout.keep_cache_length,128) for x in updated)
        result.append(updated)
    return outputs[0][:q].copy(),tuple(result)


class BpuDecoderGroup:
    def __init__(self,start,end,profiles):
        assert (start,end) in [(0,8),(9,17),(18,26),(27,35)] and set(profiles)==set(PROFILES)
        self.start=start;self.end=end;self.specs={}
        for profile,length in PROFILES.items():
            item=profiles[profile];root=Path(item['root']).resolve()
            assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
            assert (root/'model.hbm').is_file()
            source=json.loads((root/'status.json').read_text());ports=json.loads((root/'ports.json').read_text())
            assert source['status']=='compiled_bpu_only' and source['bpu_only']
            assert source['layer_indices']==list(range(start,end+1)) and source['sequence_capacity']==length
            assert source['final_norm_location']=='vocabulary_head' and not source['includes_final_norm']
            assert source['hbm_sha256']==item['hbm_sha256']
            assert source['nodes'] and all('bpu' in n['device'].lower() for n in source['nodes'])
            shapes=((length,2048),(length,128),(length,128),(length,512))+((2,512,128),)*18
            assert source['input_shapes']==[list(s) for s in shapes]
            assert [p['name'] for p in ports['inputs']]==['_input_'+str(i) for i in range(22)]
            assert [p['name'] for p in ports['outputs']]==['_output_'+str(i) for i in range(19)]
            self.specs[profile]=ComponentSpec(f'decoder-group-{start:02d}-{end:02d}-{profile}',root,item['hbm_sha256'],shapes,('float32',)*22)

    def forward(self,executor,hidden,caches,layout,profile,rope):
        assert profile in ['prefill','ar','mtp']
        selected='prefill' if profile=='prefill' else 'decode';length=PROFILES[selected]
        if selected=='prefill':assert layout.past_length==0
        values=prepare_group_arrays(hidden,caches,layout,length,rope)
        outputs=executor.run_ordered(self.specs[selected].key,values)
        return commit_group_arrays(outputs,caches,layout,length)


class GroupedFullDecoder(FullDecoder):
    def __init__(self,groups):
        assert len(groups)==4 and all(isinstance(g,BpuDecoderGroup) for g in groups)
        assert [i for g in groups for i in range(g.start,g.end+1)]==list(range(36))
        self.groups=tuple(groups);self.specs=tuple(s for g in groups for s in g.specs.values())
        assert len(self.specs)==8 and len({s.key for s in self.specs})==8
        self.layer_indices=tuple(range(36))

    def forward(self,executor,hidden,caches,layout,profile,rope):
        assert len(caches)==36
        updated=[]
        for group in self.groups:
            hidden,pairs=group.forward(executor,hidden,caches[group.start:group.end+1],layout,profile,rope)
            updated.extend(pairs)
        assert len(updated)==36
        return hidden,tuple(updated)


class GroupedFullBpuGenerator(FullBpuGenerator):
    def __init__(self,vision,decoder,vocabulary,rope,image_token_index,token_ids):
        assert isinstance(vision,FullVision) and len(vision.specs)==29
        assert isinstance(decoder,GroupedFullDecoder) and decoder.layer_indices==tuple(range(36))
        assert isinstance(vocabulary,BpuVocabulary) and len(vocabulary.specs)==76 and isinstance(rope,RopeTables)
        assert isinstance(image_token_index,int) and 0<=image_token_index<152681
        assert TOKEN_KEYS<=set(token_ids)
        assert all(isinstance(token_ids[k],int) and 0<=token_ids[k]<152681 for k in TOKEN_KEYS)
        assert token_ids['coord_end_token_id']-token_ids['coord_start_token_id']==1000
        self.vision=vision;self.decoder=decoder;self.vocabulary=vocabulary;self.rope=rope
        self.image_token_index=image_token_index;self.token_ids=dict(token_ids)
        self.specs=tuple(vision.specs)+tuple(decoder.specs)+tuple(vocabulary.specs)
        assert len(self.specs)==113 and len({s.key for s in self.specs})==113