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
