"""Causal prefill partitioning only; all neural work remains in the BPU callback.

Preserves every original prompt row, position, visible history and per-layer KV.
Native MTP's jointly visible future rows require separate validation and are
rejected here. The original full-profile MTP path remains unchanged.
"""
import numpy as np


def profile_capacities(value,profiles):
    defaults={'ar':1,'mtp':12,'prefill':256}
    result=dict(defaults if value is None else value)
    if value is None:result={p:result[p] for p in profiles}
    assert set(result)==set(profiles) and {'ar','prefill'}<=set(result)<=set(defaults)
    assert all(type(v) is int for v in result.values())
    assert result['ar']==1 and result['prefill'] in [1,12,256]
    if 'mtp' in result:assert result['mtp']==12
    return result


def prefill_chunk_layouts(layout,length):
    from locateanything_generation_control_v1 import StepLayout
    assert length in [1,12,256] and not layout.mtp
    q=layout.query_length
    assert 0<q<=256 and layout.past_length==0 and layout.keep_cache_length==q
    assert layout.positions.shape==(q,) and layout.positions.dtype==np.int64
    assert np.array_equal(layout.positions,np.arange(q,dtype=np.int64))
    assert layout.visibility.shape==(q,q) and layout.visibility.dtype==np.bool_
    assert np.array_equal(layout.visibility,np.arange(q)[None,:]<=np.arange(q)[:,None])
    chunks=[]
    for start in range(0,q,length):
        end=min(start+length,q)
        assert start+length<=512
        child=StepLayout(layout.positions[start:end].copy(),
                         layout.visibility[start:end,:end].copy(),
                         end-start,start,end,False)
        chunks.append((slice(start,end),child))
    assert sum(child.query_length for _,child in chunks)==q
    return tuple(chunks)


def forward_causal_prefill_chunks(hidden,caches,layout,length,run_chunk):
    chunks=prefill_chunk_layouts(layout,length)
    assert hidden.shape==(layout.query_length,2048) and hidden.dtype==np.float32
    assert np.isfinite(hidden).all() and 1<=len(caches)<=9
    assert all(pair is None or (len(pair)==2 and all(
        a.shape==(2,0,128) and a.dtype==np.float32 for a in pair)) for pair in caches)
    result=[];retained=tuple(caches)
    for selected,child in chunks:
        part,retained=run_chunk(hidden[selected],retained,child)
        assert part.shape==(child.query_length,2048) and part.dtype==np.float32
        assert np.isfinite(part).all() and len(retained)==len(caches)
        assert all(len(pair)==2 and all(a.shape==(2,child.keep_cache_length,128)
            and a.dtype==np.float32 and np.isfinite(a).all() for a in pair) for pair in retained)
        result.append(part)
    return np.concatenate(result,axis=0),retained
