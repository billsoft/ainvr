from types import SimpleNamespace
import pytest
from recorder import supervisor


def test_budget_configuration_is_explicit_and_validated(monkeypatch):
    monkeypatch.setenv("AINVR_RECORDER_BUFFER_MIB", "256")
    assert supervisor._memory_budget_bytes() == 256 << 20
    for bad in ("0", "31", "-1", "nan", "1.5", "65537", "", "２５６"):
        monkeypatch.setenv("AINVR_RECORDER_BUFFER_MIB", bad)
        with pytest.raises(ValueError):
            supervisor._memory_budget_bytes()


def test_retiring_and_running_queues_still_consume_budget(monkeypatch):
    monkeypatch.setattr(supervisor, "GLOBAL_BUFFER_BYTES", 256 << 20)
    s = supervisor.Supervisor.__new__(supervisor.Supervisor)
    old = SimpleNamespace(gate=SimpleNamespace(hard_cap=64 << 20, queued_bytes=96 << 20))
    s.retiring = {"old": SimpleNamespace(pipeline=old)}
    s.orphans = {}
    s.states = {"a": SimpleNamespace(proc=SimpleNamespace(gate=SimpleNamespace(hard_cap=128 << 20, queued_bytes=1)))}
    assert s._buffer_available(32 << 20)
    assert not s._buffer_available((32 << 20) + 1)
    status = s.memory_status()
    assert status["reserved_bytes"] == 224 << 20
    assert status["retiring_bytes"] == 96 << 20
    s.retiring.clear()
    assert s._buffer_available(128 << 20)
