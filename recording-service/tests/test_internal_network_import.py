import os
from pathlib import Path
import subprocess
import sys


def test_recorder_policy_can_import_without_app_side_effects(tmp_path):
    source = Path(__file__).resolve().parents[1] / 'src'
    environment = dict(os.environ, PYTHONPATH=str(source))
    result = subprocess.run([sys.executable, '-c',
        'from recorder.internal_network import NetworkPolicy; '
        'assert NetworkPolicy().allows("127.0.0.1")'],
        cwd=tmp_path, env=environment, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
