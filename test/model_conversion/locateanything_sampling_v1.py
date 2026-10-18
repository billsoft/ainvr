"""AINVR non-neural token selection for full-vocabulary BPU head outputs.

Temperature-zero AR/MTP, original box/point/ref grammar, optional deterministic
filters and repetition penalty. Matrix/norm/head work must already run on BPU.
Equal-probability top-k ties use ascending token ID; upstream torch.topk has
backend-dependent tie order. Report ties instead of claiming universal parity.
Stochastic sampling is explicitly unavailable in this candidate.
"""
import numpy as np
from locateanything_generation_control_v1 import handle_pattern, ar_token_type

VOCABULARY_SIZE = 152681

def softmax(values):
    shifted = values-values.max(axis=-1,keepdims=True)
    probabilities = np.exp(shifted).astype(np.float32)
    return probabilities/probabilities.sum(axis=-1,keepdims=True,dtype=np.float32)

def _top(values, count):
    count = min(int(count), values.size)
    assert count > 0
    threshold = np.partition(values, values.size-count)[values.size-count]
    selected = np.flatnonzero(values >= threshold)
    selected = selected[np.lexsort((selected,-values[selected]))][:count]
    tied = bool(len(np.unique(values[selected])) < len(selected) or np.count_nonzero(values == threshold) > np.count_nonzero(values[selected] == threshold))
    return selected, tied

def _box(probs, ids, keep_k, mode, ties):
    start,end,none = ids['box_start_token_id'],ids['box_end_token_id'],ids['none_token_id']
    null,eos = ids['null_token_id'],ids['im_end_token_id']
    if probs[0,start] >= .7:
        if probs[1,none]>.2 and probs[2,end]>.2 and probs[3,null]>.1 and probs[4,null]>.1:
            return [start,none,end,null,null,null]
    if probs[5,[end,null,eos]].sum(dtype=np.float32) < .2:
        return None
    coordinates = []
    lo,hi = ids['coord_start_token_id'],ids['coord_end_token_id']
    for position in range(1,5):
        top,tied = _top(probs[position],keep_k)
        if tied:ties.append({'operation':'coordinate_topk','position':position})
        valid = top[(top>=lo)&(top<=hi)]
        if not valid.size:return None
        first = int(valid[0])
        if mode=='hybrid' and probs[position,first]<.9 and len(valid)>1 and int(valid.max()-valid.min())>60:
            first = 0
        coordinates.append(first)
    return [start]+coordinates+[end]

def _reference(probs, ids, ties):
    if probs[0,ids['ref_start_token_id']] < .6:return None
    result = [ids['ref_start_token_id']]
    lo,hi = ids['coord_start_token_id'],ids['coord_end_token_id']
    for position in range(1,len(probs)):
        top,tied = _top(probs[position],5)
        if tied:ties.append({'operation':'reference_topk','position':position})
        valid = top[(top<lo)|(top>hi)]
        if not valid.size:return None
        result.append(int(valid[0]))
    return result

def select_tokens(logits, generated, ids, *, mode='hybrid', mtp=False,
                  temperature=0., repetition_penalty=1., top_p=None,
                  top_k=None, keep_k_avg=4):
    """Select accepted tokens; caller commits pre-sampling KV via GenerationState."""
    if temperature != 0.:
        raise ValueError('This candidate supports original greedy temperature=0 only')
    assert mode in ['slow','hybrid','fast'] and not (mtp and mode=='slow')
    values = np.asarray(logits)
    assert values.dtype==np.float32 and values.ndim==2 and values.shape[1]==VOCABULARY_SIZE
    assert values.shape[0]>=(6 if mtp else 1) and np.isfinite(values).all()
    assert repetition_penalty>0 and 0<keep_k_avg<=VOCABULARY_SIZE
    values = values[-6 if mtp else -1:].copy()
    ties = []
    if repetition_penalty != 1.:
        history = np.unique(np.asarray(generated,dtype=np.int64))
        history = history[(history>=0)&(history<VOCABULARY_SIZE)]
        selected = values[:,history]
        values[:,history] = np.where(selected>0, selected/repetition_penalty, selected*repetition_penalty)
    if top_p is not None and top_p<1.:
        assert top_p>0
        for row in values:
            order = np.argsort(-row,kind='stable')
            probabilities = softmax(row[order][None])[0]
            remove = np.cumsum(probabilities,dtype=np.float32)>top_p
            remove[1:] = remove[:-1].copy()
            remove[0] = False
            row[order[remove]] = np.finfo(np.float32).min
    if top_k is not None:
        assert int(top_k)==top_k and top_k>0
        count = min(int(top_k),VOCABULARY_SIZE)
        for row in values:
            threshold = np.partition(row,VOCABULARY_SIZE-count)[VOCABULARY_SIZE-count]
            row[row<threshold] = np.finfo(np.float32).min
    probabilities = softmax(values)
    greedy = probabilities.argmax(axis=-1).astype(np.int64)
    confidence = probabilities[np.arange(len(greedy)),greedy]
    if mtp:
        decoded = _box(probabilities,ids,keep_k_avg,mode,ties)
        if decoded is None:decoded = _reference(probabilities,ids,ties)
        pattern = handle_pattern(greedy if decoded is None else decoded,ids,mode)
    else:
        token = int(greedy[0])
        kind = ar_token_type(token,ids,mode)
        pattern = dict(type=kind,tokens=[token],need_switch_to_ar=False,is_terminal=kind=='im_end')
    accepted = np.asarray(pattern['tokens'],dtype=np.int64)
    logprobs = np.full(len(accepted),np.nan,np.float32)
    count = min(len(accepted),len(probabilities))
    if count:
        logprobs[:count] = np.log(np.maximum(probabilities[np.arange(count),accepted[:count]],np.float32(1e-12)))
    return dict(pattern=pattern, tokens=accepted, chosen_logprobs=logprobs,
                probabilities=probabilities, confidence=confidence,
                greedy=greedy, topk_ties=ties,
                scope='Non-neural greedy postprocessing; full-model BPU quality pending')
