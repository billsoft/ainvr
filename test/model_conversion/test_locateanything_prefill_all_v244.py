"""Synthetic qualification fault controls,not candidate BPU or whole-model proof."""
from pathlib import Path
import copy
import hashlib
import json
import time

from locateanything_official_prefill_all_v243 import (
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


def test_base_report_chain():
    import locateanything_official_prefill_all_v243 as m
    pin='a'*64;ipin='b'*64;qpin='c'*64;rpin='d'*64
    paths={'pipeline':m.T/'locateanything-prefill-three-groups-pipeline-v232.json','install':m.T/'locateanything-prefill-three-groups-runtime-upgrade-v217.json','quality':m.T/'locateanything-prefill-three-groups-full160-guard-v205.json','raw':m.BASE/'prefill-g0-g9-g18-frozen160-v205/status.json'}
    base={'pipeline':dict(source_sha256='47224a0080a1b96677db41e0da4f52344e80ce959c3e249ed9806ab50c86ff2e',status='qualified_third_prefill_trial_installed_and_real_SEI_verified',candidate_installed=True,candidate_contract_sha256=pin,install_report_sha256=ipin,full160_guard_sha256=qpin,full160_raw_sha256=rpin),
    'install':dict(source_sha256='af864d27a25ef7de7895b4f5f4a97c9761c40e01abdb61ea5b635d951dda9227',status='installed_prefill_trial_and_current_native_results_real_SEI_verified',user_configuration_unchanged=True,original_recording_continuous=True,admission=dict(contract_sha256=pin,quality_report_sha256=qpin,original_quality_unchanged=True)),
    'quality':dict(source_sha256='e382d248704e0b467563515f5e4d23037be3e94da6deb1149e998069d88799ef',status='completed_all160_runtime_equivalence_not_installed',original_backend_user_config_and_sei_output_restored=True,restore_errors=[],raw_sha256=rpin,summary={'p':.593,'r':.625}),
    'raw':dict(source_sha256='61682a5cca043ec937882f330deb516ee5afaf19865f8510de1c2ad89660b90e',contract_sha256=pin,all160_operations_executed=True,runtime_equivalence_passed=True,summary_exactly_equal_baseline=True,mismatch_indices=[],retained_failed_indices=[117],cases=[{'index':i} for i in range(160)],neural_calls=25794,summary={'p':.593,'r':.625})}
    mutations=[('pending_pipeline',['pipeline','status'],'running'),('baseline_not_installed',['pipeline','candidate_installed'],False),('wrong_pipeline_source',['pipeline','source_sha256'],'f'*64),('wrong_base_pin',['pipeline','candidate_contract_sha256'],'f'*64),('wrong_install_digest',['pipeline','install_report_sha256'],'f'*64),('failed_install',['install','status'],'failed'),('wrong_install_source',['install','source_sha256'],'f'*64),('config_changed',['install','user_configuration_unchanged'],False),('recorder_interrupted',['install','original_recording_continuous'],False),('quality_digest_wrong',['install','admission','quality_report_sha256'],'f'*64),('quality_source_wrong',['quality','source_sha256'],'f'*64),('quality_not_restored',['quality','original_backend_user_config_and_sei_output_restored'],False),('raw_digest_wrong',['quality','raw_sha256'],'f'*64),('partial160',['raw','cases'],[{}]),('incomplete_requests',['raw','all160_operations_executed'],False),('token_mismatch_hidden',['raw','mismatch_indices'],[6]),('new_failure_exception',['raw','retained_failed_indices'],[52,105,117]),('calls_not_reconciled',['raw','neural_calls'],25793),('different_quality',['raw','summary'],{'p':1.,'r':1.}),('unchanged_quality_not_proven',['install','admission','original_quality_unchanged'],False)]
    original_read,original_digest=m.read,m.digest;active=copy.deepcopy(base)
    pins={m.BASE_FAMILY:pin,paths['install']:ipin,paths['quality']:qpin,paths['raw']:rpin}
    try:
        def reader(path):return active[next(k for k,v in paths.items() if v==Path(path))]
        def digest(path):return pins[Path(path)]
        m.read,m.digest=reader,digest
        assert m.require_base_family(pin)['status']=='installed_prefill_trial_and_current_native_results_real_SEI_verified'
        rejected=[]
        for name,keys,value in mutations:
            active=copy.deepcopy(base);node=active
            for key in keys[:-1]:node=node[key]
            node[keys[-1]]=value
            try:m.require_base_family(pin)
            except (AssertionError,KeyError):rejected.append('base_'+name)
            else:raise AssertionError('Unqualified installed baseline accepted: '+name)
        assert len(rejected)==len(mutations)
        return rejected
    finally:m.read,m.digest=original_read,original_digest


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
    rejected.extend(test_base_report_chain())
    out = Path('/home/sunrise/ainvr/test/results/locateanything-prefill-all-controls-v244.json')
    assert not out.exists()
    pin = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    result = dict(status='completed_synthetic_qualification_fault_controls_not_BPU_proof',
                  created=time.time(), source_sha256=pin(__file__),
                  helper_sha256=pin(Path(__file__).with_name('locateanything_official_prefill_all_v243.py')),
                  synthetic_positive=2, negative_cases_rejected=rejected,
                  neural_calls=0, service_operations=0, complete_generator_constructed=False,
                  candidate_board_qualified=False, release_approved=False)
    out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
