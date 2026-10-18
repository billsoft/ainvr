"""Synthetic qualification fault controls,not candidate BPU or whole-model proof."""
from pathlib import Path
import copy
import hashlib
import json
import time

from locateanything_official_prefill_groups_v169 import (
    BENCHMARK_SHA, require_component_qualification, timing_summary,
)


def fixture():
    runs = []
    for seq in [1, 256]:
        baseline, candidate = (24., 24.) if seq == 1 else (220., 110.)
        for case in range(4):
            for repeat in range(12):
                runs.append(dict(sequence=seq, case=case, repeat=repeat, warmup=repeat < 4,
                                 order=['baseline', 'candidate'] if (case + repeat) % 2 == 0 else ['candidate', 'baseline'],
                                 timing_ms=dict(baseline=baseline, candidate=candidate),
                                 paired_ratio=baseline / candidate))
    # Explicit expected medians;do not generate the positive proof with the code under test.
    summaries = {str(seq): dict(timed_pairs=32, median_paired_ratio=ratio,
                               cases=[dict(case=c, median_paired_ratio=ratio,
                                           baseline_median_ms=baseline, candidate_median_ms=candidate)
                                      for c in range(4)])
                 for seq, ratio, baseline, candidate in [(1, 1., 24., 24.), (256, 2., 220., 110.)]}
    raw = dict(status='completed_same_bc_component_measurement_not_fullmodel_approval',
               source_sha256=BENCHMARK_SHA, manifest_sha256='a' * 64,
               calls=192, comparisons=3648, all_outputs_compiler_byte_exact=True,
               all_models_released=True, whole_model_verified=False,
               release_approved=False, component_speed_screen_passed=True,
               runs=runs, profile_timings=summaries)
    guard = dict(status='completed_component_parity_and_timing_not_fullmodel_admission',
                 source_sha256=BENCHMARK_SHA, manifest_sha256='a' * 64,
                 hardware_report_sha256='b' * 64, proof=copy.deepcopy(raw),
                 source_recording_stopped=False,
                 original_current_user_configuration_and_real_SEI_restored=True,
                 restore_errors=[], memory_samples=10,
                 conservative_owned_memory_maximum=2_000_000_000,
                 owned_ion_after_exit={'cma_reserved': 0}, frequencies=[1500000000])
    return guard, raw


def set_all_times(raw, seq, baseline, candidate):
    ratio = baseline / candidate
    for row in raw['runs']:
        if row['sequence'] == seq:
            row['timing_ms'] = dict(baseline=baseline, candidate=candidate)
            row['paired_ratio'] = ratio
    raw['profile_timings'][str(seq)] = dict(
        timed_pairs=32, median_paired_ratio=ratio,
        cases=[dict(case=c, median_paired_ratio=ratio,
                    baseline_median_ms=baseline, candidate_median_ms=candidate) for c in range(4)])


def main():
    g, r = fixture()
    require_component_qualification(g, r, 'a' * 64, 'b' * 64)
    assert timing_summary(r['runs']) == r['profile_timings']
    cases = [
        ('pending_guard', ['guard', 'status'], 'running'),
        ('wrong_benchmark', ['guard', 'source_sha256'], 'c' * 64),
        ('not_byte_exact', ['raw', 'all_outputs_compiler_byte_exact'], False),
        ('missing_neural_call', ['raw', 'calls'], 191),
        ('missing_output_comparison', ['raw', 'comparisons'], 3647),
        ('zero_memory_samples', ['guard', 'memory_samples'], 0),
        ('live_DMA_left_behind', ['guard', 'owned_ion_after_exit', 'cma_reserved'], 1),
        ('recording_stopped', ['guard', 'source_recording_stopped'], True),
        ('no_real_SEI_restore', ['guard', 'original_current_user_configuration_and_real_SEI_restored'], False),
        ('restore_error', ['guard', 'restore_errors'], [{'unit': 'ainvr-ai', 'error': 'synthetic'}]),
        ('frequency_changed', ['guard', 'frequencies'], [1000000000, 1500000000]),
        ('speed_screen_false', ['raw', 'component_speed_screen_passed'], False),
        ('forged_median', ['raw', 'profile_timings', '256', 'median_paired_ratio'], 9.0),
        ('NaN_timing', ['raw', 'runs', 0, 'timing_ms', 'candidate'], float('nan')),
        ('boolean_timing', ['raw', 'runs', 0, 'timing_ms', 'candidate'], True),
        ('zero_timing', ['raw', 'runs', 0, 'timing_ms', 'candidate'], 0.0),
        ('wrong_warmup', ['raw', 'runs', 0, 'warmup'], False),
        ('unbalanced_order', ['raw', 'runs', 0, 'order'], ['candidate', 'baseline']),
        ('premature_release', ['raw', 'release_approved'], True),
        ('premature_whole_model_approval', ['raw', 'whole_model_verified'], True),
        ('memory_bound', ['guard', 'conservative_owned_memory_maximum'], 4_000_000_000),
    ]
    rejected = []
    for name, keys, value in cases:
        fixture_data = {'guard': copy.deepcopy(g), 'raw': copy.deepcopy(r)}
        node = fixture_data
        for key in keys[:-1]:
            node = node[key]
        node[keys[-1]] = value
        fixture_data['guard']['proof'] = copy.deepcopy(fixture_data['raw'])
        try:
            require_component_qualification(fixture_data['guard'], fixture_data['raw'], 'a' * 64, 'b' * 64)
        except (AssertionError, KeyError):
            rejected.append(name)
        else:
            raise AssertionError('Unsafe qualification admitted: ' + name)
    # Internally consistent times must still fail actual acceptance thresholds.
    for name, seq, baseline, candidate in [('AR_regression', 1, 24., 26.), ('prefill_no_benefit', 256, 220., 230.)]:
        guard, raw = fixture()
        set_all_times(raw, seq, baseline, candidate)
        guard['proof'] = copy.deepcopy(raw)
        try:
            require_component_qualification(guard, raw, 'a' * 64, 'b' * 64)
        except AssertionError:
            rejected.append(name)
        else:
            raise AssertionError('Regression admitted: ' + name)
    guard, raw = fixture()
    for row in raw['runs']:
        if row['sequence'] == 256 and row['case'] == 2:
            row['timing_ms']['candidate'] = 225.
            row['paired_ratio'] = 220. / 225.
    raw['profile_timings']['256']['cases'][2].update(
        candidate_median_ms=225., median_paired_ratio=220. / 225.)
    # Overall median stays2x,but the one regressing case must reject.
    assert timing_summary(raw['runs']) == raw['profile_timings']
    guard['proof'] = copy.deepcopy(raw)
    try:
        require_component_qualification(guard, raw, 'a' * 64, 'b' * 64)
    except AssertionError:
        rejected.append('one_prefill_case_regresses_despite_good_overall')
    else:
        raise AssertionError('Case regression hidden by overall median')
    guard, raw = fixture()
    raw['runs'][0] = copy.deepcopy(raw['runs'][1])
    guard['proof'] = copy.deepcopy(raw)
    try:
        require_component_qualification(guard, raw, 'a' * 64, 'b' * 64)
    except AssertionError:
        rejected.append('duplicate_measurement_pair')
    else:
        raise AssertionError('Duplicate measurement admitted')
    assert len(rejected) == 25
    out = Path('/home/sunrise/ainvr/test/results/locateanything-prefill-groups-controls-v170.json')
    assert not out.exists()
    pin = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    result = dict(status='completed_synthetic_qualification_fault_controls_not_BPU_proof',
                  created=time.time(), source_sha256=pin(__file__),
                  helper_sha256=pin(Path(__file__).with_name('locateanything_official_prefill_groups_v169.py')),
                  synthetic_positive=1, negative_cases_rejected=rejected,
                  neural_calls=0, service_operations=0, complete_generator_constructed=False,
                  candidate_board_qualified=False, release_approved=False)
    out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
