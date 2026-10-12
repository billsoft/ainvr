import importlib.util
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("license_enforcer", Path(__file__).with_name("main.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_unlicensed_reconciles_every_time_and_never_touches_database():
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="true\n")
    assert module.reconcile(False, run)
    assert module.reconcile(False, run)
    assert sum("stop" in args for args in calls) == 2
    assert all(args[-1] == "ainvr-srs" for args in calls)
    assert all("postgres" not in " ".join(args) and "mongo" not in " ".join(args) for args in calls)


def test_failure_is_retryable():
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=1 if "stop" in args else 0, stdout="true\n")
    assert not module.reconcile(False, run)
    assert not module.reconcile(False, run)
    assert len(calls) == 4


# 未知状态不操作 SRS；明确失权停止，恢复仅处理执行器拥有的停止。

def test_valid_always_allows_the_business():
    assert module.desired_state("valid") is True


def test_starting_leaves_existing_business_alone():
    assert module.desired_state("starting") is None


def test_unknown_permission_does_not_stop_existing_business():
    assert module.desired_state("starting") is None
    assert module.desired_state("configuration_error") is None


def test_definite_negative_results_stop_immediately():
    for phase in ("dormant", "invalid"):
        assert module.desired_state(phase) is False, phase


def test_unknown_phase_has_no_lifecycle_action():
    assert module.desired_state("something-new") is None


def test_reconcile_with_none_does_nothing_and_succeeds():
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="true\n")
    assert module.reconcile(None, run) is True
    assert calls == []        # 一条 docker 命令都不发


def test_valid_does_not_restart_a_manually_stopped_container():
    assert module.reconcile(True, run=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not touch Docker")))


def test_only_an_owned_license_stop_is_resumed():
    calls, markers = [], []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="false\n")
    assert module.reconcile(True, run=run, resume_allowed=True,
                            on_started=lambda: markers.append("cleared"))
    assert calls[-1][1] == "start" and markers == ["cleared"]


def test_first_install_waits_for_license_then_starts_once(tmp_path, monkeypatch):
    monkeypatch.setattr(module, 'STOP_MARKER', tmp_path / 'stopped')
    monkeypatch.setattr(module, 'START_MARKER', tmp_path / 'start-pending')
    module.START_MARKER.write_text('awaiting-first-activation')
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout='false\n')
    assert module.reconcile(False, run=run, resume_allowed=True,
                            on_started=module.clear_start_intent)
    assert module.START_MARKER.exists()
    assert not any(c[1] == 'start' for c in calls)
    assert module.reconcile(True, run=run, resume_allowed=module.START_MARKER.exists(),
                            on_started=module.clear_start_intent)
    assert calls[-1][1] == 'start'
    assert not module.START_MARKER.exists()
    count = len(calls)
    module.reconcile(True, run=run, resume_allowed=False)
    assert len(calls) == count

def test_recovered_during_inspect_does_not_start_unowned_stop():
    calls=[]
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout="false")
    assert module.reconcile(False,run=run,allowed_now=lambda: True)
    assert len(calls)==1
