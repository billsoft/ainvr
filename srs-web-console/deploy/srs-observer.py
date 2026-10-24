#!/usr/bin/python3
"""Read-only bounded incident recorder. Never restarts or controls services."""
import collections
import json
import logging
from logging.handlers import RotatingFileHandler
import re
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
import urllib.request

ARCHIVE = logging.getLogger('srs-incidents')
ARCHIVE.propagate = False
ARCHIVE.addHandler(logging.NullHandler())
STOP = threading.Event()

def configure_archive(directory):
    # Dedicated bounded files survive noisy Docker/journal rotation. This runs
    # only in the observer process, never in the media pipeline.
    handler = RotatingFileHandler(Path(directory) / 'incidents.jsonl',
        maxBytes=8 * 1024 * 1024, backupCount=7, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(message)s'))
    ARCHIVE.addHandler(handler)
    ARCHIVE.setLevel(logging.INFO)
    return handler

def srs_error_summary(line):
    # Do not persist raw URLs, stream keys, query strings or user log content.
    # Keep the SRS timestamp/session/code for correlation with original logs.
    match = re.search(r'\[(Warn|Error)\](?:\[\d+\])?\[([A-Za-z0-9_-]{1,40})\]', line)
    if not match:
        return None
    stamp = re.search(r'\[(\d{4}-\d{2}-\d{2} [0-9:.]+)\]', line)
    return {'severity': match[1], 'session': match[2],
            'srs_time_utc': stamp[1] if stamp else None,
            'codes': re.findall(r'\bcode=(\d+)\b', line)[:8],
            'signals': [word for word in ('timeout', 'reset', 'closed', 'publish',
                'handshake', 'socket', 'No space') if word.lower() in line.lower()]}

def srs_errors(events):
    while not STOP.is_set():
        try:
            proc = subprocess.Popen(['docker', 'logs', '--follow', '--since', '5s',
                '--tail', '200', 'ainvr-srs'], stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, errors='replace')
        except OSError:
            events.append({'kind': 'log_reader_unavailable'})
            STOP.wait(5)
            continue
        def consume():
            for line in proc.stdout:
                event = srs_error_summary(line)
                if event:
                    events.append({'kind': 'srs_error', 'captured_at': time.time(), **event})
        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        try:
            while not STOP.wait(1) and proc.poll() is None:
                pass
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=2)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=2)
            reader.join(timeout=2)
            proc.stdout.close()
        if not STOP.is_set():
            events.append({'kind': 'log_reader_reconnecting'})
            STOP.wait(5)

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def read(path, limit=16384):
    try:
        with open(path) as f:
            return f.read(limit)
    except OSError:
        return ''

def command(args, limit=6000):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=.8)
        return (r.stdout if r.returncode == 0 else r.stderr)[:limit].strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return type(e).__name__

def selected(path, keys):
    result = {}
    for line in read(path).splitlines():
        parts = line.replace(':', '').split()
        if len(parts) > 1 and parts[0] in keys:
            result[parts[0]] = parts[1]
    return result

def fetch_streams():
    started = time.monotonic()
    try:
        with OPENER.open('http://127.0.0.1:1985/api/v1/streams/', timeout=.7) as r:
            body = json.loads(r.read(2 * 1024 * 1024))
        if body.get('code') != 0:
            raise ValueError('SRS API rejected query')
        streams = {str(s.get('id')): {
            'vhost': s.get('vhost'), 'name': s.get('name'), 'app': s.get('app'),
            'cid': s.get('publish', {}).get('cid'),
            'active': s.get('publish', {}).get('active'),
            'recv_bytes': s.get('recv_bytes'), 'clients': s.get('clients'),
        } for s in body.get('streams', [])}
        return {'ok': True, 'ms': round((time.monotonic()-started)*1000, 2), 'streams': streams}
    except Exception as e:
        return {'ok': False, 'ms': round((time.monotonic()-started)*1000, 2),
                'error': type(e).__name__}

def triggers(previous, current):
    reasons = []
    if not current['api']['ok']:
        reasons.append('api_unreachable')
    elif current['api']['ms'] >= 200:
        reasons.append('api_slow')
    if current.get('sample_gap_ms', 0) >= 2000:
        reasons.append('observer_schedule_delayed')
    if previous and previous['api']['ok'] and current['api']['ok']:
        def sessions(s):
            # 离线流也会因读流请求被反复创建、删除，内部 ID 不能代表推流会话。
            # 只比较有效推流方；真正停推、恢复或更换推流方仍会产生变化。
            return {
                (v.get('vhost'), v.get('app'), v.get('name')): v['cid']
                for v in s['api']['streams'].values()
                if v.get('active') and v.get('cid')
            }
        if sessions(previous) != sessions(current):
            reasons.append('publisher_changed')
    return reasons


def recent_tcp_events(events, wall, window_seconds=60):
    """Do not attach yesterday's RSTs to today's unrelated publisher changes."""
    recent = []
    for event in list(events):
        captured = event.get('wall', 0)
        # tcpdump may flush buffered output late. Prefer the packet timestamp.
        text = event.get('event', '')
        if ' IP ' in text:
            try:
                captured = float(text.split()[0])
            except (ValueError, IndexError):
                pass
        if wall - window_seconds <= captured <= wall:
            recent.append(event)
    return recent[-40:]

def process_snapshot(pid):
    # No command lines or environment values: credentials cannot enter this log.
    stat = read(f'/proc/{pid}/stat')
    parts = stat.rsplit(')', 1)[-1].split() if stat else []
    return {'pid': pid, 'state': parts[0] if parts else 'gone',
            'utime_ticks': parts[11] if len(parts) > 12 else None,
            'stime_ticks': parts[12] if len(parts) > 12 else None,
            'wchan': read(f'/proc/{pid}/wchan', 160),
            'status': selected(f'/proc/{pid}/status', {'VmRSS', 'VmSwap', 'Threads'}),
            'schedstat': read(f'/proc/{pid}/schedstat', 200)}

def processes(root):
    # This board kernel lacks /proc/PID/task/TID/children. Enumerate PPIDs
    # from one bounded ps query, rather than silently observing docker-init only.
    children = collections.defaultdict(list)
    for line in command(['ps', '-e', '-o', 'pid=,ppid='], limit=65536).splitlines():
        parts = line.split()
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            children[int(parts[1])].append(int(parts[0]))
    queue, result, seen = [root], [], set()
    while queue and len(result) < 12:
        pid = queue.pop(0)
        if pid <= 0 or pid in seen: continue
        seen.add(pid)
        result.append(process_snapshot(pid))
        queue.extend(children[pid])
    return result

def tcp_events(events):
    # Capture only IPv4 connection flags and zero windows. No payload or pcap file.
    if not shutil.which('tcpdump'):
        events.append({'wall': time.time(), 'event': 'tcpdump unavailable'})
        return
    proc = subprocess.Popen(['tcpdump', '-i', 'any', '-nn', '-tt', '-l', '-s', '96',
        'ip and tcp port 1935 and ((tcp[13] & 7 != 0) or tcp[14:2] = 0)'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    def consume():
        for line in proc.stdout:
            events.append({'wall': time.time(), 'event': line.strip()[:600]})
    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    try:
        while not STOP.wait(1):
            if proc.poll() is not None:
                events.append({'wall': time.time(), 'event': 'tcpdump exited', 'code': proc.returncode})
                return
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=2)
        reader.join(timeout=2)
        proc.stdout.close()

def emit(kind, **values):
    record = json.dumps({'kind': kind, 'wall': time.time(), **values}, ensure_ascii=False)
    ARCHIVE.info(record)
    print(record, flush=True)

def main():
    directory = os.environ.get('LOGS_DIRECTORY')
    if directory:
        configure_archive(directory)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    events = collections.deque(maxlen=120)
    thread = threading.Thread(target=tcp_events, args=(events,), daemon=True)
    thread.start()
    errors = collections.deque(maxlen=256)
    error_thread = threading.Thread(target=srs_errors, args=(errors,), daemon=True)
    error_thread.start()
    history = collections.deque(maxlen=6)
    last_event = last_heartbeat = last_pid_refresh = 0
    last_sample = time.monotonic()
    root_pid = 0
    pending = set()
    emit('observer_started', interval_seconds=1, capture='TCP flags/zero-window only; no payload')
    try:
        while not STOP.is_set():
            now = time.monotonic()
            if now-last_pid_refresh >= 10:
                value = command(['docker', 'inspect', '-f', '{{.State.Pid}}', 'ainvr-srs'])
                root_pid = int(value) if value.isdigit() else 0
                last_pid_refresh = now
            sample = {'wall': time.time(), 'mono': now,
                'sample_gap_ms': round((now-last_sample)*1000, 2),
                'api': fetch_streams(), 'processes': processes(root_pid),
                'mem_kib': selected('/proc/meminfo', {'MemAvailable', 'Dirty', 'Writeback', 'SwapFree'}),
                'vm': selected('/proc/vmstat', {'pswpin', 'pswpout', 'pgmajfault', 'allocstall_normal'}),
                'diskstats': [l.strip() for l in read('/proc/diskstats').splitlines() if 'nvme' in l],
                'netdev': read('/proc/net/dev', 4000)}
            reasons = triggers(history[-1] if history else None, sample)
            # Preserve each sampled transition immediately; expensive snapshots
            # stay throttled. An outage and recovery within 15s must not collapse.
            if 'publisher_changed' in reasons:
                emit('publisher_transition', previous=history[-1]['api'], current=sample['api'])
            if history and history[-1]['api']['ok'] != sample['api']['ok']:
                emit('api_availability_changed', available=sample['api']['ok'])
            pending.update(reasons)
            # Drain bounded queue once per sample. Repeated error storms are
            # aggregated, keeping CPU, memory and disk use bounded.
            summaries = collections.Counter()
            for _ in range(min(len(errors), 256)):
                event = errors.popleft()
                event.pop('captured_at', None)
                summaries[json.dumps(event, sort_keys=True)] += 1
            if summaries:
                emit('srs_error_batch', records=[{'detail': json.loads(k), 'count': n}
                    for k, n in summaries.items()], queue_capacity=256,
                    note='bounded best-effort samples, not an exhaustive error count')
            last_sample = now
            if pending and now-last_event >= 15:
                # Full TCP queue/retransmit state and stacks only on anomalies.
                detail = {'tcp': command(['ss', '-tin', '( sport = :1935 or dport = :1935 )']),
                    'wifi': command(['iw', 'dev']),
                    'stacks': {str(p['pid']): read(f'/proc/{p["pid"]}/stack', 1800)
                               for p in sample['processes']},
                    }
                # Add station retries/signal for each wireless interface.
                interfaces = [l.split()[1] for l in detail['wifi'].splitlines()
                              if l.strip().startswith('Interface ')]
                detail['wifi_stations'] = {i: command(['iw', 'dev', i, 'station', 'dump']) for i in interfaces}
                incident = str(time.time_ns())
                # Separate bounded journal records avoid systemd's line-length
                # truncation while retaining a stable key to join the snapshot.
                for prior in history:
                    emit('srs_incident_before', incident=incident, sample=prior)
                emit('srs_incident', incident=incident, reasons=sorted(pending), current=sample, **detail)
                emit('srs_tcp_events', incident=incident, window_seconds=60,
                     events=recent_tcp_events(events, time.time()))
                pending.clear(); last_event = now
            elif now-last_heartbeat >= 300:
                emit('observer_heartbeat', current=sample)
                last_heartbeat = now
            history.append(sample)
            STOP.wait(max(0, 1-(time.monotonic()-now)))
    finally:
        STOP.set(); thread.join(timeout=4); error_thread.join(timeout=4)

if __name__ == '__main__':
    main()
