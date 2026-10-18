"""Bounded actual GLES/JPU and isolated Mongo point snapshot contract acceptance.

Synthetic source pixels/point metadata;no neural inference or product deployment.
Only production AI may pause;finally requires fresh inference before completion.
"""
from pathlib import Path
import hashlib, importlib.util, json, os, pwd, re, signal, subprocess, time, traceback
import urllib.parse, urllib.request

ROOT = Path('/home/sunrise/ainvr')
RESULTS = ROOT / 'test/results'
REPORT = RESULTS / 'locateanything-point-archive-hardware-v3.json'
LOG = RESULTS / 'locateanything-point-archive-hardware-v3.log'
assert not REPORT.exists() and not LOG.exists()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
source = ROOT / 'test/ai_port/snapshot_hardware_archive_test.cpp'
assert sha(source) == 'd0461cf02842fb2d6f1cc23a4e426e1082d379b431619944299fb28e0de81361'
proxy_source = ROOT / 'test/ai_port/run_hardware_archive_validation.py'
assert sha(proxy_source) == 'bc6423dec97d40aeb36f7b03be2f41c611a84b31d9a6ef0c870a74e292f590e6'
manifest = json.loads((RESULTS / 'locateanything-point-snapshot-source-install-v2.json').read_text())
for item in manifest['files']: assert sha(ROOT / item['path']) == item['sha256']
for i in [22, 23]:
    guard = json.loads((RESULTS / f'locateanything-vision-stage{i:02d}-pause-v19.json').read_text())
    assert guard['status'] == 'completed' and guard['production_restored']
build = ROOT / 'out/build/ai-s100p'
binary = build / 'snapshot_hardware_archive_test'
assert binary.exists()
flags = (build / 'CMakeFiles/ainvr_reused_snapshot_store.dir/flags.make').read_text()
link = (build / 'CMakeFiles/snapshot_hardware_archive_test.dir/link.txt').read_text()
assert '-DAINVR_ARCHIVE_JPU=1' in flags and '_cpu_reference' not in link
key = json.loads((ROOT / 'data/ai/config_overlay.json').read_text())['server']['api_key']
channel = '2baec0a3-9941-47dc-b1bd-d3d284488097'
def snapshot():
    def get(path):
        req = urllib.request.Request('http://127.0.0.1:8000' + path, headers={'X-Api-Key': key})
        return json.load(urllib.request.urlopen(req, timeout=5))
    state = get('/api/v1/channels/' + channel)
    result = get('/api/v1/channels/' + channel + '/results/latest')
    return dict(checked=time.time(), inference_count=state['stats']['inference_count'],
                consecutive_errors=state['stats']['consecutive_errors'],
                latest_timestamp=result.get('result', {}).get('timestamp'))
def active(name):
    return subprocess.run(['systemctl', 'is-active', name], capture_output=True, text=True, timeout=10).stdout.strip()
record = dict(status='running', started=time.time(), scope=__doc__, neural_calls=0,
              whole_model_bpu_verified=False, production_installed=False,
              production_restored=False, recorder_ingest_miners_signalled=False,
              source_sha256=sha(source), proxy_source_sha256=sha(proxy_source),
              binary_sha256=sha(binary), wrapper_sha256=sha(Path(__file__)))
def persist():
    temp = REPORT.with_suffix('.json.tmp')
    temp.write_text(json.dumps(record, indent=2) + '\n'); temp.replace(REPORT)
def interrupted(signum, _): raise RuntimeError('Archive wrapper interrupted: ' + str(signum))
signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGHUP, interrupted)
child = None; ticks = None; proxy = None; was_active = False
password = None; uri = None; proxy_uri = None
def redact(text):
    for value in [uri, proxy_uri, password, urllib.parse.quote(password or '', safe='')]:
        if value: text = text.replace(value, '[redacted]')
    return text
def owned():
    try:
        a = Path(f'/proc/{child.pid}/stat').read_text().split(') ', 1)[1].split()
        return a[19] == ticks and int(a[2]) == child.pid
    except OSError: return False
try:
    was_active = active('ainvr-ai') == 'active'; assert was_active
    record['before'] = snapshot()
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip() or 'root'
    owner = pwd.getpwnam(user)
    scratch_parent = (ROOT / 'data/ai/test-runtime').resolve()
    scratch_parent.mkdir(parents=True, exist_ok=True)
    assert os.stat(scratch_parent).st_dev == os.stat('/mnt/ainvr-ssd').st_dev
    scratch = scratch_parent / ('locateanything-point-archive-v3-' + str(os.getpid()))
    scratch.mkdir(); control = scratch / 'proxy'; control.mkdir()
    assert os.statvfs(scratch).f_bavail * os.statvfs(scratch).f_frsize > 5 * 1024**3
    for p in [scratch, control]: os.chown(p, owner.pw_uid, owner.pw_gid)
    spec = importlib.util.spec_from_file_location('ainvr_point_archive_proxy_v3', proxy_source)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    proxy = module.MongoProxy(control)
    password = (ROOT / 'deploy/infra/secrets/mongo_admin_password').read_text().strip()
    prefix = 'mongodb://ainvr_admin:' + urllib.parse.quote(password, safe='') + '@127.0.0.1:'
    suffix = '/?authSource=admin&serverSelectionTimeoutMS=1500&connectTimeoutMS=500&socketTimeoutMS=2000'
    uri = prefix + '27017' + suffix; proxy_uri = prefix + str(proxy.port) + suffix
    env = dict(os.environ, AI_SERVICE_TEST_MONGO_URI=uri, AI_SERVICE_TEST_MONGO_PROXY_URI=proxy_uri,
               AINVR_ARCHIVE_PROXY_CONTROL=str(control), AINVR_ARCHIVE_TEST_ROOT=str(scratch),
               TMPDIR=str(scratch), GSETTINGS_BACKEND='memory', LD_LIBRARY_PATH='/usr/hobot/lib')
    record.update(scratch=str(scratch), execution_user=user, pause_started=time.time())
    persist()
    subprocess.run(['systemctl', 'stop', 'ainvr-ai'], check=True, capture_output=True, timeout=45)
    assert active('ainvr-ai') == 'inactive'
    launcher = ['runuser', '-u', user, '--'] if os.geteuid() == 0 and user != 'root' else []
    command = launcher + [str(binary), '--gtest_filter=HardwareArchive.Point*:HardwareArchive.InvalidPoint*']
    child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, start_new_session=True)
    ticks = Path(f'/proc/{child.pid}/stat').read_text().split(') ', 1)[1].split()[19]
    record.update(child_pid=child.pid, child_start_ticks=ticks, maximum_test_seconds=180); persist()
    try: output, _ = child.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        if owned(): os.killpg(child.pid, signal.SIGTERM)
        try: output, _ = child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            if owned(): os.killpg(child.pid, signal.SIGKILL)
            output, _ = child.communicate(timeout=10)
        LOG.write_text(redact(output)); raise RuntimeError('Owned archive test exceeded180seconds')
    LOG.write_text(redact(output))
    expected = {'HardwareArchive.PointOnlyFullContextMixedAndEmptyKeepExactGeometry',
                'HardwareArchive.PointContextMinimumJpuCanvasKeepsOriginalCoordinates',
                'HardwareArchive.PointPendingRestartReplayIsIdempotentAndKeepsQuery',
                'HardwareArchive.InvalidPointRejectsWholeMixedOfferBeforeAnyAdmission'}
    passed = set(re.findall(r'\[\s+OK\s+\]\s+(HardwareArchive\.[^\s]+)', output))
    record.update(test_exit_code=child.returncode, tests_passed=sorted(passed), log_sha256=sha(LOG))
    assert child.returncode == 0 and passed == expected and '[  SKIPPED ]' not in output
    record.update(status='passed', actual_point_mongo_record_verified=True,
                  actual_gles_jpu_point_snapshot_verified=True,
                  point_pending_recovery_and_idempotency_verified=True,
                  cpu_image_processing_calls=0, synthetic_fixture_only=True,
                  full_model_stream_acceptance=False)
except BaseException:
    record.update(status='failed', error=redact(traceback.format_exc()))
finally:
    try:
        if child is not None and child.poll() is None and owned():
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if owned(): os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
        if proxy is not None: proxy.close()
    finally:
        if was_active:
            try:
                subprocess.run(['systemctl', 'start', 'ainvr-ai'], check=True, capture_output=True, timeout=45)
                deadline = time.monotonic() + 40; first = None
                while time.monotonic() < deadline:
                    try:
                        current = snapshot()
                        if first is None: first = current
                        if (current['inference_count'] > first['inference_count'] and
                            current['consecutive_errors'] == 0 and current['latest_timestamp'] is not None and
                            time.time() - current['latest_timestamp'] < 10):
                            record.update(production_restored=True, after=current); break
                    except Exception: pass
                    time.sleep(.5)
                record['services_after'] = {n:active(n) for n in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
                assert record['production_restored'] and all(v == 'active' for v in record['services_after'].values())
            except BaseException: record.update(status='failed', restoration_error=redact(traceback.format_exc()))
            if 'pause_started' in record: record['pause_seconds'] = time.time() - record['pause_started']
        record['finished'] = time.time(); persist()
print(json.dumps({k:record.get(k) for k in ['status','tests_passed','production_restored','pause_seconds','error','restoration_error']}))
assert record['status'] == 'passed'
