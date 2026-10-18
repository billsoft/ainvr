"""Meaningful non-neural controls: metric fidelity and no false final gate."""
from pathlib import Path
import ast
import hashlib
import json
import math
import re
import time

ROOT=Path('/home/sunrise/ainvr')
CODE=ROOT/'test/model_conversion'
OLD=CODE/'validate_locateanything_complete_fresh_bpu_v5.py'
NEW=CODE/'validate_locateanything_grouped_development_bpu_v1.py'


def functions(path):
    tree=ast.parse(path.read_text())
    return {n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}


def main():
    old,new=functions(OLD),functions(NEW)
    checks=[]
    for name in ['parse_response','iou','maximum_matches','capture_failed_generation']:
        assert ast.dump(old[name])==ast.dump(new[name]),name
        checks.append(name+'_unchanged')
    ns=dict(re=re,math=math)
    for name in ['parse_response','iou','maximum_matches','summarize']:
        exec(compile(ast.Module(body=[new[name]],type_ignores=[]),str(NEW),'exec'),ns)
    summarize=ns['summarize']
    cases=[dict(index=i,kind='box',matched_boxes=1,candidate=dict(boxes=[[0,0,10,10]],points=[],malformed_blocks=[]),
                reference=dict(boxes=[[0,0,10,10]],points=[]),terminal=True,neural_cpu_fallback=False) for i in range(72)]
    perfect=summarize(cases,list(range(72)))
    assert perfect['precision']==perfect['recall']==1.
    assert not perfect['coverage_complete']
    assert all(not perfect[k] for k in ['box_trial_quality_passed','box_formal_quality_passed','box_preferred_quality_passed'])
    checks.append('perfect_development_outputs_cannot_approve_fresh_final')
    cases[0]['candidate']['boxes'].append([20,20,30,30])
    duplicate=summarize(cases,list(range(72)))
    assert duplicate['precision']==72/73 and duplicate['recall']==1.
    checks.append('false_positive_not_dropped')
    cases[0]['terminal']=False
    assert not summarize(cases,list(range(72)))['all_outputs_terminal_and_well_formed']
    checks.append('partial_response_not_accepted')
    assert ns['maximum_matches']([1,1],[1],lambda a,b:a==b)==[(0,0)]
    checks.append('duplicate_predictions_one_to_one_matching')
    wrapper=CODE/'run_locateanything_grouped_development_case_v1.py'
    tree=ast.parse(wrapper.read_text())
    assignments={n.targets[0].id:n.value for n in tree.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name)}
    assert ast.literal_eval(assignments['VALIDATOR_SHA'])==hashlib.sha256(NEW.read_bytes()).hexdigest()
    checks.append('bounded_recovery_wrapper_pins_new_validator')
    report=dict(status='passed',created=time.time(),checks=checks,check_count=len(checks),
                actual_bpu_calls=0,synthetic_control_cases=True,whole_model_verified=False,
                release_approved=False,validator_sha256=hashlib.sha256(NEW.read_bytes()).hexdigest())
    destination=ROOT/'test/results/locateanything-grouped-evaluation-controls-v1.json'
    assert not destination.exists()
    destination.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))


if __name__=='__main__': main()
