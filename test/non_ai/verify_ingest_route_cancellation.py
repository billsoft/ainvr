#!/usr/bin/env python3
"""AINVR: interrupt the real route fixture while its WHIP video is publishing."""
import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def streams():
    with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams/', timeout=5) as r:
        return json.load(r)['streams']


def process_groups(parent):
    rows = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,pgid='], text=True, timeout=5)
    rows = [list(map(int, line.split())) for line in rows.splitlines()]
    owned = {parent}
    while True:
        following = owned | {pid for pid, ppid, pgid in rows if ppid in owned}
        if following == owned:
            return {pgid for pid, ppid, pgid in rows if pid in owned}
        owned = following


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and os.geteuid() == 0
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    output = ROOT/'test/results'/('ingest-route-cancellation-'+stamp+'-'+str(os.getpid()))
    output.mkdir(mode=0o700)
    # No parallel hardware experiment is allowed; the caller must finish the
    # normal matrix first. Fail if another fixture is already publishing.
    assert not any(s['name'].startswith('ainvr-route-') and s['publish']['active'] for s in streams())
    with (output/'launch.log').open('w') as log:
        child = subprocess.Popen(['python3', str(ROOT/'test/non_ai/verify_ingest_routes.py')],
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        groups = set()
        marker = None
        cancelled_live_publisher = False
        try:
            deadline = time.monotonic()+40
            while time.monotonic() < deadline:
                assert child.poll() is None, 'Fixture exited before cancellation'
                # Read only the generated database identifier from this exact
                # child's node process; credentials are never copied or logged.
                # ps returns 1 while the parent is alive but has not spawned
                # its node child yet. This is an expected startup observation.
                scan = subprocess.run(['ps', '--ppid', str(child.pid), '-o', 'pid='],
                    text=True, capture_output=True, timeout=5)
                assert scan.returncode in (0, 1), 'Process inventory failed'
                pids = scan.stdout.split()
                for pid in pids:
                    try:
                        environment = Path('/proc/'+pid+'/environ').read_bytes().split(b'\0')
                    except FileNotFoundError:
                        continue
                    item = next((x for x in environment if x.startswith(b'AINVR_INGEST_TEST_PG_USER=')), None)
                    if item:
                        marker = item.split(b'=', 1)[1].decode()
                        assert re.fullmatch('ainvr_whip_[a-f0-9]{16}', marker)
                if marker:
                    name = 'ainvr-route-'+marker[-16:]+'-h264'
                    active = next((s for s in streams() if s['name'] == name and s['publish']['active']), None)
                    if active and active.get('video_frames', 0) >= 15:
                        groups = process_groups(child.pid)
                        child.send_signal(signal.SIGTERM)
                        cancelled_live_publisher = True
                        break
                time.sleep(.2)
            assert cancelled_live_publisher, 'No real publisher observed before cancellation'
            child.wait(timeout=35)
        finally:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                child.wait(timeout=35)
    assert child.returncode != 0, 'A cancelled matrix must not report full success'
    assert not any(s['name'].startswith('ainvr-route-'+marker[-16:]) and s['publish']['active'] for s in streams())
    rows = subprocess.check_output(['ps', '-eo', 'pgid='], text=True, timeout=5).split()
    assert not groups.intersection(map(int, rows)), 'An owned process group survived cancellation'
    query = ("SELECT (SELECT count(*) FROM pg_database WHERE datname='"+marker+
        "')+(SELECT count(*) FROM pg_roles WHERE rolname='"+marker+"');")
    count = subprocess.check_output(['docker', 'exec', '-i', 'ainvr-postgres', 'psql',
        '-U', 'ainvr_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
        input=query, text=True, timeout=15).strip()
    assert count == '0', 'Temporary PG database or role remains'
    report = {'passed': True, 'cancelled_while_real_video_was_publishing': True,
        'interrupted_matrix_did_not_report_success': True,
        'all_observed_owned_process_groups_removed': True,
        'temporary_publisher_stopped': True, 'database_and_role_removed': True,
        'observed_process_group_ids': sorted(groups), 'matrix_exit_code': child.returncode}
    (output/'summary.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'passed': True, 'result': str(output/'summary.json')}), flush=True)


if __name__ == '__main__':
    main()
