"""Wait for the existing group18 observer, package it, then compile group27.

Exact pidfd events only; no compile progress polling or compiler restarts.
Both candidates still require real board parity, latency, whole-model and
native integration qualification. No board services, configuration or quotas
are changed by this PC continuation. Existing resource bounds stay in force.
"""
from pathlib import Path
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import time
import traceback

STAGE = Path('/work/official-llm-v1')
REPORT = STAGE / 'prefill-serial-continuation-v208.json'
PINS = {
    'watch_locateanything_prefill_g18_terminal_v197.py': 'b728c27a0c90f3f5aa21b217ff983c185a09f6dbbe2a5dffa3c88509d9237fa3',
    'compile_locateanything_w8_prefill_g18_v187.py': '5272bbdb1a33ac83ed3e38e4b5f40402e802c16a7f259a3968ad4936a8931127',
    'locateanything_prefill_g18_admission_v201.py': 'a2eff6223072b6c393e59f175158c3c17df779493afc6305071d4c611371cbc2',
    'prepare_locateanything_prefill_g18_board_v201.py': '42cf1008a8b2058f5556c122c09411336960ad2e73d2d74d93ed7d069d1bd59d',
    'compile_locateanything_w8_prefill_g27_v207.py': '301245b78fb9714a769eea34f90c87d3c2fb4a9ebac1dd48ab38b87db1fc50d3',
}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(4194304), b''):
            h.update(chunk)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def state(pid):
    try:
        values = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    except FileNotFoundError:
        return None
    return {'state': values[0], 'start_ticks': values[19]}


def require_terminal(terminal, guard):
    """Terminal metadata is checked in addition to waiting for the process."""
    assert terminal['status'] == 'terminal_compiled_same_bc_group18_not_board_qualified'
    assert terminal['source_sha256'] == PINS['watch_locateanything_prefill_g18_terminal_v197.py']
    assert terminal['pid'] == 673246 and terminal['start_ticks'] == '20354322'
    assert terminal['guard_pid'] == 673205 and terminal['guard_start_ticks'] == '20248845'
    assert terminal['compile_restarted'] is False
    assert terminal['actual_board_verified'] is False and terminal['release_approved'] is False
    assert terminal['terminal_guard'] == guard
    assert guard['status'] == 'completed_same_bc_prefill_g18_candidate_not_board_qualified'
    assert guard['pid'] == 673205 and guard['start_ticks'] == '20248845'
    assert guard['worker_pid'] == 673206 and guard['worker_start_ticks'] == '20249234'
    assert guard['source_sha256'] == PINS['compile_locateanything_w8_prefill_g18_v187.py']
    assert guard['worker_returncode'] == 0 and guard['finished'] >= guard['started']
    assert terminal['hbm_sha256'] == guard['hbm_sha256']
    assert terminal['worker_status_sha256'] == guard['worker_status_sha256']


def main():
    assert not REPORT.exists()
    for name, pin in PINS.items():
        assert sha(STAGE / name) == pin
    sys.path.insert(0, str(STAGE))
    from compile_locateanything_w8_prefill_g18_v187 import storage
    from locateanything_prefill_g18_admission_v201 import SCHEMA, FILES, PACKAGE_NAME
    holder, large, source = storage()
    result = dict(status='opening_existing_group18_observer_pidfd', started=time.time(),
                  pid=os.getpid(), start_ticks=state(os.getpid())['start_ticks'],
                  source_sha256=sha(__file__), source_pins=PINS, scope=__doc__,
                  original_compiler_restarted=False, compile_progress_polling=False,
                  quota_changed=False, production_services_modified=False,
                  actual_board_verified=False, release_approved=False,
                  observer_pid=673246, observer_start_ticks='20354322')
    child = None
    child_ticks = None
    descriptor = None

    def save():
        temporary = REPORT.with_name('.' + REPORT.name + '.incoming')
        temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
        temporary.replace(REPORT)

    def interrupted(*_):
        raise RuntimeError('Serial continuation interrupted;original compiler untouched')

    def execute(name, logname, phase):
        nonlocal child, child_ticks
        assert sha(STAGE / name) == PINS[name]
        with (STAGE / logname).open('xb') as log:
            child = subprocess.Popen([sys.executable, str(STAGE / name)],
                                     stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        child_ticks = state(child.pid)['start_ticks']
        result.update(status=phase, child_pid=child.pid, child_start_ticks=child_ticks,
                      child_source=name, child_source_sha256=PINS[name])
        save()
        returncode = child.wait()
        result[phase + '_returncode'] = returncode
        assert returncode == 0, phase + ' failed;not automatically restarted'
        child = None
        child_ticks = None

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    save()
    try:
        observed = state(673246)
        if observed is not None:
            assert observed['start_ticks'] == '20354322'
            if observed['state'] not in ['Z', 'X']:
                observer = STAGE / 'watch_locateanything_prefill_g18_terminal_v197.py'
                assert str(observer).encode() in Path('/proc/673246/cmdline').read_bytes().split(b'\0')
                descriptor = os.pidfd_open(673246)
                assert state(673246)['start_ticks'] == '20354322'
                result['status'] = 'waiting_exact_group18_terminal_event_no_progress_polling'
                save()
                poll = select.poll()
                poll.register(descriptor, select.POLLIN)
                poll.poll()
        terminal_path = STAGE / 'official-w8-prefill-g18-terminal-v197.json'
        guard_path = STAGE / 'official-w8-prefill-g18-o2-v187-guard.json'
        terminal, guard = read(terminal_path), read(guard_path)
        require_terminal(terminal, guard)
        assert sha(guard_path) == terminal['terminal_guard_sha256']
        for pid, ticks in [(673205, '20248845'), (673206, '20249234')]:
            current = state(pid)
            assert current is None or current['start_ticks'] != ticks or current['state'] in ['Z', 'X']
        assert sha(source / 'status.json') == terminal['worker_status_sha256']
        assert sha(source / 'model.hbm') == terminal['hbm_sha256']
        result['group18_terminal_sha256'] = sha(terminal_path)
        package = large / PACKAGE_NAME
        if not package.exists():
            execute('prepare_locateanything_prefill_g18_board_v201.py',
                    'prefill-g18-v201-event-package.log', 'packaging_group18_terminal_candidate')
        manifest = read(package / 'manifest.json')
        assert manifest['schema'] == SCHEMA and set(manifest['files']) == FILES
        assert manifest['packager_source_sha256'] == PINS['prepare_locateanything_prefill_g18_board_v201.py']
        assert manifest['admission_source_sha256'] == PINS['locateanything_prefill_g18_admission_v201.py']
        assert manifest['candidate_hbm_sha256'] == terminal['hbm_sha256']
        assert manifest['actual_board_verified'] is False and manifest['release_approved'] is False
        assert manifest['source_terminal_observer_sha256'] == sha(terminal_path)
        for name, info in manifest['files'].items():
            path = package / name
            assert path.parent == package and not path.is_symlink()
            assert path.stat().st_size == info['bytes'] and sha(path) == info['sha256']
        result.update(group18_package_directory=str(package),
                      group18_manifest_sha256=sha(package / 'manifest.json'),
                      group18_hbm_sha256=terminal['hbm_sha256'],
                      next_board_action='Host transfer then actual component192calls/3648arrays;no install')
        assert not (STAGE / 'official-w8-prefill-g27-o2-v207-guard.json').exists()
        execute('compile_locateanything_w8_prefill_g27_v207.py',
                'prefill-g27-v207-event-guard.log', 'serial_compiling_group27_after_group18_exit')
        from compile_locateanything_w8_prefill_g27_v207 import storage as storage27, BC_SHA, AR_HBO_SHA
        _, _, out27 = storage27()
        guard27_path = STAGE / 'official-w8-prefill-g27-o2-v207-guard.json'
        guard27 = read(guard27_path)
        assert guard27['status'] == 'completed_same_bc_prefill_g27_candidate_not_board_qualified'
        assert guard27['source_sha256'] == PINS['compile_locateanything_w8_prefill_g27_v207.py']
        assert guard27['worker_returncode'] == 0
        assert sha(out27 / 'status.json') == guard27['worker_status_sha256']
        raw27 = read(out27 / 'status.json')
        assert raw27['first'] == 27 and raw27['last'] == 35
        assert raw27['prefill_bc_sha256'] == sha(out27 / 's256/converted.bc') == BC_SHA
        assert raw27['unchanged_ar_hbo_sha256'] == sha(out27 / 's1/model.hbo') == AR_HBO_SHA
        assert sha(out27 / 'model.hbm') == raw27['hbm_sha256'] == guard27['hbm_sha256']
        assert sha(out27 / 'disas.json') == raw27['disas_sha256']
        graphs = read(out27 / 'disas.json')['graphs']
        assert {g['name'] for g in graphs} == {'locate_official_qwen_group_27_35_s1', 'locate_official_qwen_group_27_35_s256'}
        assert all(g['nodes'] and all(n['device'] == 'DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in graphs)
        result.update(status='group18_packaged_group27_compiled_both_still_need_board_qualification',
                      group27_guard_sha256=sha(guard27_path), group27_guard=guard27,
                      group27_hbm_sha256=raw27['hbm_sha256'])
    except BaseException:
        result.update(status='failed_serial_continuation_no_automatic_retry', error=traceback.format_exc())
    finally:
        if child is not None and child.poll() is None:
            try:
                assert state(child.pid)['start_ticks'] == child_ticks
                child.terminate()  # Only our new child guard;it owns its worker cleanup.
                child.wait(timeout=45)
            except BaseException:
                result['child_cleanup_error'] = traceback.format_exc()
        if descriptor is not None:
            os.close(descriptor)
        result['finished'] = time.time()
        save()
    print(json.dumps({key: result.get(key) for key in ['status', 'group18_manifest_sha256', 'group27_hbm_sha256', 'error']}))


if __name__ == '__main__':
    main()
