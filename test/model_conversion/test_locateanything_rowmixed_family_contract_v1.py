"""Coherently rehashed negative controls for the real first-group diagnostic contract;zero neural calls."""
from pathlib import Path
from copy import deepcopy
import json, time
from locateanything_official_rowmixed_family_contract_v1 import BASE, digest, load_official_generator

original = BASE / 'official-full-family-rowmixed-first0-research-v1.json'
assert digest(original) == 'b310c440c77ae0e9ed61baa95a57c28a0877c3293e663ef473e2f8234c4e7622'
c = json.loads(original.read_text())
out = BASE / 'rowmixed-first0-contract-controls-v1'
assert not out.exists()
out.mkdir()
cases = []


def change(name, path, value):
    bad = deepcopy(c)
    where = bad
    for key in path[:-1]:
        where = where[key]
    where[path[-1]] = value
    cases.append((name, bad))


change('cannot_claim_final_compact_model', ['complete_compact_candidate'], True)
change('cannot_mark_trial_release', ['release_approved'], True)
change('cannot_mark_final_quality_passed', ['whole_model_verified'], True)
change('cannot_drop_text_layer', ['composition', 'text_layers'], 35)
change('cannot_drop_vision_layer', ['composition', 'vision_blocks'], 26)
change('cannot_reduce_vocabulary', ['composition', 'vocabulary'], 32768)
change('cannot_drop_logical_program', ['composition', 'logical_programs'], 75)
change('cannot_claim_wrong_physical_count', ['composition', 'physical_hbms'], 45)
change('cannot_claim_all_groups_replaced', ['composition', 'mixed_mlp_first_layers'], [0, 9, 18, 27])
change('cannot_hide_remaining_w8_groups', ['composition', 'unchanged_w8_first_layers'], [])
change('cannot_change_parent_identity', ['parent_family', 'sha256'], '0'*64)
change('cannot_substitute_untested_package', ['mixed_group', 'root'], str(BASE / 'unverified-rowmixed-group'))
change('cannot_change_manifest_identity', ['mixed_group', 'manifest_sha256'], '0'*64)
change('cannot_change_board_proof_identity', ['mixed_group', 'proof', 'sha256'], '0'*64)
change('cannot_relabel_layer_range', ['mixed_group', 'last'], 17)
change('cannot_remove_evaluation_boundary', ['evaluation_only'], False)
change('cannot_replace_runtime_source_pin', ['runtime_source_sha256', 'locateanything_official_family_dispatch_v3.py'], '0'*64)
change('cannot_change_builder_identity', ['builder_sha256'], '0'*64)
results = []
for name, bad in cases:
    path = out / (name + '.json')
    path.write_text(json.dumps(bad, indent=2) + '\n')
    try:
        load_official_generator(path, digest(path))
    except (AssertionError, ValueError):
        results.append(dict(case=name, coherent_file_hash=True, rejected=True))
    else:
        raise AssertionError('Invalid composition admitted: ' + name)
report = Path('/home/sunrise/ainvr/test/results/rowmixed-first0-family-contract-controls-v1.json')
assert not report.exists()
r = dict(status='all_coherently_rehashed_invalid_contracts_rejected', created=time.time(),
         source_sha256=digest(__file__), original_contract_sha256=digest(original),
         negative_controls=results, neural_calls=0, hbm_loads=0,
         complete_compact_candidate=False, release_approved=False)
report.write_text(json.dumps(r, indent=2) + '\n')
print(json.dumps(dict(status=r['status'], rejected=len(results), neural_calls=0)))
