"""Third9 same-BC prefill metadata admission,without neural/service operations.

This group18 schema binds the actual minimal v197 observer,not invented fields.
Require the completed original guard AND exact pidfd observer,not a partial HBO.
The manifest is an input pinned by the caller,not evidence of hardware quality.
"""
from pathlib import Path
import hashlib
import json

BASE = Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
ORIGIN_NAME = 'official-qwen-group-18-26-w8a16-ar2-pref0-v2-board-package'
PACKAGE_NAME = 'prefill-g18-o2-v201-board-package'
BASE_MANIFEST_SHA = '7ec67f96d113493d2cf504ce8e43d374df9f53fcda927906701f7571fd33e8aa'
BASE_STATUS_SHA = 'f7d7b78189fe15b5e608a09ed0d40a0da9aaecf8e58f4a83e601f16bfc426c3c'
BASE_HBM_SHA = '5468d7fce1874606c32762926a2223ea8eebaf347a9afc42b5c314c2c6589f32'
BC_SHA = '4c96c2046273e242cb408a2900f6b8ca60657c5fc7c0ea48077a8ba0351d124b'
AR_HBO_SHA = '03dbeae1332728e5174f91f50d66e605e22949ac9c3831bf9a97cf3465094e41'
COMPILER_SHA = '5272bbdb1a33ac83ed3e38e4b5f40402e802c16a7f259a3968ad4936a8931127'
WATCHER_SHA = 'b728c27a0c90f3f5aa21b217ff983c185a09f6dbbe2a5dffa3c88509d9237fa3'
SDK_API_SHA = 'c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846'
SCHEMA = 'locateanything_same_bc_w8_prefill_group18_board_v3'
FILES = {'model.hbm', 'disas.json', 'candidate-status.json',
         'baseline-status.json', 'compile-guard.json', 'terminal-observer.json',
         'ports.json', 'same-bc-provenance.json'}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4194304), b''):
            h.update(block)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def fixture_names():
    return [f's{seq}/case-{case:02d}/{stem}-{i:02d}.npy'
            for seq in [1, 256] for case in range(4)
            for stem, count in [('input', 22), ('compiler', 19)]
            for i in range(count)]


def validate_metadata(candidate, baseline, guard, terminal, profiles, disas):
    """Pure metadata check; suitable for meaningful pre-neural negative controls."""
    c, b, g, t = candidate, baseline, guard, terminal
    assert b['status'] == 'compiled_original_group_shared_profiles_bpu_only'
    assert b['finished'] and b['bpu_only'] is True
    assert (b['first'], b['last'], b['layer_count']) == (18, 26, 9)
    assert (b['weight_bits'], b['attention_activation_bits']) == (8, 16)
    assert b['profile_optimization'] == {'1': 2, '256': 0}
    assert b['source_sha256'] == 'fafcbe8b4d9447ce10eb745f5c4ed1eba3c7edc267e5e96cd786f549a6ee5a8b'
    assert b['hbm_sha256'] == BASE_HBM_SHA
    assert b['recalibration_executed'] is False and b['weights_or_graph_changed'] is False
    assert b['neural_cpu_or_gpu_production_fallback'] is False
    assert c['status'] == 'compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified'
    assert c['finished'] and c['source_sha256'] == COMPILER_SHA
    assert c['origin_status_sha256'] == BASE_STATUS_SHA
    assert c['origin_hbm_sha256'] == BASE_HBM_SHA
    assert c['prefill_bc_sha256'] == BC_SHA
    assert c['unchanged_ar_hbo_sha256'] == AR_HBO_SHA
    assert c['official_api_sha256'] == SDK_API_SHA
    assert (c['first'], c['last'], c['layer_count']) == (18, 26, 9)
    assert c['profile_optimization'] == {'1': 2, '256': 2}
    assert c['recalibration_executed'] is False and c['weights_or_graph_changed'] is False
    assert c['AR_recompiled'] is False and c['bpu_only'] is True
    assert c['actual_board_verified'] is False
    assert c['whole_model_verified'] is False and c['release_approved'] is False
    assert (c['compile_jobs'], c['balance'], c['max_l2m_size']) == (1, 100, 0)
    assert g['status'] == 'completed_same_bc_prefill_g18_candidate_not_board_qualified'
    assert g['finished'] and g['worker_returncode'] == 0
    assert g['source_sha256'] == COMPILER_SHA
    assert g['worker_pid'] == c['pid'] and g['worker_start_ticks'] == c['start_ticks']
    assert g['hbm_sha256'] == c['hbm_sha256']
    assert t['status'] == 'terminal_compiled_same_bc_group18_not_board_qualified'
    assert t['source_sha256'] == WATCHER_SHA and t['finished']
    assert t['terminal_guard'] == g
    assert t['guard_pid'] == g['pid'] == 673205
    assert t['guard_start_ticks'] == g['start_ticks'] == '20248845'
    assert t['compile_restarted'] is False
    assert t['actual_board_verified'] is False and t['release_approved'] is False
    assert t['hbm_sha256'] == c['hbm_sha256']
    assert t['disas_sha256'] == c['disas_sha256']
    assert len(profiles) == 2 and {p['sequence'] for p in profiles} == {1, 256}
    assert len(b['profiles']) == 2
    for p in profiles:
        seq = p['sequence']
        assert p['name'] == f'locate_official_qwen_group_18_26_s{seq}'
        assert len(p['inputs']) == 22 and len(p['outputs']) == 19
        expected_in = [[seq, 2048], [seq, 128], [seq, 128], [seq, 512]] + [[2, 512, 128]] * 18
        expected_out = [[seq, 2048]] + [[2, seq, 128]] * 18
        assert [x['name'] for x in p['inputs']] == [f'_input_{i}' for i in range(22)]
        assert [x['name'] for x in p['outputs']] == [f'_output_{i}' for i in range(19)]
        assert [x['shape'] for x in p['inputs']] == expected_in
        assert [x['shape'] for x in p['outputs']] == expected_out
        old = next(x for x in b['profiles'] if x['sequence_capacity'] == seq)
        assert old['status'] == 'compiled_hbo' and len(old['regression']) == 4
        assert c['fixture_pins'][f's{seq}/ports.json'] == old['ports_sha256']
        if seq == 1:
            assert old['hbo_sha256'] == AR_HBO_SHA
        else:
            assert old['converted_bc_sha256'] == BC_SHA
    for name in fixture_names():
        value = c['fixture_pins'][name]
        assert isinstance(value, str) and len(value) == 64
    assert len(disas['graphs']) == 2
    assert {p['name'] for p in profiles} == {g['name'] for g in disas['graphs']}
    for graph in disas['graphs']:
        assert graph['nodes'] and all(n['device'] == 'DEVICE_CATEGORY_BPU' for n in graph['nodes'])


def admit(pin, base=BASE):
    """Read-only board entry: pin the package,then bind every file to old production."""
    package = base / PACKAGE_NAME
    origin = base / ORIGIN_NAME
    assert not package.is_symlink() and not origin.is_symlink()
    assert sha(package / 'manifest.json') == pin
    assert sha(origin / 'manifest.json') == BASE_MANIFEST_SHA
    m, old = read(package / 'manifest.json'), read(origin / 'manifest.json')
    assert m['schema'] == SCHEMA and (m['first'], m['last']) == (18, 26)
    assert m['admission_source_sha256'] == sha(__file__)
    assert m['compiler_source_sha256'] == COMPILER_SHA
    assert m['baseline_package'] == ORIGIN_NAME and m['baseline_manifest_sha256'] == BASE_MANIFEST_SHA
    assert m['baseline_hbm_sha256'] == BASE_HBM_SHA
    assert m['baseline_profile_optimization'] == {'1': 2, '256': 0}
    assert m['candidate_profile_optimization'] == {'1': 2, '256': 2}
    assert m['actual_board_verified'] is False and m['whole_model_verified'] is False and m['release_approved'] is False
    assert set(m['files']) == FILES
    for name, value in m['files'].items():
        p = package / name
        assert not p.is_symlink() and p.resolve().is_relative_to(package.resolve())
        assert p.stat().st_size == value['bytes'] and sha(p) == value['sha256']
    c, b, g, t = [read(package / n) for n in
                  ['candidate-status.json', 'baseline-status.json',
                   'compile-guard.json', 'terminal-observer.json']]
    profiles = read(package / 'ports.json')
    validate_metadata(c, b, g, t, profiles, read(package / 'disas.json'))
    assert b == old['source_status'] and profiles == old['profiles']
    assert sha(package / 'baseline-status.json') == BASE_STATUS_SHA
    assert sha(package / 'candidate-status.json') == g['worker_status_sha256'] == t['worker_status_sha256']
    assert sha(package / 'compile-guard.json') == t['terminal_guard_sha256']
    assert m['source_compile_guard_sha256'] == sha(package / 'compile-guard.json')
    assert m['source_terminal_observer_sha256'] == sha(package / 'terminal-observer.json')
    assert sha(package / 'model.hbm') == m['candidate_hbm_sha256'] == c['hbm_sha256']
    assert (package / 'model.hbm').stat().st_size == c['hbm_bytes']
    assert sha(package / 'disas.json') == c['disas_sha256']
    assert sha(origin / 'official-q8/model.hbm') == BASE_HBM_SHA
    provenance = read(package / 'same-bc-provenance.json')
    assert provenance == dict(unchanged_AR_HBO=AR_HBO_SHA, prefill_converted_BC=BC_SHA,
                              prefill_O2_HBO=c['prefill_hbo_sha256'],
                              quantization_source_status=BASE_STATUS_SHA,
                              fixture_sha256={n: c['fixture_pins'][n] for n in fixture_names()})
    for name in fixture_names():
        p = origin / name
        assert not p.is_symlink() and p.resolve().is_relative_to(origin.resolve())
        assert p.stat().st_size == old['files'][name]['bytes']
        assert sha(p) == old['files'][name]['sha256'] == c['fixture_pins'][name]
    return m, profiles
