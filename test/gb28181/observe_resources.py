#!/usr/bin/env python3
"""Bounded, read-only RSS/FD observer for already running GB soak jobs.

This tool never restarts or signals a process. A completed observation is not
itself a passing media test or proof that every possible resource leak is absent.
"""
import argparse
import json
import os
from pathlib import Path
import time


def process_table():
    table = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry/'stat').read_text().rsplit(')', 1)[1].split()
            table[int(entry.name)] = {
                'parent': int(fields[1]), 'startTicks': int(fields[19]),
                'rssBytes': int(fields[21])*os.sysconf('SC_PAGE_SIZE'),
                'cpuTicks': int(fields[11])+int(fields[12]),
            }
        except (OSError, ValueError, IndexError):
            continue
    return table


def sample(root, identity, table):
    if root not in table or table[root]['startTicks'] != identity:
        return {'rootPID': root, 'state': 'ended_or_replaced'}
    members = {root}
    while True:
        expanded = members | {pid for pid, row in table.items() if row['parent'] in members}
        if expanded == members:
            break
        members = expanded
    processes = []
    for pid in sorted(members):
        try:
            current = Path('/proc')/str(pid)
            processes.append({
                'pid': pid, 'name': (current/'comm').read_text().strip(),
                'rssBytes': table[pid]['rssBytes'],
                'parentPID': table[pid]['parent'], 'cpuTicks': table[pid]['cpuTicks'],
                'startTicks': table[pid]['startTicks'],
                'fds': sum(1 for _ in (current/'fd').iterdir()),
            })
        except OSError:  # A short-lived content-check child can finish mid-sample.
            continue
    return {
        'rootPID': root, 'state': 'running', 'processes': processes,
        'rssBytes': sum(p['rssBytes'] for p in processes),
        'fds': sum(p['fds'] for p in processes),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=86580)
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 90000 or not 1 <= args.interval <= 300:
        parser.error('seconds must be 1..90000; interval must be 1..300')
    jobs = json.loads(args.jobs.read_text())['jobs']
    if not 1 <= len(jobs) <= 8:
        parser.error('expected one to eight owned soak jobs')
    table = process_table()
    identities = {}
    for job in jobs:
        pid = job['pid']
        command = (Path('/proc')/str(pid)/'cmdline').read_bytes().split(b'\0')
        if not any(part.endswith(name) for part in command for name in (b'test/gb28181/soak.py',b'test/gb28181/highrate_soak.py')):
            parser.error('root PID is not the requested GB soak job')
        identities[pid] = table[pid]['startTicks']
    args.result.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    count = 0
    peaks = {pid: {'rssBytes': 0, 'fds': 0} for pid in identities}
    with (args.result/'samples.jsonl').open('x') as output:
        while True:
            now = time.monotonic()
            table = process_table()
            states = [sample(pid, identity, table) for pid, identity in identities.items()]
            output.write(json.dumps({'seconds': round(now-started, 3), 'jobs': states})+'\n')
            output.flush()
            count += 1
            for state in states:
                for key in ['rssBytes', 'fds']:
                    peaks[state['rootPID']][key] = max(peaks[state['rootPID']][key], state.get(key, 0))
            ended = all(s['state'] != 'running' for s in states)
            if ended or now-started >= args.seconds:
                break
            time.sleep(min(args.interval, max(0, args.seconds-(time.monotonic()-started))))
    report = {
        'samplingComplete': True, 'allRootsEnded': ended, 'samples': count,
        'elapsedSeconds': round(time.monotonic()-started, 3), 'peaks': peaks,
        'productionChanged': False, 'mediaVerified': False,
        'scope': 'Observed process trees; includes fixture generators and content-check oracles',
    }
    (args.result/'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
