"""Verify the real BPU metric never borrows GPU values or hides bad samples."""
import importlib.util
from pathlib import Path
from unittest.mock import patch, Mock
import pytest

spec = importlib.util.spec_from_file_location(
    'ainvr_observability_bpu_test',
    Path(__file__).resolve().parents[1] / 'shared/host-restart-helper/observability.py')
ob = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ob)


@pytest.mark.parametrize('raw,expected', [
    ('28\n', 28), ('0\n', 0), ('100\n', 100), ('35.5', 35.5),
    ('', None), ('unavailable', None), ('nan', None), ('inf', None),
    ('-1', None), ('101', None), ('1' * 129, None), ('28%', None),
])
def test_driver_sample_validation(raw, expected):
    with patch.object(Path, 'read_text', return_value=raw) as read:
        assert ob.bpu_percent() == expected
        read.assert_called_once()


def test_missing_driver_is_unavailable():
    with patch.object(Path, 'read_text', side_effect=FileNotFoundError):
        assert ob.bpu_percent() is None


def test_host_exposes_separate_bpu_field():
    observer = ob.Observer.__new__(ob.Observer)
    observer.previous = {}
    observer.bpu_sampler = Mock()
    observer.bpu_sampler.mean.return_value = 28.0
    sample, _ = observer.host()
    assert sample['bpuPercent'] == 28.0
    assert 'gpuPercent' in sample  # Existing API/history compatibility.


@pytest.mark.parametrize('phase', [0, .5, 1.5, 4.0, 8.0])
def test_periodic_inference_not_missed(phase):
    window = ob.BpuWindow()
    for n in range(41):
        stamp = n * .5
        window.add(stamp, 80.0 if (stamp-phase) % 10 < 2 else 0.0)
    assert window.mean(20) == 16.0


def test_idle_valid_zero():
    window = ob.BpuWindow()
    for n in range(21): window.add(n*.5, 0.0)
    assert window.mean(10) == 0.0


def test_missing_stale_and_empty_unavailable():
    window = ob.BpuWindow()
    for n in range(21): window.add(n*.5, None)
    assert window.mean(10) is None
    window = ob.BpuWindow()
    for n in range(21): window.add(n*.5, 80.0)
    assert window.mean(30) is None
    assert ob.BpuWindow().mean(10) is None


def test_partial_window_and_scheduler_gap_unavailable():
    window = ob.BpuWindow()
    for n in range(5): window.add(n*.5, 0.0)
    assert window.mean(2) is None
    window = ob.BpuWindow()
    window.add(0, 80.0)
    window.add(10, 0.0)
    assert window.mean(10) is None


def test_time_weighting():
    window = ob.BpuWindow()
    for n in range(21): window.add(n*.5, 20.0 if n < 10 else 60.0)
    assert window.mean(10) == 40.0
