"""Search process discovery/liveness only; no service or model is contacted."""
from pathlib import Path
from types import SimpleNamespace
import pytest
import observability as ob


def test_search_is_optional_and_native_only(monkeypatch):
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE', 'native')
    monkeypatch.setattr(Path, 'exists', lambda self: False)
    assert 'search-service' not in ob.deployment_units()
    monkeypatch.setattr(Path, 'exists', lambda self: str(self) == '/etc/systemd/system/ainvr-search.service')
    assert ob.deployment_units()['search-service'] == 'ainvr-search.service'
    assert len([key for key in ob.SOURCES if key == 'search-service']) == 1
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE', 'docker')
    assert 'search-service' not in ob.deployment_units()


@pytest.mark.parametrize('state,health,expected', [
    ('active', {'alive': True}, True),
    ('active', {'alive': True, 'ready': False, 'reason': 'disabled'}, True),
    ('inactive', {'alive': True}, False),
    ('failed', {'alive': True, 'ready': True}, False),
    ('active', {'alive': False, 'ready': True}, False),
    ('active', {'ready': True}, False),
    ('active', {'alive': 1}, False),
    ('active', None, False),
    ('active', [], False),
])
def test_search_liveness_is_not_model_readiness(state, health, expected):
    healthy, detail = ob.search_service_health(state, health)
    assert healthy is expected
    if expected:
        assert '进程存活' in detail and '智能搜索' in detail and '就绪' not in detail
    assert 'disabled' not in detail


def test_search_probe_never_displays_upstream_error():
    healthy, detail = ob.search_service_health('active', {'last_error': 'private secret/path'})
    assert not healthy and 'private' not in detail and 'secret' not in detail


def test_host_routes_search_to_fixed_public_liveness_probe(monkeypatch):
    monkeypatch.setattr(ob, 'deployment_units', lambda: {'search-service': 'ainvr-search.service'})
    def run(args, **kwargs):
        assert args == ['systemctl', 'show', 'ainvr-search.service', '--property=MainPID,ActiveState,NRestarts,Result']
        return 'MainPID=123\nActiveState=active\nNRestarts=0\nResult=success'
    monkeypatch.setattr(ob, 'run', run)
    calls = []
    def http(url):
        calls.append(url)
        return {'alive': True, 'ready': False}
    monkeypatch.setattr(ob, 'http_json', http)
    fixtures = {'/proc/stat': 'cpu 10 0 5 100 0 0 0 0\n',
                '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 900 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
                '/proc/net/dev': 'header\nheader\n'}
    def read(self, *args, **kwargs):
        if str(self) in fixtures: return fixtures[str(self)]
        raise OSError('fixture_unavailable')
    monkeypatch.setattr(Path, 'read_text', read)
    monkeypatch.setattr(Path, 'iterdir', lambda self: iter(()))
    monkeypatch.setattr(Path, 'glob', lambda self, pattern: iter(()))
    monkeypatch.setattr(ob.shutil, 'disk_usage', lambda path: SimpleNamespace(used=10, total=100))
    observer = SimpleNamespace(previous={}, bpu_sampler=SimpleNamespace(mean=lambda: None), cpu=lambda *args: None)
    _, rows = ob.Observer.host(observer)
    assert calls == ['http://127.0.0.1:8400/health']
    assert len(rows) == 1 and rows[0]['id'] == 'search-service' and rows[0]['healthy']
    assert '进程存活' in rows[0]['detail'] and '就绪' not in rows[0]['detail']
