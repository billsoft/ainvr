from recorder.write_diagnostics import cgroup_io, process_details


def test_short_pressure_episodes_share_process_log_budget(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import Mock
    from recorder import write_diagnostics as diagnostics
    clock = [0]

    async def sleep(_):
        clock[0] += 1
        if clock[0] > 65:
            raise asyncio.CancelledError

    async def snapshot(_):
        return {'processIO': [{'pid': 1}], 'cgroupIO': {'/test': {}}}

    monkeypatch.setattr(diagnostics.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(diagnostics.asyncio, 'sleep', sleep)
    monkeypatch.setattr(diagnostics.asyncio, 'to_thread', snapshot)
    logger = Mock()
    monkeypatch.setattr(diagnostics, 'log', logger)
    index = SimpleNamespace(io_snapshot=lambda: {'operationSeconds': 4 if clock[0] % 2 else 0})

    async def run():
        try:
            await diagnostics.monitor(SimpleNamespace(states={}), index)
        except asyncio.CancelledError:
            pass

    asyncio.run(run())
    detail_calls = [c for c in logger.warning.call_args_list
                    if c.args[0] == 'recording_pressure_process %s']
    assert len(detail_calls) == 2  # seconds 1 and 61, not every short incident


def test_missing_kernel_io_accounting_does_not_hide_blocked_stack(tmp_path):
    (tmp_path / 'stack').write_text('nvme_wait\next4_sync\n')
    details = process_details(tmp_path, True)
    assert details['ioUnavailable'] == 'FileNotFoundError'
    assert details['stack'] == ['nvme_wait', 'ext4_sync']


def test_running_process_does_not_require_kernel_stack(tmp_path):
    assert process_details(tmp_path, False) == {'ioUnavailable': 'FileNotFoundError'}


def test_service_io_counters_work_without_per_process_io(tmp_path):
    proc = tmp_path / 'proc'
    proc.mkdir()
    (proc / 'cgroup').write_text('0::/system.slice/recorder.service\n')
    root = tmp_path / 'cgroup'
    service = root / 'system.slice' / 'recorder.service'
    service.mkdir(parents=True)
    (service / 'io.stat').write_text('259:0 rbytes=12 wbytes=34 rios=1 wios=2\n')
    assert cgroup_io(proc, root) == ('/system.slice/recorder.service', {
        '259:0': {'rbytes': 12, 'wbytes': 34, 'rios': 1, 'wios': 2}})
    (proc / 'cgroup').write_text('0::/../../outside\n')
    assert cgroup_io(proc, root) is None
