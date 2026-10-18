"""AINVR complete36-layer BPU decoder composition and per-layer I/O routing.

Only masks, non-learned position lookup, padding and KV memory ownership run
on CPU. Every normalization/projection/rotary/attention/MLP stays in the HBM.
FullDecoder rejects missing layers/profiles instead of running a reduced model.
"""
from pathlib import Path
from dataclasses import dataclass
import json
import numpy as np
from locateanything_bpu_components_v2 import ComponentSpec,digest
from locateanything_generation_control_v1 import padded_attention

PROFILES={'ar':(1,512),'prefill':(256,1),'mtp':(12,512)}
PORT_ORDER=['hidden','cos','sin','past_k','past_v','mask','neutral']

class RopeTables:
    def __init__(self,root,expected_cos_sha256,expected_sin_sha256):
        root=Path(root).resolve();assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
        meta=json.loads((root/'status.json').read_text());assert meta['status']=='prepared_original_rope_tables' and meta['original_class_tables_bitwise_equal']
        assert meta['position_count']==1024 and meta['head_dimension']==128 and meta['theta']==1000000
        assert digest(root/'cos.npy')==meta['cos_sha256']==expected_cos_sha256
        assert digest(root/'sin.npy')==meta['sin_sha256']==expected_sin_sha256
        self.cos=np.load(root/'cos.npy');self.sin=np.load(root/'sin.npy')
        assert self.cos.shape==self.sin.shape==(1024,128) and self.cos.dtype==self.sin.dtype==np.float32
        assert np.isfinite(self.cos).all() and np.isfinite(self.sin).all()
        self.cos.setflags(write=False);self.sin.setflags(write=False)

    def padded(self,positions,length):
        positions=np.asarray(positions);assert positions.ndim==1 and np.issubdtype(positions.dtype,np.integer)
        assert 0<len(positions)<=length and positions.min()>=0 and positions.max()<1024
        cos=np.ones((1,length,128),np.float32);sin=np.zeros_like(cos)
        cos[0,:len(positions)]=self.cos[positions];sin[0,:len(positions)]=self.sin[positions]
        return cos,sin

@dataclass
class LayerOutput:
    hidden: np.ndarray
    cache: tuple
    kept_new_tokens: int

class BpuDecoderLayer:
    def __init__(self,index,profiles):
        assert 0<=index<36 and set(profiles)==set(PROFILES)
        self.index=index;self.specs={}
        for profile,(length,capacity) in PROFILES.items():
            item=profiles[profile];root=Path(item['root']).resolve();assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
            assert (root/'model.hbm').is_file(),'Required decoder HBM is missing'
            source=json.loads((root/'status.json').read_text());ports=json.loads((root/'ports.json').read_text())
            assert source['status']=='compiled_bpu_only' and source['bpu_only'] and source['layer']==index
            assert source['hbm_sha256']==item['hbm_sha256']
            assert [Path(x['file']).stem for x in ports['inputs']]==PORT_ORDER and len(ports['outputs'])==3
            shapes=((length,2048),(1,length,128),(1,length,128),(2,capacity,128),(2,capacity,128),(1,length,capacity+length),(1,))
            assert source['input_shapes']==[list(s) for s in shapes]
            self.specs[profile]=ComponentSpec(f'decoder-{index:02d}-{profile}',root,item['hbm_sha256'],shapes,('float32',)*7)

    def prepare_inputs(self,hidden,cache,layout,profile,rope):
        assert profile in self.specs;length,capacity=PROFILES[profile];q,p=layout.query_length,layout.past_length
        assert hidden.shape==(q,2048) and hidden.dtype==np.float32 and np.isfinite(hidden).all()
        assert 0<q<=length and 0<=p<=capacity and p<layout.keep_cache_length<=512
        if cache is None:
            assert p==0;cache=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
        assert len(cache)==2 and all(v.shape==(2,p,128) and v.dtype==np.float32 and np.isfinite(v).all() for v in cache)
        padded_hidden=np.zeros((length,2048),np.float32);padded_hidden[:q]=hidden
        cos,sin=rope.padded(layout.positions,length)
        past=[]
        for value in cache:
            array=np.zeros((2,capacity,128),np.float32);array[:,:p]=value;past.append(array)
        mask=padded_attention(layout,length,capacity)
        return [padded_hidden,cos,sin,*past,mask,np.zeros([1],np.float32)]

    def step(self,executor,hidden,cache,layout,profile,rope):
        values=self.prepare_inputs(hidden,cache,layout,profile,rope)
        outputs=executor.run_ordered(self.specs[profile].key,values);length,_=PROFILES[profile]
        assert len(outputs)==3 and outputs[0].shape==(length,2048)
        assert outputs[1].shape==outputs[2].shape==(2,length,128)
        assert all(x.dtype==np.float32 and np.isfinite(x).all() for x in outputs)
        q,p=layout.query_length,layout.past_length;keep=layout.keep_cache_length-p
        assert 0<keep<=q
        if cache is None:cache=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
        # Original generate retains KV only through the pre-sampling history;
        # speculative duplicate/mask tokens must never enter the accepted cache.
        new_cache=tuple(np.concatenate([old,new[:,:keep]],axis=1) for old,new in zip(cache,outputs[1:]))
        assert all(x.shape==(2,layout.keep_cache_length,128) for x in new_cache)
        return LayerOutput(outputs[0][:q].copy(),new_cache,keep)

class FullDecoder:
    def __init__(self,layers):
        assert len(layers)==36 and [x.index for x in layers]==list(range(36)),'Full original36-layer decoder required'
        assert all(set(x.specs)==set(PROFILES) for x in layers),'All AR/prefill/MTP profiles required'
        self.layers=tuple(layers);self.specs=tuple(s for layer in layers for s in layer.specs.values())
        assert len(self.specs)==108 and len({s.key for s in self.specs})==108

    def forward(self,executor,hidden,caches,layout,profile,rope):
        assert len(caches)==36
        next_caches=[]
        for layer,cache in zip(self.layers,caches):
            result=layer.step(executor,hidden,cache,layout,profile,rope)
            hidden=result.hidden;next_caches.append(result.cache)
        assert len(next_caches)==36
        return hidden,tuple(next_caches)
