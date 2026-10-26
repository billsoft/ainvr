"""Real PostgreSQL retention test: temporary tables, rolled back, no business writes."""
from pathlib import Path
import subprocess
import unittest


class ConfigRetentionTest(unittest.TestCase):
    def test_limits_and_pinned_versions(self):
        root = Path(__file__).resolve().parents[1]
        sql = (root / 'srs-web-console/backend/src/store/configRetention.ts').read_text().split('`')[1]
        setup = '''BEGIN;
CREATE TEMP TABLE config_audit_logs(id bigint PRIMARY KEY);
CREATE TEMP TABLE config_versions(id bigint PRIMARY KEY, version int);
CREATE TEMP TABLE config_service_states(applied_version int, desired_version int);
CREATE TEMP TABLE config_snapshots(version_id bigint REFERENCES config_versions(id) ON DELETE CASCADE);
INSERT INTO config_audit_logs SELECT generate_series(1,12000);
INSERT INTO config_versions SELECT n,n FROM generate_series(1,1200) n;
INSERT INTO config_service_states VALUES(1,2);
INSERT INTO config_snapshots SELECT id FROM config_versions;
'''
        verify = '''
DO $$ BEGIN
 IF (SELECT count(*) FROM config_audit_logs) <> 10000 THEN RAISE EXCEPTION 'audit limit'; END IF;
 IF (SELECT count(*) FROM config_versions) <> 1002 THEN RAISE EXCEPTION 'revision limit'; END IF;
 IF (SELECT count(*) FROM config_versions WHERE version IN (1,2,1200)) <> 3 THEN RAISE EXCEPTION 'pinned lost'; END IF;
 IF (SELECT count(*) FROM config_snapshots) <> 1002 THEN RAISE EXCEPTION 'snapshot cleanup'; END IF;
END $$;
ROLLBACK;
'''
        result = subprocess.run(['docker', 'exec', '-i', 'ainvr-postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'ainvr_admin', '-d', 'ainvr_config'], input=setup+sql+verify, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__': unittest.main()
