#!/usr/bin/python3
"""Read-only bounded incident recorder. Never restarts or controls services."""
import collections
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
import urllib.request

STOP = threading.Event()
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
    queue, result = [root], []
    while queue and len(result) < 12:
        pid = queue.pop(0)
        if pid <= 0: continue
        result.append(process_snapshot(pid))
        queue.extend(int(p) for p in read(f'/proc/{pid}/task/{pid}/children', 256).split() if p.isdigit())
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
    print(json.dumps({'kind': kind, 'wall': time.time(), **values}, ensure_ascii=False), flush=True)

def main():
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    events = collections.deque(maxlen=120)
    thread = threading.Thread(target=tcp_events, args=(events,), daemon=True)
    thread.start()
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
            pending.update(triggers(history[-1] if history else None, sample))
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
        STOP.set(); thread.join(timeout=4)

if __name__ == '__main__':
    main()
