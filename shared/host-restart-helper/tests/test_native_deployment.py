"""Verify native service metrics and Docker discovery without touching services."""
import json
import os
from pathlib import Path
import subprocess
import sys
import observability as ob


def test_native_service_and_container_boundaries(monkeypatch):
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE', 'native')
    assert ob.deployment_units()['backend'] == 'ainvr-backend.service'
    assert ob.deployment_units()['frontend'] == 'ainvr-web.service'
    assert ob.deployment_units()['ai-service'] == 'ainvr-ai.service'
    assert set(ob.deployment_containers()) == {'srs', 'postgres'}


def test_native_infrastructure_is_discovered_without_duplicate_mongo(monkeypatch):
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE', 'native')
    calls = []
    details = [{'Id': name, 'Name': '/ainvr-' + name,
                'Config': {'Labels': {'com.docker.compose.service': name}},
                'State': {'Running': True}, 'HostConfig': {}}
               for name in ('srs', 'postgres', 'mongo')]
    def fake_run(args, **kwargs):
        calls.append(args)
        if args[:2] == ['docker', 'ps']:
            return 'mongo' if 'name=^/ainvr-mongo$' in args else 'srs postgres mongo'
        if args[:2] == ['docker', 'inspect']:
            assert args[2:] == ['srs', 'postgres', 'mongo']
            return json.dumps(details)
        return ''
    monkeypatch.setattr(ob, 'run', fake_run)
    rows, chosen = ob.Observer.containers(object())
    assert 'label=com.docker.compose.project=ainvr-infra' in calls[0]
    assert set(chosen) == {'srs', 'postgres', 'mongodb'}
    assert {r['id'] for r in rows} == {'srs', 'postgres', 'mongodb'}
    assert all(r['healthy'] for r in rows)


def test_restart_and_shutdown_use_same_deployment_unit():
    # Import in a fresh process so startup-time environment selection is tested.
    code = '''
import restart_helper as helper
from observability import deployment_units
unit = deployment_units()['ai-service']
assert helper.ALLOWED_TARGETS['ai-service'] == unit
step = helper.SHUTDOWN_SEQUENCE[1]
assert step['unit'] == unit
assert step['cmd'][-1] == unit
assert step['restore'][-1] == unit
print(unit)
'''
    for mode, expected in [('native', 'ainvr-ai.service'), ('docker', 'ai-service.service')]:
        result = subprocess.run([sys.executable, '-c', code],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, 'AINVR_DEPLOYMENT_MODE': mode},
            capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == expected


def test_alarm_metrics_and_logs_are_available_in_native_mode(monkeypatch):
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE','native')
    assert ob.deployment_units()['alarm-service'] == 'ainvr-alarm.service'
    assert 'alarm-service' in ob.SOURCES


def test_alarm_listener_uses_only_owned_loopback_socket_and_follows_custom_port(tmp_path):
    import os
    proc = tmp_path / '123'; (proc/'fd').mkdir(parents=True); (proc/'net').mkdir()
    os.symlink('socket:[900]', proc/'fd'/'4')
    header = 'sl local_address rem_address st tx_queue rx tr tm retr uid timeout inode'
    # Another process listener must not be mistaken for the alarm listener.
    (proc/'net'/'tcp').write_text(header+'\n0: 0100007F:2328 00000000:0000 0A 0:0 0:0 0 0 0 901\n1: 0100007F:2345 00000000:0000 0A 0:0 0:0 0 0 0 900\n')
    assert ob.alarm_health_url(123, tmp_path) == 'http://127.0.0.1:9029/readyz'
    (proc/'net'/'tcp').write_text(header+'\n0: 00000000:2345 00000000:0000 0A 0:0 0:0 0 0 0 900\n')
    import pytest
    with pytest.raises(ValueError): ob.alarm_health_url(123, tmp_path)
