"""Research contract replacing only the 27 MoonViT blocks with a board-qualified same-BC O2 HBM.

Load the installed all-four-prefill-O2 family (v243),replace the shared physical
vision-block HBM while preserving prefix/connector,all decoder groups,vocabulary,
76 logical programs and 46 physical HBMs. Component qualification (per-stage byte
parity versus the deployed O0 chain on 18 frozen cases) is mandatory BEFORE
constructing the complete family. Whole-model160/latency/install remain later gates.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re

ROOT = Path('/home/sunrise/ainvr')
CODE = ROOT / 'test/model_conversion'
BASE = Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
T = ROOT / 'test/results'
SELF = 'locateanything_official_vision_o2_v284.py'
SCHEMA = 'locateanything_official_full_family_vision_o2_v1'
BASE_FAMILY = BASE / 'official-full-family-w8a16-prefill-all4-v243.json'
FIRST_LOADER = 'locateanything_official_prefill_all_v243.py'
FIRST_LOADER_SHA = '561494a4576b96dc66d8fda9b2562bdd18063f8da709c4a2deb743d3702ad344'
WORKER = 'validate_locateanything_vision_o2_board_v283.py'
WORKER_SHA = '511f91883415ba1fbe4f27f9f0f4f883103eeb9bb7c0d608a246c6013b8e7ccb'
GUARD_SOURCE = 'run_locateanything_vision_o2_board_v283.py'
PACKAGE = BASE / 'vision-all27-o2-v283-board-package'
GUARD_PATH = T / 'vision-all27-o2-v283-board-package-guard-v283.json'
RAW_PATH = PACKAGE / 'board-proof-v283.json'
O0_HBM = '8020083c93cea4d1e3d00e7c316a8b268b05c598c2b4b601088e3a13c9961da1'
VISION_KEYS = {f'vision-block-{i:02d}' for i in range(27)}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4194304), b''):
            h.update(block)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def require_component_qualification(guard, raw, manifest_sha, raw_sha, guard_source_sha):
    """Pure predicate on the actual board report;synthetic controls cannot qualify."""
    assert guard['status'] == 'completed' and guard['production_unchanged_and_fresh'] is True
    assert guard['source_sha256'] == guard_source_sha and guard['worker_sha256'] == WORKER_SHA
    assert guard['manifest_sha256'] == manifest_sha and guard['production_paused'] is False
    assert guard['hardware_report_sha256'] == raw_sha and guard['hardware'] == raw
    assert raw['source_sha256'] == WORKER_SHA and raw['status'] == 'completed'
    assert raw['o0_hbm_sha256'] == O0_HBM
    assert raw['board_calls'] == 18 * 2 * 27 * 2 and raw['stage_comparisons'] == 18 * 2 * 27
    assert raw['stage_byte_mismatches'] == 0 and raw['o0_tail_matches_production_board'] is True
    assert raw['repeats_bitwise_exact'] is True and raw['all_models_released'] is True
    assert raw['whole_model_verified'] is False and raw['release_approved'] is False
    assert raw['chain_speed_ratio_o0_over_o2'] >= 1.03
    assert abs(raw['chain_median_ms']['o0'] / raw['chain_median_ms']['o2'] - raw['chain_speed_ratio_o0_over_o2']) <= 1e-9


def qualify(manifest_sha, guard_sha, raw_sha):
    assert digest(CODE / WORKER) == WORKER_SHA
    assert digest(GUARD_PATH) == guard_sha and digest(RAW_PATH) == raw_sha
    assert digest(PACKAGE / 'manifest.json') == manifest_sha
    manifest = read(PACKAGE / 'manifest.json')
    assert manifest['schema'] == 'locateanything_vision_all27_o2_board_v283' and manifest['o0_hbm_sha256'] == O0_HBM
    assert len(manifest['programs']) == 27
    for name, entry in manifest['files'].items():
        p = PACKAGE / name
        assert p.is_file() and not p.is_symlink() and p.stat().st_size == entry['bytes']
        if p.suffix != '.hbm':
            assert digest(p) == entry['sha256']
    assert manifest['files']['official-q8/model.hbm']['sha256'] == manifest['o2_hbm_sha256']
    guard, raw = read(GUARD_PATH), read(RAW_PATH)
    require_component_qualification(guard, raw, manifest_sha, raw_sha, digest(CODE / GUARD_SOURCE))
    assert raw['o2_hbm_sha256'] == manifest['o2_hbm_sha256']
    return manifest


def require_base_family(pin):
    """Bind the actual installed all-four-prefill trial artifacts;no invented hash."""
    assert isinstance(pin, str) and re.fullmatch('[0-9a-f]{64}', pin)
    assert digest(BASE_FAMILY) == pin
    pipeline_path = T / 'locateanything-prefill-all-pipeline-v253.json'
    install_path = T / 'locateanything-prefill-all-runtime-upgrade-v251.json'
    qpath = T / 'locateanything-prefill-all-full160-guard-v247.json'
    rawpath = BASE / 'prefill-all4-frozen160-v246/status.json'
    pipeline, installed, q, raw = [read(p) for p in [pipeline_path, install_path, qpath, rawpath]]
    assert pipeline['source_sha256'] == '6023b9cff55d622ff8cf75291a998e47319b43062b9d432709a0e528d7b2decd'
    assert pipeline['status'] == 'qualified_all_prefill_trial_installed_and_real_SEI_verified'
    assert pipeline['candidate_installed'] is True and pipeline['candidate_contract_sha256'] == pin
    assert pipeline['install_report_sha256'] == digest(install_path)
    assert installed['source_sha256'] == 'ef24a2d5f795a42bdd88ea01034d5f274daabc286c78e7c26b092b02a1e7b506'
    assert installed['status'] == 'installed_prefill_trial_and_current_native_results_real_SEI_verified'
    assert installed['user_configuration_unchanged'] and installed['original_recording_continuous']
    assert installed['admission']['contract_sha256'] == pin
    assert installed['admission']['quality_report_sha256'] == digest(qpath) == pipeline['full160_guard_sha256']
    assert q['source_sha256'] == '034573d682e4ee839068d9e0c0ded8f02613db8d9d3bd3baa7c7c82e347b59c6'
    assert q['status'] == 'completed_all160_runtime_equivalence_not_installed'
    assert q['original_backend_user_config_and_sei_output_restored'] is True and q['restore_errors'] == []
    assert q['raw_sha256'] == digest(rawpath) == pipeline['full160_raw_sha256']
    assert raw['source_sha256'] == 'fc87e6fbcb059fb8908b493b2937fd970a3f3ded940bd2c52a7fa5184ce63a11'
    assert raw['contract_sha256'] == pin and raw['all160_operations_executed'] is True
    assert raw['runtime_equivalence_passed'] is True and raw['summary_exactly_equal_baseline'] is True
    assert raw['mismatch_indices'] == [] and raw['retained_failed_indices'] == [117]
    assert len(raw['cases']) == 160 and raw['neural_calls'] == 25794
    assert raw['summary'] == q['summary'] and installed['admission']['original_quality_unchanged']
    return installed


def load_official_generator(path, expected_sha256):
    path = Path(path)
    assert path.parent.resolve() == BASE and not path.is_symlink()
    assert digest(path) == expected_sha256
    c = read(path)
    assert set(c) == {'schema', 'architecture', 'evaluation_only', 'whole_model_verified',
                      'release_approved', 'base_family', 'vision_component',
                      'runtime_source_sha256', 'builder_sha256', 'composition'}
    assert c['schema'] == SCHEMA and c['architecture'] == 'original36_qwen_moonvit27_shared_programs'
    assert c['evaluation_only'] is True and c['whole_model_verified'] is False and c['release_approved'] is False
    sources = {SELF: digest(CODE / SELF), FIRST_LOADER: FIRST_LOADER_SHA, WORKER: WORKER_SHA,
               GUARD_SOURCE: c['runtime_source_sha256'][GUARD_SOURCE]}
    assert c['runtime_source_sha256'] == sources and c['builder_sha256'] == sources[SELF]
    assert all(digest(CODE / n) == pin for n, pin in sources.items())
    base_pin = c['base_family']['sha256']
    require_base_family(base_pin)
    assert c['base_family'] == dict(path=str(BASE_FAMILY), sha256=base_pin)
    component = c['vision_component']
    assert set(component) == {'manifest_sha256', 'guard_path', 'guard_sha256', 'raw_path', 'raw_sha256'}
    assert component['guard_path'] == str(GUARD_PATH) and component['raw_path'] == str(RAW_PATH)
    manifest = qualify(component['manifest_sha256'], component['guard_sha256'], component['raw_sha256'])
    from locateanything_official_prefill_all_v243 import load_official_generator as load_base
    original, _ = load_base(BASE_FAMILY, base_pin)
    from locateanything_official_family_contract_v1 import program
    from locateanything_official_family_v1 import OfficialVisionBlock, OfficialFullBpuGenerator
    from locateanything_bpu_vision_v1 import FullVision
    metadata = dict(path=str(PACKAGE / 'disas.json'), sha256=manifest['files']['disas.json']['sha256'])
    stages = original.vision.stages
    assert len(stages) == 29 and stages[0].kind == 'prefix' and stages[-1].kind == 'connector'
    blocks = []
    for i, p in enumerate(manifest['programs']):
        old = stages[1 + i].spec
        assert old.key == f'vision-block-{i:02d}' and old.program == p['name'] and old.hbm_sha256 == O0_HBM
        s = program(old.key, PACKAGE / 'official-q8/model.hbm', manifest['o2_hbm_sha256'], metadata,
                    p['name'], p['inputs'], p['outputs'], ['float32'], ['float32'])
        blocks.append(OfficialVisionBlock(i, s))
    vision = FullVision(stages[0], blocks, stages[-1])
    result = OfficialFullBpuGenerator(vision, original.decoder, original.vocabulary,
                                      original.rope, original.image_token_index, original.token_ids)
    old = {s.key: s for s in original.specs}
    new = {s.key: s for s in result.specs}
    assert set(old) == set(new) and len(new) == 76
    assert len({str(s.path.resolve()) for s in result.specs}) == 46
    changed = {key for key in old if old[key] != new[key]}
    assert changed == VISION_KEYS
    for key in changed:
        for name in ['key', 'program', 'input_names', 'input_shapes', 'input_dtypes',
                     'output_names', 'output_shapes', 'output_dtypes']:
            assert getattr(old[key], name) == getattr(new[key], name)
    assert c['composition'] == composition()
    return result, c


def composition():
    return dict(replaced_vision_blocks=27, vision_blocks_O2=True, prefill_O2_first_layers=[0, 9, 18, 27],
                unchanged_prefix_connector=True, unchanged_decoder_and_vocabulary=True, text_layers=36,
                vision_blocks=27, vocabulary=152681, logical_programs=76, physical_hbms=46)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--manifest-sha', required=True)
    parser.add_argument('--guard-sha', required=True)
    parser.add_argument('--raw-sha', required=True)
    args = parser.parse_args()
    require_base_family(args.base_sha)
    assert args.out.parent.resolve() == BASE and not args.out.exists()
    assert args.out.suffix == '.json' and args.out.name.startswith('official-full-family-w8a16-')
    # Qualification before writing;no candidate contract created for failed/no board data.
    qualify(args.manifest_sha, args.guard_sha, args.raw_sha)
    c = dict(schema=SCHEMA, architecture='original36_qwen_moonvit27_shared_programs',
             evaluation_only=True, whole_model_verified=False, release_approved=False,
             base_family=dict(path=str(BASE_FAMILY), sha256=args.base_sha),
             vision_component=dict(manifest_sha256=args.manifest_sha,
                                   guard_path=str(GUARD_PATH), guard_sha256=args.guard_sha,
                                   raw_path=str(RAW_PATH), raw_sha256=args.raw_sha),
             runtime_source_sha256={SELF: digest(CODE / SELF), FIRST_LOADER: FIRST_LOADER_SHA,
                                    WORKER: WORKER_SHA, GUARD_SOURCE: digest(CODE / GUARD_SOURCE)},
             builder_sha256=digest(CODE / SELF), composition=composition())
    args.out.write_text(json.dumps(c, indent=2) + '\n')
    load_official_generator(args.out, digest(args.out))
    print(json.dumps(dict(status='constructed_complete_research_contract_zero_neural_calls',
                          contract=str(args.out), sha256=digest(args.out), whole_model_qualified=False)))


if __name__ == '__main__':
    main()
