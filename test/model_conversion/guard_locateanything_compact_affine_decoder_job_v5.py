"""Serialize an exact original compact decoder/profile compilation, without a time cap.

The optional predecessor is verified by PID/start ticks and producer identity.
Waiting does not allocate the model. Compilation uses one worker by default;
ordinary RAM protection remains in effect. No production or GPU model actions.
"""
from pathlib import Path
import argparse, hashlib, json, os, re, signal, subprocess, time, traceback

ROOT = Path('/work/official-llm-v1')
SOURCE = ROOT / 'official_build_compact_affine_decoder_group_v2_sdk448.py'
BUILDER_SHA = 'dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
RESUME_SHA = '5e3c31397ccd4b08f04cb34d47322415f937d53c65ca9f96f7873bdbaf692297'
ap = argparse.ArgumentParser()
ap.add_argument('--name', required=True)
ap.add_argument('--layers', type=int, choices=[1, 2, 9, 36], required=True)
ap.add_argument('--start-layer', type=int, required=True)
ap.add_argument('--seq', type=int, choices=[1, 12, 256], required=True)
ap.add_argument('--label', required=True)
ap.add_argument('--jobs', type=int, choices=[1, 2], default=1)
ap.add_argument('--after-guard', type=Path)
ap.add_argument('--after-pid', type=int)
ap.add_argument('--after-start-ticks')
args = ap.parse_args()
assert re.fullmatch('[a-z0-9-]+', args.name)
assert re.fullmatch('[a-z0-9-]+', args.label)
assert 0 <= args.start_layer and args.start_layer + args.layers <= 36
assert bool(args.after_guard) == bool(args.after_pid) == bool(args.after_start_ticks)
OUT = ROOT / (args.name + '-guard.json')
LOG = ROOT / (args.name + '.log')
TARGET = Path('/opt/locate-oellm-research-v1') / (
    f'compact-affine-{args.label}-decoder-group-{args.start_layer}-'
    f'{args.start_layer+args.layers-1}-s{args.seq}-v2-sdk448')
assert not OUT.exists() and not LOG.exists() and not TARGET.exists()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024**2), b''):
            h.update(block)
    return h.hexdigest()


def available():
    return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0]) * 1024


def identity(pid):
    path = Path(f'/proc/{pid}/stat')
    try:
        fields = path.read_text().rsplit(')', 1)[1].split()
    except FileNotFoundError:
        return None
    return fields[19], fields[0]


assert digest(SOURCE) == BUILDER_SHA
qualification = ROOT / 'locateanything-compact-affine-decoder-block-guard-v1.json'
assert digest(qualification) == '2d1ade9a24d3fed920d53396f94d30df6c7ede570cfcd16ecf9a7265ab109d4f'
proof = json.loads(qualification.read_text())
assert proof['status'] == 'completed' and proof['production_unchanged_and_fresh']
assert proof['hardware']['board_calls'] == 12
assert proof['hardware']['all_outputs_compiler_bitwise_exact']
assert proof['hardware']['all_models_released']
assert proof['hardware']['hbm_sha256'] == 'f3de3da70b2a26e504f6382014dfe57f89d99105df5ef97e1e3c2e29c354516a'
report = dict(status='starting', scope=__doc__, started=time.time(),
              source_sha256=digest(__file__), builder_sha256=BUILDER_SHA,
              guard_pid=os.getpid(), guard_start_ticks=identity(os.getpid())[0],
              qualification_sha256=digest(qualification), target=str(TARGET),
              layer_count=args.layers, start_layer=args.start_layer,
              sequence=args.seq, maximum_seconds=None, compile_jobs=args.jobs,
              ordinary_ram_floor_bytes=6*1024**3, production_actions=False,
              gpu_jobs_started=0, whole_model_verified=False, release_approved=False)
child = None
log = None
ticks = None


def save():
    temporary = OUT.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(OUT)


def stop_owned():
    if child is None or child.poll() is not None:
        return
    assert identity(child.pid)[0] == ticks and os.getpgid(child.pid) == child.pid
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)


def interrupted(*_):
    raise RuntimeError('Owned compact decoder compiler guard interrupted')


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    if args.after_guard:
        dependency = args.after_guard.resolve()
        assert dependency.parent == ROOT and dependency.name.endswith('-guard.json')
        assert digest(ROOT/'compile_locateanything_compact_saved_bc_v1.py') == RESUME_SHA
        report.update(status='waiting_for_predecessor', predecessor=dict(
            guard=str(dependency), pid=args.after_pid, start_ticks=args.after_start_ticks,
            expected_source_sha256=RESUME_SHA))
        save()
        while True:
            previous = json.loads(dependency.read_text())
            assert previous['source_sha256'] == RESUME_SHA
            assert previous['guard_pid'] == args.after_pid
            assert previous['guard_start_ticks'] == args.after_start_ticks
            current = identity(args.after_pid)
            if current is not None:
                assert current[0] == args.after_start_ticks, 'Predecessor PID was reused'
            alive = current is not None and current[1] not in ['Z', 'X']
            if not alive:
                assert previous['status'] in ['compiled_group', 'completed', 'failed']
                worker = identity(previous['child_pid'])
                if worker is not None:
                    assert worker[0] == previous['child_start_ticks']
                    assert worker[1] in ['Z', 'X'], 'Predecessor compiler is still live'
                report.update(predecessor_terminal_status=previous['status'],
                              predecessor_terminal_report_sha256=digest(dependency),
                              predecessor_finished=time.time())
                break
            time.sleep(3)
    report['status'] = 'waiting_for_preparation_headroom'
    save()
    while available() <= 14*1024**3:
        time.sleep(3)
    command = ['python3', '-u', str(SOURCE), '--layers', str(args.layers),
               '--start-layer', str(args.start_layer), '--seq', str(args.seq),
               '--checkpoint-manifest', '/opt/locate-gptq-checkpoint-v3-g32/manifest.json',
               '--checkpoint-sha256', '6fbd345d8e7e8b66d830bad4e68a806c4ccd36005192ae8593b27756e64d4825',
               '--label', args.label, '--jobs', str(args.jobs)]
    log = LOG.open('xb')
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                             start_new_session=True,
                             env=dict(os.environ, CUDA_VISIBLE_DEVICES=''))
    ticks = identity(child.pid)[0]
    report.update(status='running', child_pid=child.pid, child_start_ticks=ticks,
                  child_started=time.time(), minimum_available_bytes=available())
    save()
    while child.poll() is None:
        current = available()
        report['minimum_available_bytes'] = min(report['minimum_available_bytes'], current)
        assert current > 6*1024**3, 'Preserve6GiB ordinary RAM'
        time.sleep(3)
    report['child_returncode'] = child.returncode
    path = TARGET/'status.json'
    if path.exists():
        value = json.loads(path.read_text())
        report.update(result_status=value.get('status'), result_sha256=digest(path),
                      hbm_sha256=value.get('hbm_sha256'))
    assert child.returncode == 0 and report.get('result_status') == 'completed'
    assert value['bpu_only'] and len(value['selected_modules']) == args.layers*7
    assert all(m['bits'] == 4 for m in value['selected_modules'])
    assert digest(TARGET/'stack.hbm') == value['hbm_sha256']
    report.update(status='compiled_group', hbm_bytes=value['hbm_bytes'])
except BaseException:
    report.update(status='failed', error=traceback.format_exc())
finally:
    stop_owned()
    if log is not None:
        log.close()
    report.update(finished=time.time())
    save()
