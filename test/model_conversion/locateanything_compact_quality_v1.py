"""Current compact-model agreement gate;geometry matching stays canonical.

45% P and R are separate floors at IoU.9 versus native BF16. Complete72-case
coverage,terminal output and real architecture evidence remain mandatory.
This module never approves installation,memory,speed,SEI,archive or UI release.
"""
from pathlib import Path
from collections import Counter
import copy,hashlib,json,math
from validate_locateanything_official_heldout_bpu_v2 import (
 summarize as original_summary,parse_response,iou,maximum_matches)
from locateanything_compact_prefill_chunks_v1 import profile_capacities

POLICY=Path('/home/sunrise/ainvr/test/results/locateanything-acceptance-policy-v4.json')
POLICY_SHA='de35b2b65810b2f454824bc2a2c9bcc308c54f406bb8b468a51cf1f6b2786aea'

def read_current_policy():
    assert hashlib.sha256(POLICY.read_bytes()).hexdigest()==POLICY_SHA
    value=json.loads(POLICY.read_text());assert value['status']=='current_user_requirement'
    assert value['box_agreement']==dict(precision_floor=.45,recall_floor=.45,iou_threshold=.9,
      reference='Original BF16 same image and prompt; not annotation AP')
    assert not value['release_approved'] and not value['goal_complete']
    return value

def verify_slow_call_coverage(generator,counts,answer,input_ids):
    counts=Counter(counts);steps=answer['steps']
    assert answer['generation_mode']=='slow' and steps and not answer['neural_cpu_fallback']
    assert all(len(step['accepted_tokens'])==1 for step in steps)
    assert steps[0]['profile']=='prefill' and all(step['profile']=='ar' for step in steps[1:])
    assert not any(step['mtp'] for step in steps)
    assert counts and set(counts)<={spec.key for spec in generator.specs} and all(isinstance(v,int) and v>0 for v in counts.values())
    vision={s.key for s in generator.vision.specs};assert len(vision)==29 and all(counts[k]==1 for k in vision)
    assert generator.decoder.layer_indices==tuple(range(36)) and len(generator.decoder.groups)==4
    lengths=profile_capacities(generator.decoder.profile_sequence_capacities,generator.decoder.compiled_profiles)
    assert steps[0]['query_length']==len(input_ids) and 0<len(input_ids)<=256
    prefill_calls=(len(input_ids)+lengths['prefill']-1)//lengths['prefill']
    for group in generator.decoder.groups:
        assert group.lengths==lengths
        assert counts[group.specs['prefill'].key]==prefill_calls and counts[group.specs['ar'].key]==len(steps)-1
    heads={entry['key'] for entry in generator.vocabulary.tables['head']}
    assert len(heads)==38 and all(counts[k]==len(steps) for k in heads)
    expected_embeddings=sum(int(i)!=generator.image_token_index for i in input_ids)+len(steps)-1
    assert sum(v for k,v in counts.items() if k.startswith('embedding-'))==expected_embeddings
    assert sum(counts.values())==answer['bpu_calls']
    return dict(vision_components=29,decoder_layers=36,full_vocabulary_heads=38,successful_calls=sum(counts.values()),
      profile='slow_native_AR1_prefill'+str(lengths['prefill']),prefill_calls_per_group=prefill_calls,
      original_prompt_rows=len(input_ids),verified=True)

def summarize_compact(cases,required_indices):
    policy=read_current_policy();indices=[case['index'] for case in cases]
    assert len(indices)==len(set(indices)) and all(isinstance(i,int) and 0<=i<72 for i in indices)
    assert required_indices==sorted(set(required_indices)) and all(0<=i<72 for i in required_indices)
    assert set(indices)<=set(required_indices)
    checked=[]
    for original in cases:
        case=copy.deepcopy(original)
        assert case['kind'] in ['box','point'] and case['candidate']==parse_response(case['response'])
        target=case['reference'];candidate=case['candidate']
        # Recompute every one-to-one match;never trust prefilled counts.
        boxes=maximum_matches(target['boxes'],candidate['boxes'],lambda x,y:iou(x,y)>=.9)
        points=maximum_matches(target['points'],candidate['points'],lambda x,y:sum((u-v)**2 for u,v in zip(x,y))<=100)
        assert case['matched_boxes']==len(boxes) and case['matched_points']==len(points)
        checked.append(case)
    result=original_summary(checked,required_indices)
    result['historical_70_percent_trial_passed']=result['box_trial_quality_passed']
    floor=policy['box_agreement']
    valid=result['coverage_complete'] and result['all_outputs_terminal_and_well_formed'] and result['box_cases']==64 and result['point_cases']==8
    architecture_valid=bool(cases) and all(c.get('architecture_coverage_verified') is True and
      isinstance(c.get('executor_stats',{}).get('calls'),int) and c['executor_stats']['calls']>0 for c in cases)
    actual_architectures=sum(c.get('architecture_coverage_verified') is True for c in cases)
    result.update(quality_policy_sha256=POLICY_SHA,precision_floor=floor['precision_floor'],recall_floor=floor['recall_floor'],
      all_architectures_verified=architecture_valid,actual_complete_architecture_cases=actual_architectures,
      box_trial_quality_passed=valid and architecture_valid and result['precision']>=floor['precision_floor'] and result['recall']>=floor['recall_floor'],
      whole_model_release_approved=False,
      scope='Complete compact BPU box agreement only;points reported separately. Memory/speed/native SEI/archive/UI release remain separate.')
    assert all(math.isfinite(result[k]) for k in ['precision','recall'])
    return result
