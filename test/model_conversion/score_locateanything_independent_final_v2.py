"""Score all160 frozen operations against prevalidated native reference eligibility.

Reference failures remain visible,never become gold and never exempt candidate
operational checks. No sample replacement,threshold tuning or NN computation.
"""
import math

def summarize(cases,parse,iou,maximum_matches,reference_index):
 refs=reference_index['cases'];assert len(refs)==160 and [c['index'] for c in refs]==list(range(160))
 eligible=[];native_failed=[]
 for c in refs:
  parsed=parse(c['response']);typeok=not parsed['points'] if c['kind']=='box' else not parsed['boxes'];terminal='<|im_end|>' in c['response'];allowed=terminal and not parsed['malformed_blocks'] and typeok
  if c['reference']!=parsed or c['reference_eligible']!=allowed or c['reference_terminal']!=terminal:raise ValueError('Reference eligibility or parsing differs')
  (eligible if allowed else native_failed).append(c['index'])
 indices=[c['index'] for c in cases]
 if len(indices)!=len(set(indices)) or any(type(i) is not int or not 0<=i<160 for i in indices):raise ValueError('Invalid final candidate coverage')
 totals=dict(matched_boxes=0,candidate_boxes=0,reference_boxes=sum(len(refs[i]['reference']['boxes']) for i in eligible if refs[i]['kind']=='box'),matched_points=0,candidate_points=0,reference_points=sum(len(refs[i]['reference']['points']) for i in eligible if refs[i]['kind']=='point'))
 operational={};empty_correct=0;excluded_predictions=[]
 for c in cases:
  ref=refs[c['index']]
  if any(c[k]!=ref[k] for k in ['index','image_id','query','kind','reference','reference_eligible','reference_terminal']):raise ValueError('Candidate altered frozen reference identity/eligibility')
  pred=c.get('candidate');kind=c['kind'];typeok=pred is not None and (not pred['points'] if kind=='box' else not pred['boxes'])
  good=c.get('rpc_ok') is True and c.get('terminal') is True and c.get('neural_cpu_fallback') is False and pred is not None and not pred['malformed_blocks'] and typeok;operational[c['index']]=good
  if not ref['reference_eligible']:
   excluded_predictions.append(dict(index=c['index'],candidate_operationally_valid=good,candidate_boxes=len(pred['boxes']) if pred is not None else None,candidate_points=len(pred['points']) if pred is not None else None,native_terminal=ref['reference_terminal'],native_malformed_blocks=ref['reference']['malformed_blocks']));continue
  pred=pred if pred is not None else dict(boxes=[],points=[],explicit_empty_boxes=0,malformed_blocks=['rpc_failed'])
  if kind=='box':
   gold=ref['reference']['boxes'];boxes=pred['boxes'];matched=maximum_matches(boxes,gold,lambda a,b:iou(a,b)>=.9) if good else []
   totals['matched_boxes']+=len(matched);totals['candidate_boxes']+=len(boxes)
   empty_correct+=bool(not gold and good and not boxes and pred['explicit_empty_boxes']>0)
  else:
   gold=ref['reference']['points'];points=pred['points'];matched=maximum_matches(points,gold,lambda a,b:math.dist(a,b)<=10) if good else []
   totals['matched_points']+=len(matched);totals['candidate_points']+=len(points)
 matched,predicted,gold=(totals[k] for k in ['matched_boxes','candidate_boxes','reference_boxes'])
 precision=matched/predicted if predicted else (1. if gold==0 else 0.);recall=matched/gold if gold else (1. if predicted==0 else 0.)
 coverage=sorted(indices)==list(range(160));valid=coverage and all(operational.values());evaluable=bool(eligible) and gold>0
 images={c['image_id'] for c in refs};eligible_images={refs[i]['image_id'] for i in eligible};assert len(images)==32
 reference_scope_covered=images==eligible_images
 common=coverage and valid and evaluable and reference_scope_covered
 return dict(**totals,precision=precision,recall=recall,iou_threshold=.9,point_tolerance_normalized_1000=10,required_candidate_cases=160,observed_candidate_cases=len(cases),candidate_coverage_complete=coverage,eligible_reference_cases=len(eligible),eligible_reference_indices=eligible,reference_eligible_fraction=len(eligible)/160,reference_image_count=32,reference_eligible_image_count=len(eligible_images),reference_coverage_complete=reference_scope_covered,native_failure_indices=native_failed,native_failure_cases=excluded_predictions,all_candidate_outputs_terminal_well_formed_and_typevalid=valid,valid_candidate_count=sum(operational.values()),empty_reference_cases=sum(not refs[i]['reference']['boxes'] for i in eligible if refs[i]['kind']=='box'),empty_reference_correct=empty_correct,trial_quality_passed=common and precision>=.45 and recall>=.45,formal_quality_passed=common and precision>=.80 and recall>=.80,preferred_quality_passed=common and precision>=.85 and recall>=.85,stretch_quality_passed=common and precision>=.90 and recall>=.90,full160_reference_agreement_defined=not native_failed,note='P/R use every eligible native box reference;exact coverage and native failures are listed. All160 candidate operations and valid terminal outputs remain mandatory. Undefined native gold never becomes a target and never exempts candidate validity. Points separately reported. Agreement to native BF16 is not annotation AP;runtime/media/UI/install gates remain separate.')
