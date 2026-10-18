"""Compact original decoder groups with declared AR1/MTP12/causal prefill profiles.

Only array placement/cache ownership runs on CPU. Neural execution remains the
unchanged ComponentExecutor and inherited original generation/sampling code.
Frozen old grouped/vision/vocabulary implementations are not modified.
"""
from pathlib import Path
import json
import numpy as np
from locateanything_compact_compiler_origin_v1 import verify_compiler_origin
from locateanything_compact_prefill_chunks_v1 import profile_capacities,forward_causal_prefill_chunks
from locateanything_bpu_components_v2 import ComponentSpec,digest
from locateanything_bpu_decoder_v1 import RopeTables
from locateanything_bpu_generation_v1 import TOKEN_KEYS
from locateanything_bpu_grouped_decoder_v1 import BpuDecoderGroup,GroupedFullDecoder,GroupedFullBpuGenerator
from locateanything_bpu_vision_v1 import FullVision
from locateanything_bpu_vocabulary_v1 import BpuVocabulary

CAPACITIES={'ar':1,'mtp':12,'prefill':256}
GROUPS=((0,8),(9,17),(18,26),(27,35))
BUILDER_SHA='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
LINEARS={'self_attn.q_proj','self_attn.k_proj','self_attn.v_proj','self_attn.o_proj','mlp.gate_proj','mlp.up_proj','mlp.down_proj'}


def prepare_compact_group_arrays(hidden,caches,layout,length,rope):
    q,p=layout.query_length,layout.past_length
    assert length in CAPACITIES.values() and 0<q<=length and p+length<=512
    assert hidden.shape==(q,2048) and hidden.dtype==np.float32 and np.isfinite(hidden).all()
    assert 1<=len(caches)<=9 and layout.visibility.shape==(q,p+q)
    padded=np.zeros((length,2048),np.float32);padded[:q]=hidden
    cos,sin=rope.padded(layout.positions,length)
    assert cos.shape==sin.shape==(1,length,128)
    assert cos.dtype==sin.dtype==np.float32 and np.isfinite(cos).all() and np.isfinite(sin).all()
    mask=np.full((length,512),-32767.,np.float32);left=512-length-p
    mask[:q,left:left+p]=np.where(layout.visibility[:,:p],0.,-32767.)
    mask[:q,512-length:512-length+q]=np.where(layout.visibility[:,p:],0.,-32767.)
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


def commit_compact_group_arrays(outputs,caches,layout,length):
    q,p=layout.query_length,layout.past_length;keep=layout.keep_cache_length-p;count=len(caches)
    assert 1<=count<=9 and len(outputs)==1+2*count and outputs[0].shape==(length,2048)
    assert all(x.dtype==np.float32 and np.isfinite(x).all() for x in outputs)
    assert all(x.shape==(2,length,128) for x in outputs[1:])
    assert 0<keep<=q<=length and length in CAPACITIES.values()
    result=[]
    for i,pair in enumerate(caches):
        if pair is None:
            assert p==0
            pair=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
        assert len(pair)==2 and all(x.shape==(2,p,128) and x.dtype==np.float32 for x in pair)
        updated=tuple(np.concatenate([old,new[:,:keep]],axis=1) for old,new in zip(pair,[outputs[1+i],outputs[1+count+i]]))
        assert all(x.shape==(2,layout.keep_cache_length,128) for x in updated)
        result.append(updated)
    return outputs[0][:q].copy(),tuple(result)


class CompactBpuDecoderGroup(BpuDecoderGroup):
    def __init__(self,start,end,profiles,checkpoint_sha256):
        assert (start,end) in GROUPS and {'ar','prefill'}<=set(profiles)<=set(CAPACITIES)
        assert len(checkpoint_sha256)==64
        self.start=start;self.end=end;self.specs={};count=end-start+1
        self.lengths=profile_capacities({p:e.get('sequence_capacity',CAPACITIES[p]) for p,e in profiles.items()},profiles)
        for profile in ['ar','mtp','prefill']:
            if profile not in profiles:continue
            length=self.lengths[profile];entry=profiles[profile];root=Path(entry['root']).resolve()
            assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates')) and not root.is_symlink()
            normalized=json.loads((root/'status.json').read_text());ports=json.loads((root/'ports.json').read_text())
            compiler_path=root/'compiler-status.json';compiler=json.loads(compiler_path.read_text())
            assert normalized['schema']=='compact_affine_decoder_component_v1'
            assert normalized['status']=='compiled_bpu_only' and normalized['bpu_only'] and normalized.get('cpu_fallback_count',0)==0
            assert normalized['compiler_report_sha256']==digest(compiler_path)
            assert compiler['status']=='completed' and compiler['bpu_only']
            verify_compiler_origin(compiler)
            assert (compiler['start_layer'],compiler['end_layer'],compiler['sequence_capacity'])==(start,end,length)
            assert compiler['selected_checkpoint_sha256']==checkpoint_sha256 and not compiler['fresh_final_used']
            assert [x['index'] for x in compiler['layers']]==list(range(start,end+1)) and all(x['strict_weight_load'] for x in compiler['layers'])
            expected={f'language_model.model.layers.{i}.{suffix}' for i in range(start,end+1) for suffix in LINEARS}
            assert len(compiler['selected_modules'])==count*7 and {m['name'] for m in compiler['selected_modules']}==expected
            assert all(m['bits'] in [4,8] and m['group_size']==32 and m['approximate_int8_branches']==0 for m in compiler['selected_modules'])
            assert compiler['final_norm_location']=='existing complete BPU vocabulary head' and not compiler.get('original_final_norm_included',False)
            assert compiler['mask_addition_kept_float32'] and compiler['attention_qk_output_f32'] and compiler['centered_mask_quant_absmax']==64.
            assert normalized['layer_indices']==list(range(start,end+1)) and normalized['sequence_capacity']==length
            assert normalized['final_norm_location']=='vocabulary_head' and not normalized['includes_final_norm']
            assert normalized['hbm_sha256']==entry['hbm_sha256']==compiler['hbm_sha256']==digest(root/'model.hbm')
            assert normalized['nodes'] and all('bpu' in n['device'].lower() for n in normalized['nodes'])
            disas=json.loads((root/'disas.json').read_text());assert len(disas['graphs'])==1
            nodes=disas['graphs'][0]['nodes'];assert nodes and all(n['device']=='DEVICE_CATEGORY_BPU' for n in nodes)
            assert normalized['nodes']==nodes and compiler['devices']==[n['device'] for n in nodes]
            shapes=((length,2048),(length,128),(length,128),(length,512))+((2,512,128),)*(count*2)
            output_shapes=((length,2048),)+((2,length,128),)*(count*2)
            assert normalized['input_shapes']==[list(v) for v in shapes] and normalized['output_shapes']==[list(v) for v in output_shapes]
            assert len(ports['inputs'])==len(shapes) and len(ports['outputs'])==len(output_shapes)
            assert len({p['name'] for p in ports['inputs']})==len(shapes) and len({p['name'] for p in ports['outputs']})==len(output_shapes)
            suffix='decode' if profile=='ar' else profile
            self.specs[profile]=ComponentSpec(f'decoder-group-{start:02d}-{end:02d}-{suffix}',root,entry['hbm_sha256'],shapes,('float32',)*len(shapes))

    def forward(self,executor,hidden,caches,layout,profile,rope):
        assert profile in CAPACITIES
        if profile not in self.specs:raise ValueError('Requested native decoder profile has not been compiled: '+profile)
        if profile=='prefill':assert layout.past_length==0
        length=self.lengths[profile]
        if profile=='prefill' and length<256:
            def run_chunk(part,retained,child):
                inputs=prepare_compact_group_arrays(part,retained,child,length,rope)
                outputs=executor.run_ordered(self.specs[profile].key,inputs)
                return commit_compact_group_arrays(outputs,retained,child,length)
            return forward_causal_prefill_chunks(hidden,caches,layout,length,run_chunk)
        inputs=prepare_compact_group_arrays(hidden,caches,layout,length,rope)
        outputs=executor.run_ordered(self.specs[profile].key,inputs)
        return commit_compact_group_arrays(outputs,caches,layout,length)


class CompactGroupedFullDecoder(GroupedFullDecoder):
    def __init__(self,groups):
        assert len(groups)==4 and all(isinstance(g,CompactBpuDecoderGroup) for g in groups)
        assert [(g.start,g.end) for g in groups]==list(GROUPS)
        assert all(set(g.specs)==set(groups[0].specs) for g in groups)
        assert all(g.lengths==groups[0].lengths for g in groups)
        self.profile_sequence_capacities=dict(groups[0].lengths)
        self.groups=tuple(groups);self.specs=tuple(s for g in groups for s in g.specs.values())
        assert len(self.specs) in [8,12] and len({s.key for s in self.specs})==len(self.specs)
        self.layer_indices=tuple(range(36));self.compiled_profiles=frozenset(groups[0].specs)


class CompactGroupedFullBpuGenerator(GroupedFullBpuGenerator):
    def __init__(self,vision,decoder,vocabulary,rope,image_token_index,token_ids,enabled_modes=('slow',)):
        assert isinstance(vision,FullVision) and len(vision.specs)==29
        assert isinstance(decoder,CompactGroupedFullDecoder) and decoder.layer_indices==tuple(range(36))
        assert isinstance(vocabulary,BpuVocabulary) and len(vocabulary.specs)==76 and isinstance(rope,RopeTables)
        assert isinstance(image_token_index,int) and 0<=image_token_index<152681 and TOKEN_KEYS<=set(token_ids)
        assert all(isinstance(token_ids[k],int) and 0<=token_ids[k]<152681 for k in TOKEN_KEYS)
        assert token_ids['coord_end_token_id']-token_ids['coord_start_token_id']==1000
        assert enabled_modes and set(enabled_modes)<={'slow','hybrid','fast'}
        if decoder.profile_sequence_capacities['prefill']<256:assert set(enabled_modes)=={'slow'},'Chunked MTP prefill is not validated'
        if set(enabled_modes)&{'hybrid','fast'}:assert 'mtp' in decoder.compiled_profiles
        self.vision=vision;self.decoder=decoder;self.vocabulary=vocabulary;self.rope=rope
        self.image_token_index=image_token_index;self.token_ids=dict(token_ids);self.enabled_modes=frozenset(enabled_modes)
        self.specs=tuple(vision.specs)+tuple(decoder.specs)+tuple(vocabulary.specs)
        assert len(self.specs)==105+len(decoder.specs) and len(self.specs) in [113,117]
        assert len({s.key for s in self.specs})==len(self.specs)

    def generate(self,*args,mode='slow',**kwargs):
        if mode not in self.enabled_modes:raise ValueError('Requested native generation mode has not been validated: '+mode)
        return super().generate(*args,mode=mode,**kwargs)
