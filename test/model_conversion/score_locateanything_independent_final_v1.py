"""Strict frozen160-case final scoring,with native-baseline failure separately visible.

No generation,selection or model tuning occurs here. All160 candidate operations
are mandatory. Undefined native gold is never counted as42 correct repeated boxes.
"""
import math

def summarize(cases,parse,iou,maximum_matches):
 indices=[c['index'] for c in cases]
 if len(indices)!=len(set(indices)) or any(type(i) is not int or not 0<=i<160 for i in indices):raise ValueError('Invalid final case coverage')
 eligible=[];operational=[];failed_native=[];empty=[];totals=dict(matched_boxes=0,candidate_boxes=0,reference_boxes=0,matched_points=0,candidate_points=0,reference_points=0)
 for c in cases:
  candidate=c.get('candidate');reference=c['reference'];kind=c['kind']
  if kind not in ('box','point'):raise ValueError('Invalid geometry type')
  def typevalid(parsed):return not parsed['points'] if kind=='box' else not parsed['boxes']
  good=c.get('rpc_ok') is True and c.get('terminal') is True and c.get('neural_cpu_fallback') is False and candidate is not None and not candidate['malformed_blocks'] and typevalid(candidate)
  operational.append(good)
  if not c['reference_eligible']:
   failed_native.append(dict(index=c['index'],candidate_operationally_valid=good,native_terminal=c['reference_terminal'],native_malformed_blocks=reference['malformed_blocks']));continue
  if not c['reference_terminal'] or reference['malformed_blocks'] or not typevalid(reference):raise ValueError('Invalid reference marked eligible')
  eligible.append(c['index']);pred=candidate if candidate is not None else dict(boxes=[],points=[],explicit_empty_boxes=0,malformed_blocks=['rpc_failed'])
  if kind=='box':
   refs=reference['boxes'];preds=pred['boxes'];matches=maximum_matches(preds,refs,lambda a,b:iou(a,b)>=.9) if good else []
   totals['matched_boxes']+=len(matches);totals['candidate_boxes']+=len(preds);totals['reference_boxes']+=len(refs)
   if not refs:empty.append(dict(index=c['index'],candidate_empty=good and not preds and pred['explicit_empty_boxes']>0))
  else:
   refs=reference['points'];preds=pred['points'];matches=maximum_matches(preds,refs,lambda a,b:math.dist(a,b)<=10) if good else []
   totals['matched_points']+=len(matches);totals['candidate_points']+=len(preds);totals['reference_points']+=len(refs)
 matched=totals['matched_boxes'];predicted=totals['candidate_boxes'];gold=totals['reference_boxes']
 precision=matched/predicted if predicted else (1. if gold==0 else 0.);recall=matched/gold if gold else (1. if predicted==0 else 0.)
 coverage=sorted(indices)==list(range(160));expected_eligible=[i for i in range(160) if i!=141]
 eligibility_complete=sorted(eligible)==expected_eligible and len(failed_native)==1 and failed_native[0]['index']==141
 valid=coverage and all(operational)
 return dict(**totals,precision=precision,recall=recall,iou_threshold=.9,point_tolerance_normalized_1000=10,required_candidate_cases=160,observed_candidate_cases=len(cases),candidate_coverage_complete=coverage,eligible_reference_cases=len(eligible),eligible_reference_indices=sorted(eligible),reference_coverage_complete=eligibility_complete,native_failure_cases=failed_native,all_candidate_outputs_terminal_well_formed_and_typevalid=valid,valid_candidate_count=sum(operational),empty_reference_cases=len(empty),empty_reference_correct=sum(c['candidate_empty'] for c in empty),trial_quality_passed=coverage and eligibility_complete and valid and precision>=.45 and recall>=.45,formal_quality_passed=coverage and eligibility_complete and valid and precision>=.80 and recall>=.80,preferred_quality_passed=coverage and eligibility_complete and valid and precision>=.85 and recall>=.85,stretch_quality_passed=coverage and eligibility_complete and valid and precision>=.90 and recall>=.90,full160_reference_agreement_defined=False,note='P/R use159 eligible native references(143 box,16 point). All160 candidate requests remain mandatory;native case141 is separately reported. Agreement to native BF16 is not annotation AP. Runtime/media/UI/install gates remain separate;no release approval.')
