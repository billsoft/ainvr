"""Package only a terminal same-BC group18 prefill candidate;never compile/deploy.

Large files stay on the owned D SSD. Baseline fixtures already on the board are
referenced by hash instead of copying hundreds of MB again. A newly created
package is not a BPU quality/speed approval. Invoke only after the exact terminal
observer has completed; pending guard/observer causes rejection before writes.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import sys
import time

from locateanything_prefill_g18_admission_v201 import (
    AR_HBO_SHA, BASE_HBM_SHA, BASE_MANIFEST_SHA, BASE_STATUS_SHA, BC_SHA,
    COMPILER_SHA, FILES, ORIGIN_NAME, PACKAGE_NAME, SCHEMA, WATCHER_SHA,
    fixture_names, read, sha, validate_metadata,
)

STAGE = Path('/work/official-llm-v1')
ORIGIN = Path('/opt/locate-official-qwen-group-18-26-w8a16-ar2-pref0-v2')


def main(check_only=False):
    compiler = STAGE / 'compile_locateanything_w8_prefill_g18_v187.py'
    assert sha(compiler) == COMPILER_SHA
    assert sha(STAGE / 'watch_locateanything_prefill_g18_terminal_v197.py') == WATCHER_SHA
    gpath = STAGE / 'official-w8-prefill-g18-o2-v187-guard.json'
    tpath = STAGE / 'official-w8-prefill-g18-terminal-v197.json'
    g, t = read(gpath), read(tpath)
    # No candidate files or output dirs are touched before both terminal gates.
    assert g['status'] == 'completed_same_bc_prefill_g18_candidate_not_board_qualified', 'Original compile guard is not completed'
    assert t['status'] == 'terminal_compiled_same_bc_group18_not_board_qualified', 'Exact terminal observer is not completed'
    from compile_locateanything_w8_prefill_g18_v187 import storage
    holder, large, source = storage()
    assert source == Path(g['output_directory'])
    out = large / PACKAGE_NAME
    assert not out.exists()
    c, b = read(source / 'status.json'), read(ORIGIN / 'status.json')
    assert sha(ORIGIN / 'status.json') == BASE_STATUS_SHA
    assert (source / 'origin-status.json').read_bytes() == (ORIGIN / 'status.json').read_bytes()
    assert sha(source / 'status.json') == g['worker_status_sha256'] == t['worker_status_sha256']
    assert sha(gpath) == t['terminal_guard_sha256'] and t['terminal_guard'] == g
    profiles = [dict(sequence=seq, **read(ORIGIN / f's{seq}/ports.json')) for seq in [1, 256]]
    disas = read(source / 'disas.json')
    validate_metadata(c, b, g, t, profiles, disas)
    assert sha(source / 'model.hbm') == c['hbm_sha256']
    assert (source / 'model.hbm').stat().st_size == c['hbm_bytes']
    assert sha(source / 'disas.json') == c['disas_sha256']
    assert sha(source / 's1/model.hbo') == sha(ORIGIN / 's1/model.hbo') == AR_HBO_SHA
    assert sha(source / 's256/converted.bc') == sha(ORIGIN / 's256/converted.bc') == BC_SHA
    assert sha(source / 's256/model.hbo') == c['prefill_hbo_sha256']
    assert sha(ORIGIN / 'model.hbm') == BASE_HBM_SHA
    for name, pin in c['fixture_pins'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert relative.parts[0] in ['s1', 's256']
        assert sha(ORIGIN / relative) == pin
    assert all(name in c['fixture_pins'] for name in fixture_names())
    # Output/TMP space only; no task/process/service or quota mutations.
    assert shutil.disk_usage(large).free > 12 * 1024 ** 3
    if check_only:
        print(json.dumps(dict(status='terminal_source_admitted_without_package_or_neural_calls',
                              source_status_sha256=sha(source / 'status.json'),
                              candidate_hbm_sha256=c['hbm_sha256'])))
        return
    provenance = dict(unchanged_AR_HBO=AR_HBO_SHA, prefill_converted_BC=BC_SHA,
                      prefill_O2_HBO=c['prefill_hbo_sha256'],
                      quantization_source_status=BASE_STATUS_SHA,
                      fixture_sha256={name: c['fixture_pins'][name] for name in fixture_names()})
    # Bind all small inputs before copying the immutable completed large HBM.
    small = {
        'disas.json': (source / 'disas.json').read_bytes(),
        'candidate-status.json': (source / 'status.json').read_bytes(),
        'baseline-status.json': (ORIGIN / 'status.json').read_bytes(),
        'compile-guard.json': gpath.read_bytes(),
        'terminal-observer.json': tpath.read_bytes(),
        'ports.json': (json.dumps(profiles, indent=2) + '\n').encode(),
        'same-bc-provenance.json': (json.dumps(provenance, indent=2) + '\n').encode(),
    }
    assert sha(gpath) == t['terminal_guard_sha256']
    assert sha(source / 'status.json') == g['worker_status_sha256']
    out.mkdir()
    for name, data in small.items():
        (out / name).write_bytes(data)
    hbmtemp = out / '.model.hbm.incoming'
    shutil.copyfile(source / 'model.hbm', hbmtemp)
    assert sha(hbmtemp) == c['hbm_sha256']
    hbmtemp.replace(out / 'model.hbm')
    assert {p.name for p in out.iterdir()} == FILES
    manifest = dict(
        schema=SCHEMA, created=time.time(), packager_source_sha256=sha(__file__),
        admission_source_sha256=sha(STAGE / 'locateanything_prefill_g18_admission_v201.py'),
        compiler_source_sha256=COMPILER_SHA, baseline_package=ORIGIN_NAME,
        baseline_manifest_sha256=BASE_MANIFEST_SHA, baseline_hbm_sha256=BASE_HBM_SHA,
        candidate_hbm_sha256=c['hbm_sha256'], first=18, last=26,
        baseline_profile_optimization={'1': 2, '256': 0},
        candidate_profile_optimization={'1': 2, '256': 2},
        files={p.name: dict(bytes=p.stat().st_size, sha256=sha(p)) for p in sorted(out.iterdir())},
        actual_board_verified=False, whole_model_verified=False, release_approved=False,
        output_windows='D:/codex-task-staging/ainvr-locateanything-w4/' + PACKAGE_NAME,
        source_compile_guard_sha256=sha(gpath), source_terminal_observer_sha256=sha(tpath),
        source_holder=holder,
    )
    temp = out / '.manifest.json.incoming'
    temp.write_text(json.dumps(manifest, indent=2) + '\n')
    temp.replace(out / 'manifest.json')
    print(json.dumps(dict(status='packaged_terminal_same_bc_group18_not_board_qualified',
                          manifest_sha256=sha(out / 'manifest.json'),
                          candidate_hbm_sha256=c['hbm_sha256'], output_directory=str(out))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-only', action='store_true')
    main(parser.parse_args().check_only)
