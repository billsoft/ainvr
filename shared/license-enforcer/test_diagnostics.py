import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("enforcer_diagnostics_main", Path(__file__).with_name("main.py"))
enforcer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enforcer)


def test_stop_logs_decision_inputs_before_docker_call(caplog):
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        if "inspect" in args:
            return SimpleNamespace(returncode=0, stdout="true")
        assert "SRS permission action before stop" in caplog.text
        assert '"wall_sec":123' in caplog.text
        return SimpleNamespace(returncode=0)

    assert enforcer.reconcile(False, run=run, diagnostics=lambda: {"wall_sec": 123, "phase": "dormant"})
    assert calls[-1][1] == "stop"
    assert "returncode=0" in caplog.text


def test_permission_recovery_during_inspect_prevents_stale_stop():
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="true")

    assert enforcer.reconcile(False, run=run, allowed_now=lambda: True)
    assert len(calls) == 1
