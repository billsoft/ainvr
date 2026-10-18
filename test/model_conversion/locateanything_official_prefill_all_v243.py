"""Research contract for a fourth board-qualified same-BC prefill replacement.

Load the admitted complete current first27-prefill-O2 family,replace only group27..35's physical
HBM while preserving its unchanged AR HBO,all76logical programs and46HBMs.
Component qualification is mandatory BEFORE constructing the complete family.
Whole-model160/latency/memory/native integration remain separate later gates.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import statistics

ROOT = Path('/home/sunrise/ainvr')
CODE = ROOT / 'test/model_conversion'
BASE = Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
T = ROOT / 'test/results'
SELF = 'locateanything_official_prefill_all_v243.py'
SCHEMA = 'locateanything_official_full_family_prefill_all_four_v1'
BASE_FAMILY = BASE / 'official-full-family-w8a16-prefill-g0-g9-g18-v204.json'
# Baseline SHA is bound to the completed actual third-group trial reports.
FIRST_LOADER = 'locateanything_official_prefill_groups_v204.py'
FIRST_LOADER_SHA = 'e99793bb305d81faa1aaf3847b9843c57af2941d48ed6d99e242e0545641e76a'
ADMISSION = 'locateanything_prefill_g27_admission_v235.py'
ADMISSION_SHA = '70b7cff55e395f20cfcdd8f789749fc096f0e8e7b9d1f1225f2d0b3baf555a23'
BENCHMARK_SHA = '648aba0ff39bed7ee185fe3a401d57b2a3861efafb7e6c1d9a4fc38e66685ded'
GUARD_PATH = T / 'locateanything-prefill-g27-o2-v239-board-guard.json'
RAW_PATH = BASE / 'prefill-g27-o2-v239-benchmark/status.json'
PACKAGE_NAME = 'prefill-g27-o2-v236-board-package'


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4194304), b''):
            h.update(block)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def timing_summary(runs):
    """Recompute the real paired statistic instead of trusting a rounded summary."""
    assert len(runs) == 96
    expected = {(seq, case, repeat) for seq in [1, 256] for case in range(4) for repeat in range(12)}
    assert {(x['sequence'], x['case'], x['repeat']) for x in runs} == expected
    for row in runs:
        assert row['warmup'] is (row['repeat'] < 4)
        assert row['order'] == (['baseline', 'candidate'] if (row['case'] + row['repeat']) % 2 == 0 else ['candidate', 'baseline'])
        times = row['timing_ms']
        assert set(times) == {'baseline', 'candidate'}
        assert all(type(v) in [int, float] and math.isfinite(v) and v > 0 for v in times.values())
        ratio = times['baseline'] / times['candidate']
        assert math.isfinite(row['paired_ratio']) and abs(ratio - row['paired_ratio']) <= 1e-12
    result = {}
    for seq in [1, 256]:
        rows = [x for x in runs if x['sequence'] == seq and not x['warmup']]
        cases = []
        for case in range(4):
            subset = [x for x in rows if x['case'] == case]
            assert len(subset) == 8
            cases.append(dict(case=case, median_paired_ratio=statistics.median(x['paired_ratio'] for x in subset),
                              baseline_median_ms=statistics.median(x['timing_ms']['baseline'] for x in subset),
                              candidate_median_ms=statistics.median(x['timing_ms']['candidate'] for x in subset)))
        result[str(seq)] = dict(timed_pairs=32, median_paired_ratio=statistics.median(x['paired_ratio'] for x in rows), cases=cases)
    return result


def require_component_qualification(guard, raw, manifest_sha, raw_sha):
    """Pure predicate;synthetic controls cannot confer hardware qualification."""
    assert guard['status'] == 'completed_component_parity_and_timing_not_fullmodel_admission'
    assert guard['source_sha256'] == BENCHMARK_SHA
    assert guard['manifest_sha256'] == manifest_sha
    assert guard['hardware_report_sha256'] == raw_sha
    assert guard['proof'] == raw
    assert guard['source_recording_stopped'] is False
    assert guard['original_current_user_configuration_and_real_SEI_restored'] is True
    assert guard['restore_errors'] == []
    assert guard['memory_samples'] > 0 and guard['conservative_owned_memory_maximum'] < 4_000_000_000
    assert guard['owned_ion_after_exit'] and not any(guard['owned_ion_after_exit'].values())
    assert guard['frequencies'] == [1500000000]
    assert raw['source_sha256'] == BENCHMARK_SHA and raw['manifest_sha256'] == manifest_sha
    assert raw['status'] == 'completed_same_bc_component_measurement_not_fullmodel_approval'
    assert raw['calls'] == 192 and raw['comparisons'] == 3648
    assert raw['all_outputs_compiler_byte_exact'] is True and raw['all_models_released'] is True
    assert raw['whole_model_verified'] is False and raw['release_approved'] is False
    assert raw['component_speed_screen_passed'] is True
    computed = timing_summary(raw['runs'])
    assert raw['profile_timings'] == computed
    assert computed['256']['median_paired_ratio'] >= 1.03
    assert all(x['median_paired_ratio'] >= .99 for x in computed['256']['cases'])
    assert computed['1']['median_paired_ratio'] >= .98


def qualify(manifest_sha, guard_sha, raw_sha):
    assert digest(CODE / ADMISSION) == ADMISSION_SHA
    assert digest(GUARD_PATH) == guard_sha and digest(RAW_PATH) == raw_sha
    from locateanything_prefill_g27_admission_v235 import admit
    manifest, profiles = admit(manifest_sha)
    guard, raw = read(GUARD_PATH), read(RAW_PATH)
    require_component_qualification(guard, raw, manifest_sha, raw_sha)
    return manifest, profiles


def require_base_family(pin):
    """No invented future hash:bind actual complete third-group trial artifacts."""
    import re
    assert isinstance(pin,str) and re.fullmatch('[0-9a-f]{64}',pin)
    assert digest(BASE_FAMILY)==pin
    pipeline_path=T/'locateanything-prefill-three-groups-pipeline-v232.json'
    install_path=T/'locateanything-prefill-three-groups-runtime-upgrade-v217.json'
    qpath=T/'locateanything-prefill-three-groups-full160-guard-v205.json'
    rawpath=BASE/'prefill-g0-g9-g18-frozen160-v205/status.json'
    pipeline,installed,q,raw=[read(p) for p in [pipeline_path,install_path,qpath,rawpath]]
    assert pipeline['source_sha256']=='47224a0080a1b96677db41e0da4f52344e80ce959c3e249ed9806ab50c86ff2e'
    assert pipeline['status']=='qualified_third_prefill_trial_installed_and_real_SEI_verified'
    assert pipeline['candidate_installed'] is True and pipeline['candidate_contract_sha256']==pin
    assert pipeline['install_report_sha256']==digest(install_path)
    assert installed['source_sha256']=='af864d27a25ef7de7895b4f5f4a97c9761c40e01abdb61ea5b635d951dda9227'
    assert installed['status']=='installed_prefill_trial_and_current_native_results_real_SEI_verified'
    assert installed['user_configuration_unchanged'] and installed['original_recording_continuous']
    assert installed['admission']['contract_sha256']==pin
    assert installed['admission']['quality_report_sha256']==digest(qpath)==pipeline['full160_guard_sha256']
    assert q['source_sha256']=='e382d248704e0b467563515f5e4d23037be3e94da6deb1149e998069d88799ef'
    assert q['status']=='completed_all160_runtime_equivalence_not_installed'
    assert q['original_backend_user_config_and_sei_output_restored'] is True and q['restore_errors']==[]
    assert q['raw_sha256']==digest(rawpath)==pipeline['full160_raw_sha256']
    assert raw['source_sha256']=='61682a5cca043ec937882f330deb516ee5afaf19865f8510de1c2ad89660b90e'
    assert raw['contract_sha256']==pin and raw['all160_operations_executed'] is True
    assert raw['runtime_equivalence_passed'] is True and raw['summary_exactly_equal_baseline'] is True
    assert raw['mismatch_indices']==[] and raw['retained_failed_indices']==[117]
    assert len(raw['cases'])==160 and raw['neural_calls']==25794
    assert raw['summary']==q['summary'] and installed['admission']['original_quality_unchanged']
    return installed


def load_official_generator(path, expected_sha256):
    path = Path(path)
    assert path.parent.resolve() == BASE and not path.is_symlink()
    assert digest(path) == expected_sha256
    c = read(path)
    assert set(c) == {'schema', 'architecture', 'evaluation_only', 'whole_model_verified',
                      'release_approved', 'base_family', 'fourth_prefill_component',
                      'runtime_source_sha256', 'builder_sha256', 'composition'}
    assert c['schema'] == SCHEMA and c['architecture'] == 'original36_qwen_moonvit27_shared_programs'
    assert c['evaluation_only'] is True and c['whole_model_verified'] is False and c['release_approved'] is False
    sources = {SELF: digest(CODE / SELF), ADMISSION: ADMISSION_SHA, FIRST_LOADER: FIRST_LOADER_SHA}
    assert c['runtime_source_sha256'] == sources and c['builder_sha256'] == sources[SELF]
    assert all(digest(CODE / n) == pin for n, pin in sources.items())
    base_pin=c['base_family']['sha256'];require_base_family(base_pin)
    assert c['base_family'] == dict(path=str(BASE_FAMILY), sha256=base_pin)
    component = c['fourth_prefill_component']
    assert set(component) == {'manifest_sha256', 'guard_path', 'guard_sha256', 'raw_path', 'raw_sha256'}
    assert component['guard_path'] == str(GUARD_PATH) and component['raw_path'] == str(RAW_PATH)
    manifest, profiles = qualify(component['manifest_sha256'], component['guard_sha256'], component['raw_sha256'])
    from locateanything_official_prefill_groups_v204 import load_official_generator as load_base
    original, _ = load_base(BASE_FAMILY, base_pin)
    from locateanything_official_family_contract_v1 import program
    from locateanything_official_family_v1 import OfficialDecoderGroup, OfficialFullDecoder, OfficialFullBpuGenerator
    package = BASE / PACKAGE_NAME
    metadata = dict(path=str(package / 'disas.json'), sha256=manifest['files']['disas.json']['sha256'])
    specs = {}
    for entry in profiles:
        kind = 'ar' if entry['sequence'] == 1 else 'prefill'
        assert kind not in specs
        specs[kind] = program('decoder-group-27-35-' + kind, package / 'model.hbm',
                              manifest['candidate_hbm_sha256'], metadata, entry['name'],
                              entry['inputs'], entry['outputs'], ['float32'] * 22, ['float32'] * 19)
    groups = list(original.decoder.groups)
    assert len(groups) == 4 and (groups[3].start, groups[3].end) == (27, 35)
    groups[3] = OfficialDecoderGroup(27, 35, specs)
    result = OfficialFullBpuGenerator(original.vision, OfficialFullDecoder(groups), original.vocabulary,
                                      original.rope, original.image_token_index, original.token_ids)
    old = {s.key: s for s in original.specs}
    new = {s.key: s for s in result.specs}
    assert set(old) == set(new) and len(new) == 76
    assert len({str(s.path.resolve()) for s in result.specs}) == 46
    changed = {key for key in old if old[key] != new[key]}
    assert changed == {'decoder-group-27-35-ar', 'decoder-group-27-35-prefill'}
    for key in changed:
        for name in ['key', 'program', 'input_names', 'input_shapes', 'input_dtypes',
                     'output_names', 'output_shapes', 'output_dtypes']:
            assert getattr(old[key], name) == getattr(new[key], name)
    assert c['composition'] == composition()
    return result, c


def composition():
    return dict(replaced_physical_first_layers=[27], prefill_O2_first_layers=[0, 9, 18, 27],
                unchanged_AR_HBO=True, text_layers=36, vision_blocks=27,
                vocabulary=152681, logical_programs=76, physical_hbms=46)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--base-sha',required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--guard-sha', required=True)
    parser.add_argument('--raw-sha', required=True)
    args = parser.parse_args()
    require_base_family(args.base_sha)
    assert args.out.parent.resolve() == BASE and not args.out.exists()
    assert args.out.suffix == '.json' and args.out.name.startswith('official-full-family-w8a16-prefill-')
    c = dict(schema=SCHEMA, architecture='original36_qwen_moonvit27_shared_programs',
             evaluation_only=True, whole_model_verified=False, release_approved=False,
             base_family=dict(path=str(BASE_FAMILY), sha256=args.base_sha),
             fourth_prefill_component=dict(manifest_sha256=args.manifest_sha,
                                            guard_path=str(GUARD_PATH), guard_sha256=args.guard_sha,
                                            raw_path=str(RAW_PATH), raw_sha256=args.raw_sha),
             runtime_source_sha256={SELF: digest(CODE / SELF), ADMISSION: ADMISSION_SHA,
                                    FIRST_LOADER: FIRST_LOADER_SHA},
             builder_sha256=digest(CODE / SELF), composition=composition())
    # Qualification before writing;no candidate contract created for failed/no board data.
    qualify(args.manifest_sha, args.guard_sha, args.raw_sha)
    args.out.write_text(json.dumps(c, indent=2) + '\n')
    load_official_generator(args.out, digest(args.out))
    print(json.dumps(dict(status='constructed_complete_research_contract_zero_neural_calls',
                          contract=str(args.out), sha256=digest(args.out), whole_model_qualified=False)))


if __name__ == '__main__':
    main()
