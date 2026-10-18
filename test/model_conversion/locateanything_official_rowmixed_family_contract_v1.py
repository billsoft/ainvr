"""Complete36-layer diagnostic composition with the actually verified first9 mixed layers. Remaining3 groups stay explicit W8;not the final compact model."""
from pathlib import Path, PurePosixPath
import argparse, json, os, time
from locateanything_official_family_contract_v1 import BASE, RESULTS, CODE, checked, read_json, digest, verified, program
from locateanything_official_family_dispatch_v3 import load_official_generator as load_parent

SELF = 'locateanything_official_rowmixed_family_contract_v1.py'
SCHEMA = 'locateanything_official_rowmixed_diagnostic_family_v1'
ARCHITECTURE = 'original36_qwen_moonvit27_shared_programs'
PARENT = BASE / 'official-full-family-w8a16-o2-all-ar-head-v1.json'
PARENT_SHA = 'fd3e01f51bc36edaa62b3f5f45fc8507f03ae263ed53420fbc3df3cfb1fed042'
PACKAGE = BASE / 'official-rowmixed-group0-diagnostic-v6'
MANIFEST_SHA = 'c22bd8ee08f668c54520c252e0d00f5ffb90c1c4851d4c8bea9f07f2920f976f'
HBM_SHA = '9edabbcf1a9b55045577f6e96afe16dd836f7238223e9dee31f66c374d5e13f7'
GUARD = RESULTS / 'official-rowmixed-group0-diagnostic-v6-board-guard-v1.json'
GUARD_SHA = 'd3258a72d15962fc160e3896eec1c9c983bfb5012eabe43f5acea2ba20057175'
BOARD_SHA = '96b2c0bfc58b95aaec378c79008bce071c6dd52f942431a57aa91eeb75798c7e'
PINS = {'locateanything_official_family_dispatch_v3.py': 'ac1c51e1c6f4f2bc58ce7194d5b29258bc6483f42f77b39985037b65d63189e3',
        'locateanything_official_family_contract_v1.py': '94988129e3da8c7849316ef3f8ff372464418cdee809c32333e53927333d8c5f'}
COMPOSITION = dict(text_layers=36, vision_blocks=27, vocabulary=152681,
                   logical_programs=76, physical_hbms=46,
                   mixed_mlp_first_layers=[0], unchanged_w8_first_layers=[9, 18, 27],
                   attention_weight_bits=8, selected_mlp_weight_bits=4,
                   logical_decode_rows=1, prefill_rows=256, kv_capacity=512,
                   complete_compact_candidate=False)


def source_pins():
    return {SELF: digest(CODE / SELF), **PINS}


def load_verified_mixed_group():
    from locateanything_official_family_v1 import OfficialDecoderGroup
    root = checked(PACKAGE)
    assert digest(root / 'manifest.json') == MANIFEST_SHA
    manifest = read_json(root / 'manifest.json')
    assert manifest['schema'] == 'locateanything_rowmixed_diagnostic_board_v1'
    assert manifest['release_approved'] is False and manifest['whole_model_verified'] is False
    assert manifest['original_bf16_component_screen_passed'] is False and manifest['prepared_f32_component_screen_passed'] is False
    assert len(manifest['files']) == 484
    for name, entry in manifest['files'].items():
        n = PurePosixPath(name)
        assert not n.is_absolute() and '..' not in n.parts and '.' not in n.parts
        path = checked(root / name)
        assert path.is_relative_to(root) and path.is_file() and path.stat().st_size == entry['bytes']
        if path.suffix not in ['.hbm', '.npy']:
            assert digest(path) == entry['sha256']
    assert manifest['files']['model.hbm']['sha256'] == HBM_SHA == manifest['hbm_sha256']
    source = read_json(root / 'source-status.json')
    assert digest(root / 'source-status.json') == manifest['source_status_sha256']
    assert source['source_sha256'] == 'f0ab89d7d91715f96338a4b6bfbe85bca11c23ac5732b95f33aba8f3a41dc878'
    assert source['status'] == 'compiled_diagnostic_mixed_group_bpu_only_not_quality_approved'
    assert source['release_approved'] is False and source['whole_model_verified'] is False
    assert source['bpu_only'] and source['compact_static_component_screen_passed']
    assert source['original_bf16_component_screen_passed'] is False and source['prepared_f32_component_screen_passed'] is False
    assert source['admission']['candidate_manifest_sha256'] == 'd1c52be06fdd5a0a011f71d0155076ee1fffa463b8b3da7d6d92a1f4e391e316'
    assert digest(root / 'reference-status.json') == 'f33382f4c11f11bd29c824391d7fb91de531b2d539b5845717cd01efa7d6a52e'
    reference = read_json(root / 'reference-status.json')
    assert reference['first'] == 0 and reference['layer_count'] == 9
    assert reference['attention_weight_bits'] == 8 and reference['mlp_weight_bits'] == 4
    assert reference['new_activation_calibration_calls'] == 0 and reference['original_norm_epsilon_preserved']
    assert set(reference['original_parameter_hashes']) == {str(i) for i in range(9)}
    assert len(reference['weight_modules']) == 27 and len(reference['ranges']) == 468
    assert digest(GUARD) == GUARD_SHA and digest(root / 'board-proof-v1.json') == BOARD_SHA
    guard, hardware = read_json(GUARD), read_json(root / 'board-proof-v1.json')
    assert guard['status'] == 'completed_parity_diagnostic_not_quality_admission'
    assert guard['production_unchanged_and_fresh'] and guard['hardware_report_sha256'] == BOARD_SHA
    assert guard['hardware'] == hardware and guard['manifest_sha256'] == MANIFEST_SHA
    assert guard['worker_sha256'] == 'fad66df618c4902940b501b44f308cfeee5eebd54684c761a1f8e090cf68fa7a'
    assert hardware['status'] == 'completed_compiler_parity_only_not_quality_admission'
    assert hardware['board_calls'] == 96 and hardware['all_outputs_compiler_byte_exact'] and hardware['all_models_released']
    assert hardware['hbm_sha256'] == HBM_SHA and hardware['release_approved'] is False
    assert sum(len(p['comparisons']) for p in hardware['profiles']) == 152
    metadata = dict(path=str(root / 'disas.json'), sha256=manifest['files']['disas.json']['sha256'])
    profiles = {}
    for profile in manifest['profiles']:
        q = profile['sequence_capacity']
        assert q in [1, 256] and len(profile['cases']) == 4
        kind = 'ar' if q == 1 else 'prefill'
        assert kind not in profiles
        ports = profile['ports']
        profiles[kind] = program(f'decoder-group-00-08-{kind}', root / 'model.hbm', HBM_SHA, metadata,
                                 ports['name'], ports['inputs'], ports['outputs'], ['float32']*22, ['float32']*19)
    return OfficialDecoderGroup(0, 8, profiles)


def load_official_generator(path, expected_sha256):
    path = checked(path)
    assert digest(path) == expected_sha256
    c = read_json(path)
    assert set(c) == {'schema', 'architecture', 'evaluation_only', 'release_approved', 'whole_model_verified',
                      'complete_compact_candidate', 'parent_family', 'mixed_group', 'runtime_source_sha256',
                      'builder_sha256', 'composition', 'quality_scope'}
    assert c['schema'] == SCHEMA and c['architecture'] == ARCHITECTURE
    assert c['evaluation_only'] is True and c['release_approved'] is False and c['whole_model_verified'] is False
    assert c['complete_compact_candidate'] is False and c['composition'] == COMPOSITION
    assert c['quality_scope'] == 'Diagnostic first-group substitution;not final mixed64/independent160 acceptance'
    assert c['runtime_source_sha256'] == source_pins() and c['builder_sha256'] == digest(CODE / SELF)
    for name, pin in PINS.items():
        assert digest(CODE / name) == pin
    assert c['parent_family'] == dict(path=str(PARENT), sha256=PARENT_SHA)
    assert c['mixed_group'] == dict(first=0, last=8, root=str(PACKAGE), manifest_sha256=MANIFEST_SHA,
                                   proof=dict(path=str(GUARD), sha256=GUARD_SHA))
    parent, parent_contract = load_parent(PARENT, PARENT_SHA)
    from locateanything_official_family_v1 import OfficialFullDecoder, OfficialFullBpuGenerator
    groups = list(parent.decoder.groups)
    assert [(g.start, g.end) for g in groups] == [(0, 8), (9, 17), (18, 26), (27, 35)]
    groups[0] = load_verified_mixed_group()
    result = OfficialFullBpuGenerator(parent.vision, OfficialFullDecoder(groups), parent.vocabulary,
                                    parent.rope, parent.image_token_index, parent.token_ids)
    assert len(result.specs) == 76 and len({str(s.path.resolve()) for s in result.specs}) == 46
    assert {s.key for s in result.specs} == {s.key for s in parent.specs}
    replaced_keys = {s.key for s in groups[0].specs.values()}
    old_by_key = {s.key: s for s in parent.specs}
    for spec in result.specs:
        if spec.key not in replaced_keys:
            assert spec == old_by_key[spec.key]
    assert result.token_ids == parent.token_ids and result.image_token_index == parent.image_token_index
    return result, c


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', type=Path, required=True)
    a = p.parse_args()
    assert a.out.parent.resolve() == BASE and a.out.name == 'official-full-family-rowmixed-first0-research-v1.json'
    assert not a.out.exists()
    c = dict(schema=SCHEMA, architecture=ARCHITECTURE, evaluation_only=True, release_approved=False,
             whole_model_verified=False, complete_compact_candidate=False,
             parent_family=dict(path=str(PARENT), sha256=PARENT_SHA),
             mixed_group=dict(first=0, last=8, root=str(PACKAGE), manifest_sha256=MANIFEST_SHA,
                              proof=dict(path=str(GUARD), sha256=GUARD_SHA)),
             runtime_source_sha256=source_pins(), builder_sha256=digest(CODE / SELF),
             composition=COMPOSITION,
             quality_scope='Diagnostic first-group substitution;not final mixed64/independent160 acceptance')
    tmp = a.out.with_name(a.out.name + '.incoming-v1')
    assert not tmp.exists()
    tmp.write_text(json.dumps(c, indent=2) + '\n')
    pin = digest(tmp)
    try:
        generator, _ = load_official_generator(tmp, pin)
        os.chown(tmp, 1000, 1000)
        assert not a.out.exists()
        tmp.replace(a.out)
    except BaseException:
        tmp.rename(a.out.with_name(a.out.name + '.failed-' + str(time.time_ns())))
        raise
    print(json.dumps(dict(status='complete36_layer_diagnostic_contract_admitted_zero_nn_calls',
                          sha256=pin, logical_programs=len(generator.specs),
                          physical_hbms=len({str(s.path.resolve()) for s in generator.specs}),
                          replaced_first_layers=[0], complete_compact_candidate=False, release_approved=False)))


if __name__ == '__main__':
    main()
