"""Pre-neural negative controls using real baseline metadata + synthetic terminal.

These tests validate rejection logic only. They do not admit the current
unfinished compile,load a runtime,stop services,or prove candidate BPU output.
"""
from pathlib import Path
import copy
import json
import time

from locateanything_prefill_g27_admission_v235 import (
    AR_HBO_SHA, BASE, BASE_HBM_SHA, BASE_MANIFEST_SHA, BASE_STATUS_SHA,
    BC_SHA, COMPILER_SHA, ORIGIN_NAME, SDK_API_SHA, WATCHER_SHA,
    fixture_names, read, sha, validate_metadata,
)


def main():
    path = BASE / ORIGIN_NAME / 'manifest.json'
    assert sha(path) == BASE_MANIFEST_SHA
    manifest = read(path)
    old = manifest['source_status']
    profiles = manifest['profiles']
    pins = {name: manifest['files'][name]['sha256'] for name in fixture_names()}
    for row in old['profiles']:
        pins[f"s{row['sequence_capacity']}/ports.json"] = row['ports_sha256']
    candidate = dict(
        status='compiled_same_bc_prefill_o2_with_unchanged_AR_not_board_qualified',
        finished=1, pid=1, start_ticks='synthetic-worker', source_sha256=COMPILER_SHA,
        origin_status_sha256=BASE_STATUS_SHA, origin_hbm_sha256=BASE_HBM_SHA,
        prefill_bc_sha256=BC_SHA, unchanged_ar_hbo_sha256=AR_HBO_SHA,
        official_api_sha256=SDK_API_SHA, first=27, last=35, layer_count=9,
        profile_optimization={'1': 2, '256': 2}, recalibration_executed=False,
        weights_or_graph_changed=False, AR_recompiled=False, bpu_only=True,
        actual_board_verified=False, whole_model_verified=False,
        release_approved=False, compile_jobs=1, balance=100, max_l2m_size=0,
        hbm_sha256='a' * 64, hbm_bytes=1, disas_sha256='b' * 64,
        fixture_pins=pins,
    )
    guard = dict(status='completed_same_bc_prefill_g27_candidate_not_board_qualified',
                 finished=1, worker_returncode=0, source_sha256=COMPILER_SHA,
                 pid=9, start_ticks='synthetic-guard', worker_pid=1,
                 worker_start_ticks='synthetic-worker', hbm_sha256='a' * 64)
    terminal = dict(
        status='group18_packaged_group27_compiled_both_still_need_board_qualification',
        source_sha256=WATCHER_SHA, finished=1, pid=673254,start_ticks='20481896',
        group27_guard=copy.deepcopy(guard),child_pid=9,child_start_ticks='synthetic-guard',
        serial_compiling_group27_after_group18_exit_returncode=0,
        original_compiler_restarted=False,compile_progress_polling=False,
        quota_changed=False,production_services_modified=False,
        actual_board_verified=False,release_approved=False,
        group27_hbm_sha256='a'*64,group18_manifest_sha256='d'*64)
    disas = dict(graphs=[dict(name=p['name'], nodes=[dict(device='DEVICE_CATEGORY_BPU')])
                         for p in profiles])
    base = dict(candidate=candidate, baseline=old, guard=guard,
                terminal=terminal, profiles=profiles, disas=disas)
    validate_metadata(**copy.deepcopy(base))
    # Real fault classes at a model boundary: pending jobs,wrong provenance,
    # stale process reuse,CPU nodes,shape/KV mismatches,and forged approval.
    cases = [
        ('pending_guard', ['guard', 'status'], 'watching_owned_prefill_compile'),
        ('unfinished_guard', ['guard', 'finished'], None),
        ('worker_reused_PID', ['guard', 'worker_start_ticks'], 'different-start'),
        ('pending_observer', ['terminal', 'status'], 'waiting_exact_group18_compile_guard_pidfd'),
        ('observer_wrong_guard_PID',['terminal','child_pid'],2),
        ('observer_reused_guard_PID',['terminal','child_start_ticks'],'different-start'),
        ('wrong_observer_source',['terminal','source_sha256'],'c'*64),
        ('restarted_compile', ['terminal', 'original_compiler_restarted'], True),
        ('neural_CPU_node', ['disas', 'graphs', 0, 'nodes', 0, 'device'], 'DEVICE_CATEGORY_CPU'),
        ('empty_graph', ['disas', 'graphs', 0, 'nodes'], []),
        ('wrong_program', ['disas', 'graphs', 0, 'name'], 'other-group'),
        ('AR_recompiled', ['candidate', 'AR_recompiled'], True),
        ('wrong_quantized_BC', ['candidate', 'prefill_bc_sha256'], 'c' * 64),
        ('changed_AR_HBO', ['candidate', 'unchanged_ar_hbo_sha256'], 'c' * 64),
        ('mixed_SDK', ['candidate', 'official_api_sha256'], 'c' * 64),
        ('new_calibration', ['candidate', 'recalibration_executed'], True),
        ('changed_weights', ['candidate', 'weights_or_graph_changed'], True),
        ('wrong_group', ['candidate', 'first'], 0),
        ('premature_release', ['candidate', 'release_approved'], True),
        ('wrong_KV_capacity', ['profiles', 0, 'inputs', 4, 'shape'], [2, 256, 128]),
        ('wrong_prefill', ['profiles', 1, 'sequence'], 128),
        ('missing_fixture', ['candidate', 'fixture_pins'], {}),
        ('observer_wrong_HBM', ['terminal', 'group27_hbm_sha256'], 'c' * 64),
        ('serial_wrong_PID',['terminal','pid'],1),
        ('serial_reused_PID',['terminal','start_ticks'],'different-start'),
        ('parallel_compile',['terminal','compile_progress_polling'],True),
        ('quota_mutated',['terminal','quota_changed'],True),
        ('serial_child_failed',['terminal','serial_compiling_group27_after_group18_exit_returncode'],1),
    ]
    rejected = []
    for name, keys, value in cases:
        fixture = copy.deepcopy(base)
        node = fixture
        for key in keys[:-1]:
            node = node[key]
        node[keys[-1]] = value
        try:
            validate_metadata(**fixture)
        except (AssertionError, KeyError, StopIteration):
            rejected.append(name)
        else:
            raise AssertionError('Unsafe metadata admitted: ' + name)
    assert len(rejected) == len(cases)
    output = Path('/home/sunrise/ainvr/test/results/locateanything-prefill-g27-admission-controls-v237.json')
    assert not output.exists()
    r = dict(status='completed_metadata_controls_not_candidate_board_admission',
             created=time.time(), source_sha256=sha(__file__),
             admission_source_sha256=sha(Path(__file__).with_name('locateanything_prefill_g27_admission_v235.py')),
             baseline_manifest_sha256=BASE_MANIFEST_SHA,
             synthetic_terminal_positive_controls=1,
             negative_controls_rejected=rejected, neural_calls=0,
             service_operations=0, candidate_hardware_qualified=False,
             release_approved=False)
    output.write_text(json.dumps(r, indent=2) + '\n')
    print(json.dumps(r))


if __name__ == '__main__':
    main()
