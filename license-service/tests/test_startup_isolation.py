"""Run against an explicitly supplied build; all state and credentials are temporary."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time

import pytest


@pytest.fixture
def daemon():
    binary = os.environ.get('LICENSE_TEST_BINARY')
    if not binary:
        pytest.skip('set LICENSE_TEST_BINARY to an isolated build')
    binary = str(Path(binary).resolve())
    code = subprocess.check_output([binary, '--machine-code'], text=True).strip().replace('-', '')
    with tempfile.TemporaryDirectory(prefix='lic-start-') as directory:
        root = Path(directory)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        config = dict(host='127.0.0.1', port=port, machine_code=code,
                      device_key=secrets.token_hex(32), admin_api_key=secrets.token_hex(32),
                      signal_keys={name: secrets.token_hex(32) for name in
                                   ('ai-service', 'recorder', 'console-backend', 'enforcer')},
                      uds_path=str(root/'s'), installation_path=str(root/'identity'),
                      state=dict(primary=str(root/'state'), replica2=str(root/'copy1'), replica3=str(root/'copy2')))
        path = root/'config'
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        with (root/'log').open('w') as log:
            process = subprocess.Popen([binary, '--config', str(path)], stdout=log, stderr=log)
            try:
                deadline = time.monotonic()+10
                while not (root/'s').exists():
                    assert process.poll() is None, 'isolated daemon exited'
                    assert time.monotonic() < deadline, 'isolated daemon startup timeout'
                    time.sleep(.05)
                yield binary, root, config, process
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)


def test_second_daemon_cannot_modify_shared_identity_with_different_state_and_key(daemon):
    binary, root, config, process = daemon
    before = (root/'identity').read_bytes()
    config['device_key'] = secrets.token_hex(32)
    config['state'] = {name: str(root/(name+'-other')) for name in config['state']}
    config['uds_path'] = str(root/'other-s')
    other = root/'other-config'
    other.write_text(json.dumps(config)); other.chmod(0o600)
    result = subprocess.run([binary, '--config', str(other)], capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert 'another license service owns the installation' in result.stderr
    assert (root/'identity').read_bytes() == before
    assert not list(root.glob('identity.invalid.*'))
    assert process.poll() is None
