#!/usr/bin/env python3
"""AINVR real channel/WHIP routes, isolated PG credentials and hardware media.

Uses the deployed route modules with private channel files and a generated
database. Does not log into, bypass, or alter the production console.
"""
import datetime
import hashlib
import json
import os
import pwd
from pathlib import Path
import secrets
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
NODE = '/opt/ainvr/node-v24.20.0-linux-arm64/bin/node'


def sql(query):
    r = subprocess.run(['docker', 'exec', '-i', 'ainvr-postgres', 'psql',
        '-U', 'ainvr_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        input=query, text=True, capture_output=True, timeout=15)
    if r.returncode:
        raise RuntimeError('Isolated PostgreSQL setup/cleanup failed')


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and os.geteuid() == 0
    assert Path('/mnt/ainvr-ssd').is_mount()
    marker = 'ainvr_whip_' + secrets.token_hex(8)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    result = ROOT/'test/results'/('ingest-routes-'+stamp+'-'+str(os.getpid()))
    result.mkdir(mode=0o700)
    account = pwd.getpwnam('sunrise')
    os.chown(result, account.pw_uid, account.pw_gid)
    work = Path('/mnt/ainvr-ssd/test-media')/result.name
    work.mkdir(mode=0o700, parents=True)
    protected = [ROOT/'deploy/s100p/bin/ainvr_ai_service',
        ROOT/'data/ai/config_overlay.json', ROOT/'data/recorder/config.json',
        ROOT/'srs-web-console/deploy/srs-conf/srs.conf']
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    before = {str(p): digest(p) for p in protected}
    password = secrets.token_hex(32)
    sql(f"CREATE ROLE {marker} LOGIN PASSWORD '{password}';")
    proc = None
    code = 1
    cleanup = False

    def cancel(_signum, _frame):
        if proc and proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
        raise KeyboardInterrupt('Ingest acceptance cancelled')

    signal.signal(signal.SIGTERM, cancel)
    try:
        sql(f'CREATE DATABASE {marker} OWNER {marker};')
        env = dict(os.environ, AINVR_INGEST_TEST_PG_USER=marker,
            AINVR_INGEST_TEST_PG_PASSWORD=password,
            AINVR_INGEST_TEST_RESULT=str(result), AINVR_INGEST_TEST_WORK=str(work))
        with (result/'runner.log').open('w') as log:
            proc = subprocess.Popen([NODE, str(ROOT/'test/non_ai/ingest_routes_real.mjs')],
                env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = proc.wait(timeout=450)
            finally:
                if proc.poll() is None:
                    proc.send_signal(signal.SIGTERM)
                    try:
                        proc.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        # The node fixture owns and cleans media process groups.
                        # Never declare cleanup successful after a forced kill.
                        proc.kill(); proc.wait(timeout=5)
                        raise RuntimeError('Fixture forced termination; inspect owned media processes')
    finally:
        # Credentials are memory-only. Names are generated here, never user data.
        sql(f'DROP DATABASE IF EXISTS {marker} WITH (FORCE); DROP ROLE {marker};')
        cleanup = True
        report_path = result/'summary.json'
        report = json.loads(report_path.read_text()) if report_path.exists() else {'passed': False}
        unchanged = {str(p): digest(p) for p in protected} == before
        report.update(temporary_database_and_role_removed=cleanup,
            production_files_unchanged=unchanged, runner_exit_code=code,
            full_migration_completed=False, user_model_inference_verified=False,
            production_console_login_verified=False, actual_browser_playback_verified=False)
        report['passed'] = bool(report.get('passed') and unchanged and code == 0 and cleanup)
        report_path.write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({'passed': report['passed'], 'result': str(report_path)}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
