"""Research contract for a third board-qualified same-BC prefill replacement.

Load the admitted complete current first18-prefill-O2 family,replace only group18..26's physical
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
SELF = 'locateanything_official_prefill_groups_v204.py'
SCHEMA = 'locateanything_official_full_family_prefill_three_groups_v3'
BASE_FAMILY = BASE / 'official-full-family-w8a16-prefill-g0-g9-v169.json'
BASE_SHA = 'ddf40b566faa841b3ff3aa658d7beb31b44576f7895db93adb3476b41fe6d101'
FIRST_LOADER = 'locateanything_official_prefill_groups_v169.py'
FIRST_LOADER_SHA = 'ce065f1d3dd70e19c890bfe6b9c126dbaa454404896a885c776a5e63246a4313'
ADMISSION = 'locateanything_prefill_g18_admission_v201.py'
ADMISSION_SHA = 'a2eff6223072b6c393e59f175158c3c17df779493afc6305071d4c611371cbc2'
BENCHMARK_SHA = '0bd6f782183fe42fa74220f0bca48e3291e51220ec2f403916fd9ffab1a08ed9'
GUARD_PATH = T / 'locateanything-prefill-g18-o2-v201-board-guard.json'
RAW_PATH = BASE / 'prefill-g18-o2-v201-benchmark/status.json'
PACKAGE_NAME = 'prefill-g18-o2-v201-board-package'


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
    from locateanything_prefill_g18_admission_v201 import admit
    manifest, profiles = admit(manifest_sha)
    guard, raw = read(GUARD_PATH), read(RAW_PATH)
    require_component_qualification(guard, raw, manifest_sha, raw_sha)
    return manifest, profiles


def load_official_generator(path, expected_sha256):
    path = Path(path)
    assert path.parent.resolve() == BASE and not path.is_symlink()
    assert digest(path) == expected_sha256
    c = read(path)
    assert set(c) == {'schema', 'architecture', 'evaluation_only', 'whole_model_verified',
                      'release_approved', 'base_family', 'third_prefill_component',
                      'runtime_source_sha256', 'builder_sha256', 'composition'}
    assert c['schema'] == SCHEMA and c['architecture'] == 'original36_qwen_moonvit27_shared_programs'
    assert c['evaluation_only'] is True and c['whole_model_verified'] is False and c['release_approved'] is False
    sources = {SELF: digest(CODE / SELF), ADMISSION: ADMISSION_SHA, FIRST_LOADER: FIRST_LOADER_SHA}
    assert c['runtime_source_sha256'] == sources and c['builder_sha256'] == sources[SELF]
    assert all(digest(CODE / n) == pin for n, pin in sources.items())
    assert c['base_family'] == dict(path=str(BASE_FAMILY), sha256=BASE_SHA)
    component = c['third_prefill_component']
    assert set(component) == {'manifest_sha256', 'guard_path', 'guard_sha256', 'raw_path', 'raw_sha256'}
    assert component['guard_path'] == str(GUARD_PATH) and component['raw_path'] == str(RAW_PATH)
    manifest, profiles = qualify(component['manifest_sha256'], component['guard_sha256'], component['raw_sha256'])
    from locateanything_official_prefill_groups_v169 import load_official_generator as load_base
    original, _ = load_base(BASE_FAMILY, BASE_SHA)
    from locateanything_official_family_contract_v1 import program
    from locateanything_official_family_v1 import OfficialDecoderGroup, OfficialFullDecoder, OfficialFullBpuGenerator
    package = BASE / PACKAGE_NAME
    metadata = dict(path=str(package / 'disas.json'), sha256=manifest['files']['disas.json']['sha256'])
    specs = {}
    for entry in profiles:
        kind = 'ar' if entry['sequence'] == 1 else 'prefill'
        assert kind not in specs
        specs[kind] = program('decoder-group-18-26-' + kind, package / 'model.hbm',
                              manifest['candidate_hbm_sha256'], metadata, entry['name'],
                              entry['inputs'], entry['outputs'], ['float32'] * 22, ['float32'] * 19)
    groups = list(original.decoder.groups)
    assert len(groups) == 4 and (groups[2].start, groups[2].end) == (18, 26)
    groups[2] = OfficialDecoderGroup(18, 26, specs)
    result = OfficialFullBpuGenerator(original.vision, OfficialFullDecoder(groups), original.vocabulary,
                                      original.rope, original.image_token_index, original.token_ids)
    old = {s.key: s for s in original.specs}
    new = {s.key: s for s in result.specs}
    assert set(old) == set(new) and len(new) == 76
    assert len({str(s.path.resolve()) for s in result.specs}) == 46
    changed = {key for key in old if old[key] != new[key]}
    assert changed == {'decoder-group-18-26-ar', 'decoder-group-18-26-prefill'}
    for key in changed:
        for name in ['key', 'program', 'input_names', 'input_shapes', 'input_dtypes',
                     'output_names', 'output_shapes', 'output_dtypes']:
            assert getattr(old[key], name) == getattr(new[key], name)
    assert c['composition'] == composition()
    return result, c


def composition():
    return dict(replaced_physical_first_layers=[18], prefill_O2_first_layers=[0, 9, 18],
                unchanged_AR_HBO=True, text_layers=36, vision_blocks=27,
                vocabulary=152681, logical_programs=76, physical_hbms=46)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--guard-sha', required=True)
    parser.add_argument('--raw-sha', required=True)
    args = parser.parse_args()
    assert args.out.parent.resolve() == BASE and not args.out.exists()
    assert args.out.suffix == '.json' and args.out.name.startswith('official-full-family-w8a16-prefill-')
    c = dict(schema=SCHEMA, architecture='original36_qwen_moonvit27_shared_programs',
             evaluation_only=True, whole_model_verified=False, release_approved=False,
             base_family=dict(path=str(BASE_FAMILY), sha256=BASE_SHA),
             third_prefill_component=dict(manifest_sha256=args.manifest_sha,
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
