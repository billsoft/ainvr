"""Configuration protocol regression with an isolated fake center; BPU stays unloaded."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def main(restart=False):
    key, admin, token = [secrets.token_hex(32) for _ in range(3)]
    config = dict(enabled=restart, listen=dict(host='127.0.0.1', port=8300),
                  api_keys=[dict(name='test-caller', scope='inference', key=key)], admin_key=admin,
                  model=dict(package_id='qwen3vl-4b-review-v3', load_policy='resident', ion_reserve_mb=512),
                  tasks={'alarm-review-zh-v1': dict(calibration_temperature=1., aspect_policy='reject')},
                  scheduling=dict(queue_size=8, queue_timeout_s=30, exec_timeout_s=10,
                                  submit_time_share_cap_percent=40, prefill_profile='s256'),
                  logging=dict(record_requests=False))
    lock = threading.Lock()
    state = dict(version=1, report={})

    class Center(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_request(self):
            if self.headers.get('x-service-token') != token:
                self.send_error(401)
                return
            with lock:
                if self.command == 'POST':
                    state['report'] = json.loads(self.rfile.read(int(self.headers['content-length'])))
                    data = {}
                elif '/snapshot?' in self.path:
                    data = [dict(service='llm-service', group='system', name='settings', config=config)]
                else:
                    data = dict(desiredVersion=state['version'], appliedVersion=1 if restart else None)
                payload = json.dumps(dict(code=0, data=data)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = handle_request
        do_POST = handle_request

    center = ThreadingHTTPServer(('127.0.0.1', 0), Center)
    thread = threading.Thread(target=center.serve_forever)
    thread.start()
    process = None
    peer = None
    try:
        if restart:
            import sys
            sys.path.insert(0, str(ROOT/'ai-service/runtime'))
            from large_model_reservation import LargeModelReservation
            peer = LargeModelReservation()
        with tempfile.TemporaryDirectory(prefix='ainvr-llm-config-') as tmp:
            bootstrap = Path(tmp)/'bootstrap.json'
            bootstrap.write_text(json.dumps(dict(control_url=f'http://127.0.0.1:{center.server_port}', service_token=token)))
            bootstrap.chmod(0o600)
            with (ROOT/'test/results/llm-service-development/config-roundtrip.log').open('w') as log:
                process = subprocess.Popen(['/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service', '--bootstrap', str(bootstrap)],
                                           stdout=log, stderr=subprocess.STDOUT)

                def wait_report(status, applied):
                    deadline = time.monotonic()+20
                    while time.monotonic() < deadline:
                        assert process.poll() is None, 'isolated service exited'
                        with lock:
                            report = state['report'].copy()
                        if report.get('status') == status and report.get('appliedVersion') == applied:
                            return
                        time.sleep(.1)
                    raise AssertionError(f'expected {status} at version {applied}')

                if restart:
                    wait_report('failed', None)
                    req=urllib.request.Request('http://127.0.0.1:8300/v1/admin/load',data=b'{}',headers={'Authorization':'Bearer '+admin,'Content-Type':'application/json'})
                    with urllib.request.urlopen(req,timeout=5) as response:
                        assert response.status==202, 'management authentication lost after restart failure'
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        with urllib.request.urlopen('http://127.0.0.1:8300/health',timeout=3) as response:
                            fault=json.load(response)
                        if fault['model']=='fault':break
                        time.sleep(.2)
                    assert fault['last_error']=='large_model_busy'
                    with lock:
                        config['enabled']=False
                        state.update(version=2, report={})
                    wait_report('applied',2)
                    report=dict(passed=True,restart_fault_management_retained=True,disabled_applied=True)
                    (ROOT/'test/results/llm-service-development/config-restart-fault.json').write_text(json.dumps(report,indent=2))
                    print(json.dumps(report));return
                wait_report('applied', 1)
                with lock:
                    config['admin_key'] = key  # Duplicate keys must fail without replacing v1.
                    state.update(version=2, report={})
                wait_report('failed', 1)
                with lock:
                    config['admin_key'] = admin
                    config['tasks']['alarm-review-zh-v1']['calibration_temperature'] = 2.
                    state.update(version=3, report={})
                wait_report('applied', 3)
                with urllib.request.urlopen('http://127.0.0.1:8300/health', timeout=3) as response:
                    health = json.load(response)
                assert health['model'] == 'unloaded' and health['config_version'] == 3
                # Loading while a cooperating peer holds the lock must fail,
                # retry must reach the loader, and disabling the fault must apply.
                import sys
                sys.path.insert(0, str(ROOT/'ai-service/runtime'))
                from large_model_reservation import LargeModelReservation
                peer = LargeModelReservation()
                try:
                    with lock:
                        config['enabled'] = True
                        state.update(version=4, report={})
                    wait_report('failed', 3)
                    request = urllib.request.Request('http://127.0.0.1:8300/v1/admin/load', data=b'{}', headers={'Authorization':'Bearer '+admin, 'Content-Type':'application/json'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        assert response.status == 202
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        with urllib.request.urlopen('http://127.0.0.1:8300/health', timeout=3) as response:
                            fault = json.load(response)
                        if fault['model']=='fault' and fault['last_error']=='large_model_busy':break
                        time.sleep(.2)
                    assert fault['model'] == 'fault' and fault['last_error'] == 'large_model_busy', fault
                    with lock:
                        config['enabled'] = False
                        state.update(version=5, report={})
                    wait_report('applied', 5)
                    with urllib.request.urlopen('http://127.0.0.1:8300/health', timeout=3) as response:
                        disabled = json.load(response)
                    assert disabled['model'] == 'unloaded' and not disabled['last_error']
                finally:
                    peer.close()
                report = dict(passed=True, versions=[1, 2, 3, 4, 5], failed_version_retained_previous=True, fault_retry=True, disable_fault_applied=True, model_loaded=False)
                (ROOT/'test/results/llm-service-development/config-roundtrip.json').write_text(json.dumps(report, indent=2))
                print(json.dumps(report))
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if peer:peer.close()
        center.shutdown()
        center.server_close()
        thread.join()


if __name__ == '__main__':
    main()
    main(restart=True)
