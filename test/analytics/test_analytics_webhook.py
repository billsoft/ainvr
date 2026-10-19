"""Loopback-only notification transport acceptance; no external delivery."""
import http.server
import json
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
requests = []
class Receiver(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append((self.path, self.headers.get('Idempotency-Key'), body))
        count = sum(row[0] == self.path for row in requests)
        status = 500 if self.path == '/retry' and count == 1 else 200
        if self.path == '/bad': status = 400
        if self.path == '/redirect': status = 302
        if self.path == '/slow': time.sleep(1)
        self.send_response(status)
        if status == 302: self.send_header('Location', '/must-not-follow')
        self.end_headers()
        try: self.wfile.write(b'x' * (16384 if self.path == '/large' else 2))
        except (BrokenPipeError, ConnectionResetError): pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = 'http://127.0.0.1:' + str(server.server_port)
binary = ROOT / 'test/results/analytics/webhook-probe'
def run(path, review='approved', timeout=4000, absolute=False):
    process = subprocess.run([str(binary), path if absolute else base+path, review, str(timeout)],
                             text=True, capture_output=True, timeout=10, check=True)
    return json.loads(process.stdout)
try:
    result = run('/retry')
    assert result['status'] == 'sent' and result['details']['attempts'] == 2
    first, second = requests[:2]
    assert first == second and first[1] == 'notification-fixture-1'
    assert 'secret' not in first[2] and 'review_request' not in first[2] and 'review_job' not in first[2]
    assert first[2]['review'] == {'scope':'target_presence','temporal_rule_verified':False}
    before = len(requests)
    for review in ['rejected','timeout','failed','unavailable','pending']:
        assert run('/denied', review)['details']['attempts'] == 0
    assert len(requests) == before
    assert run('/bad')['details']['attempts'] == 1
    assert run('/redirect')['status'] == 'failed'
    assert not any(row[0] == '/must-not-follow' for row in requests)
    assert run('/large')['status'] == 'failed'
    assert run('/slow', timeout=100)['status'] == 'timeout'
    assert run('/cancelled', timeout=0)['status'] == 'timeout'
    assert not any(row[0] == '/cancelled' for row in requests)
    for endpoint in ['file:///tmp/no-send','http://user:password@127.0.0.1:1/hook',base+'/hook#fragment']:
        assert run(endpoint, absolute=True)['status'] == 'invalid'
    report = {'passed':True,'scope':'loopback HTTP retries, idempotency, review gate, redaction, redirects, response bound, deadlines, URL validation',
              'external_notifications_sent':False,'production_deployed':False}
    (ROOT/'test/results/analytics/webhook-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
finally:
    server.shutdown();server.server_close();thread.join(timeout=2)
