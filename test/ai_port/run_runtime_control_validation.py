#!/usr/bin/env python3
"""AINVR: copied configuration protocol and diagnostics in the real service build.

An isolated HTTP configuration-center fixture sends patches to the real service.
MongoDB checks are real read-only pings. Production configuration remains untouched.
"""
import copy
import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pwd
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]


class Center:
    def __init__(self, key):
        self.lock = threading.Lock()
        self.key = key
        self.version = 1
        self.patch = {}
        self.reports = []
        self.failed_ack = False

    def set(self, version, patch, failed_ack=False):
        with self.lock:
            self.version, self.patch, self.failed_ack = version, copy.deepcopy(patch), failed_ack

    def reports_for(self, version):
        with self.lock:
            return [copy.deepcopy(r) for r in self.reports if r['desired'] == version]


def wait(predicate, description, seconds=35):
    deadline = time.monotonic()+seconds
    while True:
        if predicate():
            print('PASS', description, flush=True)
            return
        assert time.monotonic() < deadline, 'Timeout: '+description
        time.sleep(.05)


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and os.geteuid() == 0
    result = ROOT/'test/results'/('runtime-control-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    result.mkdir(mode=0o700)
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(user); os.chown(result, account.pw_uid, account.pw_gid)
    build = Path(os.environ.get('AINVR_TEST_BUILD_DIR', ROOT/'out/build/ai-api-compat')).resolve()
    assert build.is_relative_to(ROOT/'out/build'), 'Build directory must stay in the AINVR build tree'
    suites = ['config_center_test', 'crash_handler_test', 'systemd_watchdog_test']
    with (result/'build.log').open('w') as log:
        subprocess.run(['cmake', '-S', str(ROOT/'ai-service'), '-B', str(build), '-DAINVR_S100P=ON', '-DBUILD_TESTING=ON'],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        subprocess.run(['cmake', '--build', str(build), '--target', *suites, 'ainvr_s100p_control_service', '-j2'],
            stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
    unit_results = []
    for suite in suites:
        with (result/(suite+'.log')).open('w') as log:
            subprocess.run(['runuser', '-u', user, '--', str(build/suite), '--gtest_output=xml:'+str(result/(suite+'.xml'))],
                env=dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib'), stdout=log, stderr=subprocess.STDOUT,
                check=True, timeout=90)
        tree = ET.parse(result/(suite+'.xml')).getroot()
        assert all(int(tree.attrib.get(k, '0')) == 0 for k in ['failures', 'errors', 'disabled'])
        assert not tree.findall('.//skipped')
        unit_results.append({'suite': suite, 'passed': int(tree.attrib['tests'])})
        print('PASS', suite, flush=True)

    production_files = [ROOT/'deploy/s100p/runtime/ai-service.json', ROOT/'data/ai/config_overlay.json']
    original_hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in production_files}
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0)); port = port_probe.getsockname()[1]
    original_key, rotated_key, service_key = [secrets.token_hex(32) for _ in range(3)]
    config = json.loads(production_files[0].read_text())
    config['channels'] = []
    config['server'] = {'host': '127.0.0.1', 'port': port, 'api_key': original_key}
    config['snapshot_store']['db_name'] = 'ainvr_runtime_boot_test'
    base, overlay = result/'base.json', result/'overlay.json'
    base.write_text(json.dumps(config)); overlay.write_text('{}')
    for p in [base, overlay]: os.chmod(p, 0o600); os.chown(p, account.pw_uid, account.pw_gid)
    archive_patch = {'snapshot_store': {'mongo_uri': config['snapshot_store']['mongo_uri'], 'db_name': 'ainvr_runtime_changed_test'}}
    center = Center(service_key); center.set(1, archive_patch)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            payload = json.dumps({'code': 0 if status == 200 else 1, 'data': data}).encode()
            self.send_response(status); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)

        def do_GET(self):
            if self.headers.get('X-Service-Token') != service_key:
                self.reply(403, {}); return
            with center.lock:
                if self.path == '/api/v1/config/service-states/ai-service':
                    data = {'desiredVersion': center.version}
                elif self.path.startswith('/api/v1/config/versions/') and self.path.endswith('/snapshot?service=ai-service'):
                    data = [{'service': 'ai-service', 'group': 'system', 'name': 'settings', 'config': center.patch}]
                else:
                    self.reply(404, {}); return
            self.reply(200, data)

        def do_POST(self):
            if self.headers.get('X-Service-Token') != service_key or self.path != '/api/v1/config/service-states/ai-service':
                self.reply(403, {}); return
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with center.lock:
                center.reports.append({'desired': center.version, 'body': body})
                failed = center.failed_ack
                center.failed_ack = False
            self.reply(500 if failed else 200, {})

    bff = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    bff_thread = threading.Thread(target=bff.serve_forever, daemon=True); bff_thread.start()
    notify_path = result/'watchdog.sock'
    notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); notify.bind(str(notify_path))
    os.chown(notify_path, account.pw_uid, account.pw_gid); os.chmod(notify_path, 0o600)
    notifications = []
    notify_stop = threading.Event()

    def receive():
        notify.settimeout(.1)
        while not notify_stop.is_set():
            try: notifications.append(notify.recv(1024).decode())
            except socket.timeout: pass

    notify_thread = threading.Thread(target=receive, daemon=True); notify_thread.start()
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib', CONFIG_CENTER_URL='http://127.0.0.1:'+str(bff.server_port),
        CONFIG_SERVICE_TOKEN_AI_SERVICE=service_key, CONFIG_CENTER_POLL='1', NOTIFY_SOCKET=str(notify_path), WATCHDOG_USEC='3000000')
    env.pop('WATCHDOG_PID', None)
    binary = build/'ainvr_s100p_control_service'

    def request(path, key=original_key):
        q = urllib.request.Request('http://127.0.0.1:'+str(port)+path, headers={'X-Api-Key': key})
        try:
            with urllib.request.urlopen(q, timeout=5) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as error: return error.code, json.load(error)

    def applied(version):
        try: return request('/health')[1]['config_center']['applied_version'] == version
        except (OSError, urllib.error.URLError): return False

    with (result/'service.log').open('w') as log:
        proc = subprocess.Popen(['runuser', '-u', user, '--', str(binary), str(base), str(overlay), str(ROOT/'ai-service'),
            str(ROOT/'deploy/s100p/runtime/ai-service.env')], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            wait(lambda: applied(1), 'real service applies Mongo settings and reports version 1')
            assert center.reports_for(1)[-1]['body']['restartRequired']
            assert json.loads(overlay.read_text())['snapshot_store']['db_name'] == 'ainvr_runtime_changed_test'
            assert request('/health')[1]['version'] == 'ainvr-s100p-reused-control-0.5'
            assert request('/health')[1]['media']['ffmpeg']['version'] == '8.1.2'
            center.set(2, archive_patch, failed_ack=True)
            wait(lambda: len(center.reports_for(2)) >= 1, 'configuration ACK failure observed')
            assert applied(1)
            wait(lambda: applied(2), 'same persisted Mongo settings retried after ACK failure')
            assert len(center.reports_for(2)) >= 2
            assert all(r['body']['restartRequired'] for r in center.reports_for(2))
            persisted = overlay.read_bytes()

            center.set(3, {'channels': []})
            wait(lambda: any(r['body']['status'] == 'failed' for r in center.reports_for(3)), 'channel writer boundary rejects configuration-center patch')
            assert overlay.read_bytes() == persisted and applied(2)
            assert center.reports_for(3)[-1]['body']['appliedVersion'] == 2

            rotated = dict(archive_patch, server={'api_key': rotated_key})
            center.set(4, rotated)
            wait(lambda: applied(4), 'runtime API credential changes through original configuration path')
            assert request('/api/v1/channels', original_key)[0] == 401
            assert request('/api/v1/channels', rotated_key)[0] == 200
            persisted = overlay.read_bytes()

            center.set(5, dict(rotated, server={'host': '0.0.0.0'}))
            wait(lambda: any(r['body']['status'] == 'failed' for r in center.reports_for(5)), 'deployment bind address is rejected')
            assert overlay.read_bytes() == persisted and applied(4)

            secret_marker = 'not-a-real-password-for-test'
            center.set(6, {'snapshot_store': {'mongo_uri': 'mongodb://test:'+secret_marker+'@127.0.0.1:9/'}})
            wait(lambda: any(r['body']['status'] == 'failed' for r in center.reports_for(6)), 'failed real Mongo connection does not persist candidate')
            rejected = center.reports_for(6)[-1]['body']
            assert secret_marker not in rejected['errorMessage'] and 'mongodb://' not in rejected['errorMessage']
            assert rejected['appliedVersion'] == 4 and overlay.read_bytes() == persisted and applied(4)

            center.set(7, rotated)
            wait(lambda: applied(7), 'configuration client recovers after rejected candidates')
            assert center.reports_for(7)[-1]['body']['restartRequired']
            wait(lambda: any('WATCHDOG=1' in n for n in notifications), 'real service control-plane heartbeat reaches notification socket')
            assert all(hashlib.sha256(p.read_bytes()).hexdigest() == original_hashes[str(p)] for p in production_files)
            summary = {'passed': True, 'unit_suites': unit_results, 'unit_tests_passed': sum(s['passed'] for s in unit_results),
                'service_callback_phases_passed': 7, 'mongo_validation': 'real read-only ping and failed socket connection',
                'restart_required_compared_with_boot': True, 'report_failure_retry_verified': True,
                'rejected_candidates_preserve_overlay': True, 'runtime_api_key_reload_verified': True,
                'failed_report_preserves_applied_version': True, 'error_messages_hide_mongo_credentials': True,
                'heartbeat_notifications': sum('WATCHDOG=1' in n for n in notifications),
                'production_config_unchanged': True, 'user_model_inference_verified': False,
                'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
        finally:
            if proc.poll() is None: proc.terminate()
            try: proc.wait(timeout=15)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)
            notify_stop.set(); notify_thread.join(timeout=2); notify.close()
            bff.shutdown(); bff.server_close(); bff_thread.join(timeout=2)
    assert proc.returncode in [0, -15]
    summary['isolated_process_stopped'] = True
    (result/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps(summary, indent=2)); print('RESULT', result)


if __name__ == '__main__':
    main()
