"""Verify the real BPU metric never borrows GPU values or hides bad samples."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
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
    with patch.object(ob, 'bpu_percent', return_value=28.0):
        sample, _ = observer.host()
    assert sample['bpuPercent'] == 28.0
    assert 'gpuPercent' in sample  # Existing API/history compatibility.
