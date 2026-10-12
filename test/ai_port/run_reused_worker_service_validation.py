#!/usr/bin/env python3
"""AINVR: isolated original-controller/real-worker API acceptance, no inference."""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and os.geteuid() == 0
    result = ROOT/'test/results'/('reused-worker-service-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    result.mkdir()
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(user)
    os.chown(result, account.pw_uid, account.pw_gid)
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0))
        port = port_probe.getsockname()[1]
    # Independent archive namespace; this fixture never opens the user's input.
    config = json.loads((ROOT/'deploy/s100p/runtime/ai-service.json').read_text())
    overlay = json.loads((ROOT/'data/ai/config_overlay.json').read_text())
    channel = copy.deepcopy(overlay['channels'][0])
    channel['id'] = 'isolated-worker-service-test'
    channel['name'] = 'TEST ONLY'
    channel['manually_stopped'] = True
    channel['snapshot']['enabled'] = False
    channel['publish']['enabled'] = False
    channel['model']['provider'] = 'bpu'
    channel['model']['adapter'] = 'yolo26_bpu'
    channel['model']['path'] = 'missing-isolated-test-model.hbm'
    channel['stream']['url'] = 'rtmp://127.0.0.1:1935/live/never-open-worker-test'
    channel['stream']['protocol'] = 'rtmp'
    key = secrets.token_hex(32)
    config['server'] = {'host': '127.0.0.1', 'port': port, 'api_key': key}
    config['snapshot_store']['db_name'] = 'ainvr_worker_service_test_'+str(os.getpid())
    config['channels'] = [channel]
    base, overlay_path, runtime_env = result/'base.json', result/'overlay.json', result/'isolated.env'
    base.write_text(json.dumps(config)); overlay_path.write_text('{}')
    # Loading the license environment also exports its entries. Never give an
    # isolated control-service test the production configuration-center token.
    runtime_env.write_text('\n'.join(line for line in
        (ROOT/'deploy/s100p/runtime/ai-service.env').read_text().splitlines()
        if not line.startswith(('CONFIG_', 'NOTIFY_SOCKET=', 'WATCHDOG_'))) + '\n')
    for path in [base, overlay_path, runtime_env]:
        os.chmod(path, 0o600); os.chown(path, account.pw_uid, account.pw_gid)
    production_overlay = ROOT/'data/ai/config_overlay.json'
    production_before = production_overlay.read_bytes()
    original_base = base.read_bytes()
    headers = {'X-Api-Key': key, 'Content-Type': 'application/json'}

    def request(path, method='GET', body=None, authorized=True):
        data = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request('http://127.0.0.1:'+str(port)+path,
            method=method, headers=headers if authorized else {}, data=data)
        try:
            with urllib.request.urlopen(r, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    build = Path(os.environ.get('AINVR_TEST_BUILD_DIR', ROOT/'out/build/ai-api-compat')).resolve()
    assert build.is_relative_to(ROOT/'out/build'), 'Build directory must stay in the AINVR build tree'
    binary = build/'ainvr_s100p_control_service'
    with (result/'service.log').open('w') as log:
        isolated_env = {key: value for key, value in os.environ.items()
            if not key.startswith(('CONFIG_', 'WATCHDOG_')) and key != 'NOTIFY_SOCKET'}
        proc = subprocess.Popen(['runuser', '-u', user, '--', str(binary), str(base),
            str(overlay_path), str(ROOT/'ai-service'), str(runtime_env)],
            env=dict(isolated_env, LD_LIBRARY_PATH='/usr/hobot/lib'), stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic()+15
            while True:
                assert proc.poll() is None, 'Isolated service exited'
                try:
                    status, health = request('/health')
                    if status == 200 and health.get('business', {}).get('ready'):
                        break
                except (OSError, urllib.error.URLError):
                    pass
                assert time.monotonic() < deadline, 'Isolated service health/license timeout'
                time.sleep(.1)
            version_source=(ROOT/'ai-service/src/api/s100p_control_service.cpp').read_text()
            expected_version=re.search(r'kServiceVersion\s*=\s*"([^"]+)"',version_source).group(1)
            assert health['version'] == expected_version
            assert health['media']['ffmpeg']['version'] == '8.1.2'
            assert health['config_center']['enabled'] is False
            assert health['capabilities']['model_providers'] == ['bpu']
            assert request('/api/v1/channels', authorized=False)[0] == 401
            route = '/api/v1/channels/'+channel['id']
            assert request(route)[1]['state'] == 'idle'
            publish = {'enabled': True, 'target_url': 'rtmp://127.0.0.1:1935/live/isolated-worker-output-test'}
            status, saved = request(route+'/config', 'PUT', {'publish': publish})
            assert status == 200 and saved['channel']['state'] == 'idle'
            assert saved['channel']['config']['model']['path'] == channel['model']['path']
            persisted = overlay_path.read_bytes()
            status, error = request(route+'/config', 'PUT', {'publish': {'target_url': channel['stream']['url']}})
            assert status == 422 and persisted == overlay_path.read_bytes()
            status, error = request(route+'/start', 'POST', {})
            assert status == 422 and error['error']['code'] == 'bpu_model_not_ready'
            _, view = request(route)
            assert view['state'] == 'idle' and view['config']['manually_stopped']
            assert view['stats']['frame_count'] == 0 and view['stats']['inference_count'] == 0
            assert persisted == overlay_path.read_bytes() and original_base == base.read_bytes()
            assert production_before == production_overlay.read_bytes()
            summary = {'passed': True, 'authenticated_list': True, 'selected_output_save_http': 200,
                'source_output_loop_rejected': True, 'missing_hbm_start_http': status,
                'missing_hbm_error_code': error['error']['code'], 'operator_stop_preserved': True,
                'decoder_frames': 0, 'inference_count': 0, 'production_config_unchanged': True,
                'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                'worker_sha256': hashlib.sha256((ROOT/'ai-service/src/pipeline/reused_channel_worker.cpp').read_bytes()).hexdigest()}
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                # Only this Popen-owned isolated process is eligible for termination.
                proc.kill(); proc.wait(timeout=5)
    assert proc.returncode in [0, -15]
    summary['isolated_process_stopped'] = True
    (result/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps(summary, indent=2)); print('RESULT', result)


if __name__ == '__main__':
    main()
