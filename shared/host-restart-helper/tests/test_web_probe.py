import io
import socket
from urllib.error import HTTPError, URLError
import observability as ob

class Response(io.BytesIO):
    status = 200

class Opener:
    def __init__(self, body): self.body = body
    def open(self, url, timeout):
        assert url == 'http://127.0.0.1:8088/'
        assert timeout == 1.5
        return Response(self.body)

def test_frontend_probes_static_shell_without_api(monkeypatch):
    monkeypatch.setattr(ob, 'build_opener', lambda *args: Opener(b'<script type="module" src="/assets/a.js"></script><div id="root"></div>'))
    assert ob.frontend_health()

def test_default_nginx_or_error_page_is_not_healthy(monkeypatch):
    monkeypatch.setattr(ob, 'build_opener', lambda *args: Opener(b'<html>Welcome to nginx</html>'))
    assert not ob.frontend_health()

def test_probe_error_is_specific_and_does_not_leak_url():
    assert 'HTTP 502' in ob.probe_failure(HTTPError('http://secret:password@host',502,'bad',{},None),'HTTP')
    assert 'password' not in ob.probe_failure(HTTPError('http://secret:password@host',502,'bad',{},None),'HTTP')
    assert '超时' in ob.probe_failure(URLError(socket.timeout()),'HTTP')
    assert '连接被拒绝' in ob.probe_failure(URLError(ConnectionRefusedError()),'HTTP')
