"""Provenance controls only;synthetic status is never a board/model proof."""
from pathlib import Path
import copy, json, time
from locateanything_official_family_optimization_v1 import (
    BASE, ORIGINAL_FAMILY_SHA, O2_BUILDER_SHA, digest, read_json,
    verify_origin_status, load_official_generator,
)

def main():
    report_path = Path('/home/sunrise/ainvr/test/results/official-optimization-admission-controls-v1.json')
    assert not report_path.exists()
    family_path = BASE / 'official-full-family-w8a16-v1.json'
    assert digest(family_path) == ORIGINAL_FAMILY_SHA
    family = read_json(family_path)
    old_path = Path(family['groups'][0]['root']) / 'source-status.json'
    original = read_json(old_path)
    synthetic = copy.deepcopy(original)
    synthetic.update(source_sha256=O2_BUILDER_SHA, origin_status_sha256=digest(old_path),
        origin_hbm_sha256=original['hbm_sha256'], optimization=2, compile_jobs=1,
        recalibration_executed=False, weights_or_graph_changed=False)
    verify_origin_status(synthetic, original, digest(old_path))
    rejected = []
    mutations = {
        'different_origin_status': lambda s: s.update(origin_status_sha256='0'*64),
        'different_origin_hbm': lambda s: s.update(origin_hbm_sha256='0'*64),
        'different_builder': lambda s: s.update(source_sha256='0'*64),
        'recalibrated': lambda s: s.update(recalibration_executed=True),
        'weights_changed': lambda s: s.update(weights_or_graph_changed=True),
        'wrong_optimization': lambda s: s.update(optimization=0),
        'boolean_optimization': lambda s: s.update(optimization=True),
        'epsilon_changed': lambda s: s.update(original_norm_epsilon_preserved=False),
        'io_contract_changed': lambda s: s.update(quantized_io_removed=True),
        'original_parameter_changed': lambda s: s['original_parameter_hashes'].update({'0':'wrong'}),
        'calibration_changed': lambda s: s['calibration'].pop(),
        'converted_bc_changed': lambda s: s['profiles'][0].update(converted_bc_sha256='0'*64),
        'profile_range_changed': lambda s: s['profiles'][0].update(range_hash='0'*64),
        'incomplete': lambda s: s.update(status='compiling_o2_s1'),
        'unproven_board_claim': lambda s: s.update(actual_board_verified=True),
        'release_claim': lambda s: s.update(release_approved=True),
    }
    for name, mutate in mutations.items():
        candidate = copy.deepcopy(synthetic); mutate(candidate)
        try: verify_origin_status(candidate, original, digest(old_path))
        except (AssertionError, ValueError, KeyError): rejected.append(name)
        else: raise AssertionError('Invalid provenance accepted: ' + name)
    try: load_official_generator(family_path, ORIGINAL_FAMILY_SHA)
    except AssertionError: rejected.append('real_o0_contract_cannot_masquerade_as_o2')
    else: raise AssertionError('O0 admitted through optimized-only schema')
    result = dict(status='completed_controls_only', checked=time.time(),
        source_sha256=digest(Path(__file__)),
        optimization_loader_sha256=digest(Path(__file__).with_name('locateanything_official_family_optimization_v1.py')),
        original_contract_sha256=ORIGINAL_FAMILY_SHA,
        synthetic_status_positive_control=True, rejected=rejected,
        neural_calls=0, actual_optimized_hbm_tested=False,
        whole_model_verified=False, release_approved=False)
    report_path.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(status=result['status'], rejected_count=len(rejected),
        report_sha256=digest(report_path), neural_calls=0, actual_optimized_hbm_tested=False)))

if __name__ == '__main__': main()
