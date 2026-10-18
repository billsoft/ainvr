"""Causal rejection/budget/EOS/KV controls;no neural inference or speed claims."""
from pathlib import Path
import hashlib
import json
import time

from locateanything_verified_mtp_control_v161 import select_verified_prefix


def main():
    eos = 99
    tests = [
        ('first_reject_no_verify', [1, 2, 3], 8, None, 10, [8]),
        ('target_EOS_no_verify', [1, 2, 3], eos, None, 10, [eos]),
        ('empty_proposal', [], 8, None, 10, [8]),
        ('one_remaining', [1, 2, 3], 1, None, 1, [1]),
        ('second_reject', [1, 2, 3], 1, [8, 9, 10], 10, [1, 8]),
        ('third_reject', [1, 2, 3], 1, [2, 8, 10], 10, [1, 2, 8]),
        ('all_match_no_normal_bonus', [1, 2, 3], 1, [2, 3, 4], 10, [1, 2, 3]),
        ('all_match_EOS_bonus', [1, 2, 3], 1, [2, 3, eos], 10, [1, 2, 3, eos]),
        ('EOS_in_target_prefix', [1, 2, 3], 1, [eos, 3, 4], 10, [1, eos]),
        ('EOS_exactly_proposed', [1, eos, 3], 1, [eos, 3, 4], 10, [1, eos]),
        ('budget_exact_no_bonus', [1, 2, 3], 1, [2, 3, eos], 3, [1, 2, 3]),
        ('budget_before_all_proposals', [1, 2, 3], 1, [2, 3, eos], 2, [1, 2]),
    ]
    for name, draft, first, target, remaining, expected in tests:
        actual, keep = select_verified_prefix(draft, first, target, eos, remaining)
        assert actual == expected, name
        assert keep == len(expected) - 1, name
        G = 37
        assert G + keep == G + len(actual) - 1, name
    # A rejected branch must have no influence from any of its future values.
    for tail in [[3, 4], [eos, eos], [0, 98]]:
        assert select_verified_prefix([1, 2, 3], 1, [8] + tail, eos, 10) == ([1, 8], 1)
    rejected = 0
    for args in [([1], 1, None, eos, 2), ([1], 1, [2], eos, 0)]:
        try:
            select_verified_prefix(*args)
        except AssertionError:
            rejected += 1
        else:
            raise AssertionError('Invalid verifier input admitted')
    assert rejected == 2
    out = Path('/home/sunrise/ainvr/test/results/locateanything-verified-mtp-controls-v161.json')
    assert not out.exists()
    pin = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    r = dict(status='completed_control_cases_not_neural_or_BPU_proof', created=time.time(),
             source_sha256=pin(__file__), control_sha256=pin(Path(__file__).with_name('locateanything_verified_mtp_control_v161.py')),
             positive_cases=len(tests), rejected_future_perturbations=3,
             invalid_inputs_rejected=rejected, neural_calls=0, service_operations=0,
             multirow_target_numerics_verified=False, BPU_speed_verified=False,
             release_approved=False)
    out.write_text(json.dumps(r, indent=2) + '\n')
    print(json.dumps(r))


if __name__ == '__main__':
    main()
