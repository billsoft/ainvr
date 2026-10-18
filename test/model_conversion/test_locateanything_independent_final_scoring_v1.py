"""Zero-NN controls for final coverage,undefined gold,duplicates,malformed/type/EOS.

Synthetic candidate fixtures only;no candidate final generation or tuning.
"""
from pathlib import Path
import ast,copy,hashlib,json,math,re,sys
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 p=CODE/'score_locateanything_independent_final_v1.py';assert sha(p)=='8574253fcde060a7730a1add6e59a0082f31a9bea95157798210fbdfc4e4ae6d'
 sys.path.insert(0,str(CODE));from score_locateanything_independent_final_v1 import summarize
 parser=CODE/'validate_locateanything_official_heldout_bpu_v2.py';assert sha(parser)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
 nodes=[n for n in ast.parse(parser.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in ['parse_response','iou','maximum_matches']];scope={'re':re};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(parser),'exec'),scope)
 index=BASE/'independent-final-native-reference-v1/reference-index-v2.json';assert sha(index)=='32c97fb47d5fe0cbb2fade49219e1042ca043222124f93cd9dcd7084eb841152'
 refs=json.loads(index.read_text())['cases'];perfect=[]
 for c in refs:
  n=copy.deepcopy(c);n.update(rpc_ok=True,terminal=True,neural_cpu_fallback=False,candidate=copy.deepcopy(c['reference']) if c['reference_eligible'] else scope['parse_response']('<box>none</box>'));perfect.append(n)
 run=lambda c:summarize(c,scope['parse_response'],scope['iou'],scope['maximum_matches']);tests=[]
 d=run(perfect);assert d['trial_quality_passed'] and d['precision']==d['recall']==1 and d['reference_coverage_complete'] and len(d['native_failure_cases'])==1;tests.append('all160_synthetic_requests_159_defined_gold_pass')
 d=run(perfect[:-1]);assert not d['trial_quality_passed'] and not d['candidate_coverage_complete'];tests.append('incomplete159_requests_cannot_pass')
 bad=copy.deepcopy(perfect);bad[141]['terminal']=False;d=run(bad);assert not d['trial_quality_passed'] and not d['all_candidate_outputs_terminal_well_formed_and_typevalid'];tests.append('native_failure_does_not_exempt_candidate_termination')
 bad=copy.deepcopy(perfect);bad[0]['neural_cpu_fallback']=True;assert not run(bad)['trial_quality_passed'];tests.append('cpu_fallback_rejected')
 bad=copy.deepcopy(perfect);bad[141]['reference_eligible']=True
 try:run(bad)
 except ValueError:pass
 else:raise AssertionError('Unclosed repeated native output accepted as gold')
 tests.append('malformed_reference_cannot_become_gold')
 try:run(perfect+[perfect[0]])
 except ValueError:pass
 else:raise AssertionError('Duplicate case admitted')
 tests.append('duplicate_case_rejected')
 target=next(i for i,c in enumerate(perfect) if c['kind']=='box' and c['reference']['boxes'])
 bad=copy.deepcopy(perfect);bad[target]['candidate']['boxes']*=2;d=run(bad);assert d['precision']<1 and d['recall']==1;tests.append('duplicate_boxes_penalize_precision')
 bad=copy.deepcopy(perfect);bad[target]['candidate']['points']=[[10,20]];assert not run(bad)['trial_quality_passed'];tests.append('geometry_type_mismatch_rejected')
 empty=next(i for i,c in enumerate(perfect) if c['kind']=='box' and c['reference_eligible'] and c['reference']['explicit_empty_boxes'])
 bad=copy.deepcopy(perfect);bad[empty]['candidate']['boxes']=[[0,0,100,100]];d=run(bad);assert d['precision']<1 and d['empty_reference_correct']<d['empty_reference_cases'];tests.append('empty_reference_false_positive_counted')
 bad=copy.deepcopy(perfect);bad[target]['candidate']['malformed_blocks']=['unclosed_box'];assert not run(bad)['trial_quality_passed'];tests.append('malformed_candidate_rejected')
 for c in perfect:
  if c['kind']=='box' and c['reference_eligible']:c['candidate']=scope['parse_response']('<box>none</box>')
 d=run(perfect);assert not d['trial_quality_passed'] and d['recall']==0;tests.append('all_empty_predictions_cannot_pass_nonempty_gold')
 report=dict(status='passed',controls=tests,control_count=len(tests),source_sha256=sha(__file__),scorer_sha256=sha(p),parser_sha256=sha(parser),reference_index_sha256=sha(index),neural_calls=0,synthetic_fixtures_only=True,candidate_evaluation_executed=False,quality_verified=False,release_approved=False)
 out=ROOT/'test/results/locateanything-independent-final-scoring-controls-v1.json';assert not out.exists();out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':main()
