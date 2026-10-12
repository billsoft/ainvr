"""Bounded, read-only incident snapshots; never read procfs in the recording loop."""
import asyncio
import json
import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)


def process_details(path, blocked):
    result = {}
    try:
        result['io'] = (path / 'io').read_text().splitlines()
    except OSError as error:
        result['ioUnavailable'] = type(error).__name__
    # Some Jetson kernels omit /proc/PID/io entirely. Still capture D-state stacks.
    if blocked:
        try:
            result['stack'] = (path / 'stack').read_text().splitlines()[:8]
        except OSError as error:
            result['stackUnavailable'] = type(error).__name__
    return result


def cgroup_io(path, root=Path('/sys/fs/cgroup')):
    """Block-cgroup counters remain available on kernels without task I/O accounting."""
    try:
        group = next(line[3:] for line in (path / 'cgroup').read_text().splitlines()
                     if line.startswith('0::'))
        directory = (root / group.lstrip('/')).resolve()
        if not directory.is_relative_to(root.resolve()):
            return None
        devices = {}
        for line in (directory / 'io.stat').read_text().splitlines():
            fields = line.split()
            devices[fields[0]] = {key: int(value) for key, value in
                                  (field.split('=', 1) for field in fields[1:])}
        return group, devices
    except (OSError, StopIteration, ValueError, IndexError):
        return None


def system_snapshot():
    result = {}
    for key, path in [('memory', '/proc/meminfo'), ('disks', '/proc/diskstats')]:
        try:
            lines = Path(path).read_text().splitlines()
            result[key] = [line for line in lines if (
                any(line.startswith(p) for p in ('Dirty:', 'Writeback:', 'MemAvailable:'))
                if key == 'memory' else 'nvme' in line)]
        except OSError as error:
            result[key] = type(error).__name__
    # Names and kernel wait sites only: never log argv, environment or secrets.
    result['processIO'] = []
    result['cgroupIO'] = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or len(result['processIO']) >= 64:
            continue
        try:
            name = (p / 'comm').read_text().strip()
            status = (p / 'status').read_text()
            state = next(line for line in status.splitlines() if line.startswith('State:'))
            blocked = 'D (' in state
            if not blocked and not any(n in name for n in ('ffmpeg', 'mongod', 'postgres', 'ai_service', 'license', 'python', 'jbd2')):
                continue
            row = dict(pid=int(p.name), name=name, state=state, wait=(p / 'wchan').read_text().strip())
            row.update(process_details(p, blocked))
            counters = cgroup_io(p)
            if counters is not None:
                group, devices = counters
                row['cgroup'] = group
                # Workers share their service's counters: record once, never sum per PID.
                result['cgroupIO'][group] = devices
            result['processIO'].append(row)
        except (OSError, StopIteration):
            continue
    for name in ('io', 'memory'):
        try:
            result[name + 'Pressure'] = Path('/proc/pressure', name).read_text().splitlines()
        except OSError:
            pass
    return result


async def monitor(supervisor, index):
    last_log = -float('inf')
    last_process_log = -float('inf')
    incident_start = None
    while True:
        before = time.monotonic()
        await asyncio.sleep(1)
        now = time.monotonic()
        lag = max(0, now-before-1)
        rows = {cid: st.proc.stats() for cid, st in list(supervisor.states.items())
                if st.proc is not None and st.proc.returncode is None}
        db = index.io_snapshot()
        pressure = lag >= 1 or db['operationSeconds'] >= 3 or any(
            row['writerWaitSec'] >= 3 or row['bufferSec'] >= 5 or row['dropping']
            for row in rows.values())
        if pressure and incident_start is None:
            incident_start = now
            last_log = -float('inf')
            # Repeated short pressure episodes must still share the one-minute
            # process-detail budget; otherwise oscillation floods the logs.
        elif not pressure and incident_start is not None:
            log.info('recording_pressure_recovered duration_s=%.1f', now - incident_start)
            incident_start = None
        if pressure and now-last_log >= 15:
            last_log = now
            system = await asyncio.to_thread(system_snapshot)
            processes = system.pop('processIO', [])
            groups = system.pop('cgroupIO', {})
            wall = time.time()
            log.warning('recording_pressure %s', json.dumps(dict(
                wall=wall, monotonic=now, loopLagSeconds=round(lag,3),
                index=db, channels=rows, system=system), ensure_ascii=True))
            # The shared logger truncates messages at 8192 characters. Keep
            # each process separate so an incident never loses its tail or
            # becomes invalid JSON; wall links all rows to the same snapshot.
            if now - last_process_log >= 60:
                last_process_log = now
                for process in processes:
                    log.warning('recording_pressure_process %s', json.dumps(
                        dict(wall=wall, **process), ensure_ascii=True))
                for group, devices in groups.items():
                    log.warning('recording_pressure_cgroup %s', json.dumps(
                        dict(wall=wall, group=group, devices=devices), ensure_ascii=True))
