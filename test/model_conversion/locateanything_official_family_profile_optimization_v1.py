"""Admit separately optimized decode/prefill only after actual component proofs.

Metadata admission does not load a model or approve quality, speed or release.
The original complete O0 family remains immutable and independently checked.
"""
from pathlib import Path
import copy
from locateanything_official_family_contract_v1 import (
    CODE, SOURCES, BASE, RESULTS, digest, checked, read_json, verified,
    package, proof, program, load_official_generator as load_original,
)

ORIGINAL_FAMILY_SHA = '0acdacb1703511e12e0d9f90b1b9480cc4230606b72bac8479cfa65ef84d7cd9'
O2_BUILDER_SHA = 'e3ed149369d804c110271b1b71ecbbe879498595084d7010c69c65a30bca3702'
SELF = 'locateanything_official_family_profile_optimization_v1.py'
SCHEMA = 'locateanything_official_full_family_profile_optimization_v1'


def verify_origin_status(candidate, original, original_status_sha):
    assert candidate['source_sha256'] == '0bd6e6b75f652e3cf8bad289d09c724fc7a77e113a75ade32ebefec5226aab72'
    assert candidate['origin_status_sha256'] == original_status_sha
    assert candidate['origin_hbm_sha256'] == original['hbm_sha256']
    assert candidate['first'] == original['first'] == 0 and candidate['last'] == 8
    assert candidate['profile_optimization'] == {'1': 2, '256': 0}
    assert candidate['recompilation_executed'] is False
    assert candidate['recalibration_executed'] is False and candidate['weights_or_graph_changed'] is False
    assert candidate['maximum_compile_seconds'] is None
    assert candidate['status'] == original['status'] == 'compiled_original_group_shared_profiles_bpu_only'
    assert candidate['bpu_only'] is True
    snapshot_ref = dict(path=str(RESULTS/'official-qwen-o2-observation-v90.json'),
                        sha256='44832fca087ccc7f1dde3c5716e8d3088464a459060e00badee899742d20f961')
    assert candidate['optimized_profile_snapshot_sha256'] == snapshot_ref['sha256']
    snapshot = verified(snapshot_ref, (BASE, RESULTS))['active_status']
    assert snapshot['source_sha256'] == candidate['optimized_profile_builder_sha256'] == O2_BUILDER_SHA
    assert snapshot['origin_status_sha256'] == original_status_sha
    assert snapshot['optimization'] == 2 and snapshot['recalibration_executed'] is False and snapshot['weights_or_graph_changed'] is False
    ar = next(p for p in snapshot['profiles'] if p['sequence_capacity'] == 1)
    assert ar['status'] == 'compiled_hbo'
    mutable = {'started','finished','pid','source_sha256','hbm_sha256',
               'hbm_bytes','devices','compiler_memory','profiles'}
    added = {'origin_status_sha256','origin_hbm_sha256','optimized_profile_snapshot_sha256',
             'optimized_profile_builder_sha256','profile_optimization','recompilation_executed',
             'recalibration_executed','weights_or_graph_changed','link_seconds'}
    assert set(candidate) == set(original) | added
    assert {k:v for k,v in candidate.items() if k not in mutable|added} == {
        k:v for k,v in original.items() if k not in mutable}
    assert len(candidate['profiles']) == len(original['profiles']) == 2
    for current,old in zip(candidate['profiles'],original['profiles']):
        ignore={'compile_seconds','hbo_sha256'}
        assert set(current) == set(old)
        assert {k:v for k,v in current.items() if k not in ignore} == {k:v for k,v in old.items() if k not in ignore}
        assert current['status'] == 'compiled_hbo' and current['sequence_capacity'] in (1,256)
        if current['sequence_capacity']==1:
            assert current['converted_bc_sha256']==ar['converted_bc_sha256']
            assert current['hbo_sha256']==ar['hbo_sha256'] and current['compile_seconds']==ar['compile_seconds']
        else:
            assert current==old, 'O0 prefill must be unchanged'
    assert candidate['actual_board_verified'] is False
    assert candidate['whole_model_verified'] is False and candidate['release_approved'] is False


def load_optimized_group(entry, original_entry):
    from locateanything_official_family_v1 import OfficialDecoderGroup
    assert set(entry) == set(original_entry)
    assert (entry['first'], entry['last']) == (original_entry['first'], original_entry['last'])
    root, manifest = package(entry, 'locateanything_official_qwen_group_board_v1')
    old_root, old_manifest = package(original_entry, 'locateanything_official_qwen_group_board_v1')
    assert root != old_root, 'O0 candidate must not be overwritten'
    verify_origin_status(manifest['source_status'], old_manifest['source_status'],
                         old_manifest['files']['source-status.json']['sha256'])
    assert manifest['profiles'] == old_manifest['profiles'], 'IO contract changed'
    assert manifest['case_count'] == old_manifest['case_count'] == 8
    assert manifest['layer_count'] == old_manifest['layer_count'] == 9
    assert manifest['component_kind'] == old_manifest['component_kind'] == 'qwen_group9'
    assert set(manifest['files']) == set(old_manifest['files'])
    changed = {'official-q8/model.hbm', 'source-status.json', 'disas.json'}
    for name, info in old_manifest['files'].items():
        if name not in changed:
            assert manifest['files'][name] == info, ('Original reference/input fixture changed', name)
    guard, hardware = proof(entry['proof'])
    assert guard['manifest_sha256'] == entry['manifest_sha256']
    assert hardware['board_calls'] == 80 and hardware['all_outputs_compiler_bitwise_exact'] is True
    stats = hardware['executor_stats']
    assert stats['calls'] == 80 and stats['loads'] == stats['evictions'] == 1
    assert stats['logical_programs'] == 2 and stats['physical_hbm_files'] == 1
    metadata = dict(path=str(root / 'disas.json'), sha256=manifest['files']['disas.json']['sha256'])
    profiles = {}
    for profile in manifest['profiles']:
        seq = profile['sequence']; kind = 'ar' if seq == 1 else 'prefill'
        assert seq in (1, 256) and kind not in profiles
        profiles[kind] = program(
            f"decoder-group-{entry['first']:02d}-{entry['last']:02d}-{kind}",
            root / 'official-q8/model.hbm', manifest['files']['official-q8/model.hbm']['sha256'],
            metadata, profile['name'], profile['inputs'], profile['outputs'],
            ['float32'] * 22, ['float32'] * 19)
    return OfficialDecoderGroup(entry['first'], entry['last'], profiles)


def load_official_generator(path, expected_sha256):
    from locateanything_official_family_v1 import OfficialFullDecoder, OfficialFullBpuGenerator
    path = checked(path)
    assert digest(path) == expected_sha256
    contract = read_json(path)
    assert contract['schema'] == SCHEMA
    assert contract['evaluation_only'] is True and contract['release_approved'] is False
    assert contract['architecture'] == 'original36_qwen_moonvit27_shared_programs'
    assert contract['enabled_generation_modes'] == ['slow']
    pins = contract['runtime_source_sha256']
    assert set(pins) == SOURCES | {SELF}
    assert digest(CODE / SELF) == pins[SELF]
    origin_ref = contract['original_family']
    assert origin_ref['sha256'] == ORIGINAL_FAMILY_SHA
    original_generator, origin = load_original(origin_ref['path'], origin_ref['sha256'])
    assert {k: v for k, v in pins.items() if k != SELF} == origin['runtime_source_sha256']
    allowed = {'schema', 'groups', 'runtime_source_sha256', 'original_family',
               'optimization_admission', 'builder_sha256', 'component_admission'}
    assert set(contract) - set(origin) == {'original_family', 'optimization_admission'}
    assert {k: v for k, v in contract.items() if k not in allowed} == {
        k: v for k, v in origin.items() if k not in allowed}
    admission = contract['optimization_admission']
    assert admission['status'] == 'same_bc_profile_optimization_components_board_qualified'
    assert admission['whole_model_verified'] is False and admission['release_approved'] is False
    assert len(contract['groups']) == 4
    groups = []; replaced = []
    for index, (entry, old) in enumerate(zip(contract['groups'], origin['groups'])):
        if entry == old:
            groups.append(original_generator.decoder.groups[index])
        else:
            groups.append(load_optimized_group(entry, old)); replaced.append(entry['first'])
    assert replaced and admission['replaced_first_layers'] == replaced
    result = OfficialFullBpuGenerator(
        original_generator.vision, OfficialFullDecoder(groups), original_generator.vocabulary,
        original_generator.rope, original_generator.image_token_index, original_generator.token_ids)
    assert len(result.specs) == 76 and len({str(s.path.resolve()) for s in result.specs}) == 46
    return result, contract
