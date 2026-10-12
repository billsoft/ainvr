#!/usr/bin/env python3
"""Run real config-store tests in disposable databases owned by a temporary role.

Never uses the production app password or edits production tables. Requires root
access to the existing local ainvr-postgres container. Test credentials are kept
only in memory. Cleanup is limited to this run's generated role and database.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'ainvr-postgres', 'psql',
        '-U', 'ainvr_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        input=query, text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise RuntimeError('Isolated PostgreSQL setup/cleanup failed')


def main():
    marker = 'ainvr_probe_' + secrets.token_hex(8)
    output = ROOT / 'test/results/non-ai-postgres' / (time.strftime('%Y%m%d-%H%M%S') + '-' + marker)
    output.mkdir(parents=True)
    password = secrets.token_hex(32)
    sql(f"CREATE ROLE {marker} LOGIN CREATEDB PASSWORD '{password}';")
    results = []
    try:
        env = dict(os.environ, RUN_PG_TESTS='1', TEST_PG_HOST='127.0.0.1',
            TEST_PG_PORT='5432', TEST_PG_USER=marker, TEST_PG_PASSWORD=password,
            TEST_PG_DATABASE=marker)
        for name in ('migrator', 'pgStore', 'publishOrchestrator'):
            log = output / (name + '.log')
            with log.open('w') as handle:
                log.chmod(0o600)
                result = subprocess.run(['/usr/local/bin/npx', 'vitest', 'run',
                    'src/test/' + name + '.test.ts', '--reporter=json',
                    '--outputFile=' + str(output / (name + '.json'))],
                    cwd=ROOT / 'srs-web-console/backend', env=env,
                    stdout=handle, stderr=subprocess.STDOUT, timeout=180)
            report = json.loads((output / (name + '.json')).read_text())
            results.append({'suite': name, 'exit_code': result.returncode,
                'passed': report['numPassedTests'], 'failed': report['numFailedTests'],
                'skipped': report['numPendingTests']})
    finally:
        # Names are generated above, never supplied by a request or source material.
        sql(f'DROP DATABASE IF EXISTS {marker} WITH (FORCE); DROP ROLE {marker};')
    report = {'passed': all(r['exit_code'] == 0 and r['failed'] == 0 for r in results),
              'suites': results, 'temporary_database_and_role_removed': True}
    (output / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'passed': report['passed'], 'result': str(output / 'summary.json')}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
