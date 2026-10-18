"""Check independent-evaluation metric fidelity and wrapper bindings, no BPU."""
from pathlib import Path
import ast,hashlib,json

ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'


def main():
    old=ast.parse((CODE/'validate_locateanything_complete_fresh_bpu_v5.py').read_text())
    path=CODE/'validate_locateanything_official_heldout_bpu_v2.py';new=ast.parse(path.read_text())
    functions=lambda tree:{n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}
    a,b=functions(old),functions(new);checks=[]
    for name in ['parse_response','iou','maximum_matches','summarize','capture_failed_generation']:
        assert ast.dump(a[name])==ast.dump(b[name]);checks.append(name+'_unchanged')
    wrapper=ast.parse((CODE/'run_locateanything_official_heldout_case_v2.py').read_text())
    variables={n.targets[0].id:n.value for n in wrapper.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name)}
    assert ast.literal_eval(variables['VALIDATOR_SHA'])==hashlib.sha256(path.read_bytes()).hexdigest()
    checks.append('wrapper_pins_actual_validator')
    test=next(n.test for n in ast.walk(wrapper) if isinstance(n,ast.Assert) and isinstance(n.msg,ast.Constant) and n.msg.value=='Complete-contract preflight failed;production must remain running')
    expression=compile(ast.Expression(test),'<preflight>','eval')
    for size in [112,113,114,213]:
        checked=dict(status='contract_checked',neural_calls=0,component_count=size,runtime_uid=1000)
        assert bool(eval(expression,dict(code=0,checked=checked)))==(size==113)
    checks.append('wrapper_accepts_only_complete113_component_architecture')
    constants={n.value for n in ast.walk(new) if isinstance(n,ast.Constant) and isinstance(n.value,str)}
    assert '5135f621868ac5999e116cb19f587224b5d1fac39fe6fe1a89b6ea7585ea105c' in constants
    assert '3c3066a0808027b3fc1e0c591ce71f435e622b6b03c01cbfb12bb739ac37ff34' in constants
    assert 'e32fbb9e82c54ab6e409c6925dfe582806194622661bc36a45ffd03ea69a9c81' in constants
    checks.append('new_reference_selection_and_frozen_candidate_bound')
    result=dict(status='passed',checks=checks,actual_bpu_calls=0,whole_model_verified=False)
    destination=ROOT/'test/results/locateanything-official-heldout-controls-v2.json'
    assert not destination.exists();destination.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
