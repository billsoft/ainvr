import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { SearchRuntimeStore } from '../store/searchRuntimeStore.js';
import { DEFAULT_SEARCH_SETTINGS } from '../store/searchConfigAdapter.js';
const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
it.skipIf(!enabled)('runtime migration preserves old services and ACKs dependencies atomically in the existing PG', async () => {
  const schema = 'search_runtime_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  try {
    await pool.query(readFileSync(new URL('../store/migrations/001_initial_schema.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO config_versions(version,status) VALUES(7,'published')");
    await pool.query("INSERT INTO config_documents(service,\"group\",name,config) VALUES('ai-service','system','settings',$1)",
      [JSON.stringify({ snapshot_store: { mongo_uri: '${secret:ai-service/old-uri}', db_name: 'old_history' } })]);
    await pool.query("UPDATE config_service_states SET applied_version=7,desired_version=9,status='applied' WHERE service_name='ai-service'");
    await pool.query(readFileSync(new URL('../store/migrations/018_search_runtime.sql', import.meta.url), 'utf8'));
    const ai = (await pool.query("SELECT applied_version,desired_version,status FROM config_service_states WHERE service_name='ai-service'")).rows[0];
    expect(ai).toEqual({ applied_version: 7, desired_version: 9, status: 'applied' });
    const search = (await pool.query("SELECT desired_version FROM config_service_states WHERE service_name='search-service'")).rows[0];
    expect(search.desired_version).toBe(8);
    expect((await pool.query("SELECT config FROM config_documents WHERE service='search-service'")).rows[0].config).toEqual(DEFAULT_SEARCH_SETTINGS);
    expect(Number((await pool.query('SELECT count(*) AS n FROM config_snapshots WHERE version_id=(SELECT id FROM config_versions WHERE version=8)')).rows[0].n)).toBe(2);
    const runtime = new SearchRuntimeStore(pool), revision = 'a'.repeat(64);
    expect(await runtime.read()).toBeNull();
    expect(await runtime.acknowledge({ desired_version: 8, revision, status: 'applied', error_code: null })).toBe(true);
    expect(await runtime.read()).toEqual({ desired_version: 8, revision, status: 'applied', error_code: null });
    expect((await pool.query("SELECT applied_version,status,restart_required FROM config_service_states WHERE service_name='search-service'")).rows[0])
      .toEqual({ applied_version: 8, status: 'applied', restart_required: false });
    await pool.query("UPDATE config_service_states SET desired_version=10,status='pending' WHERE service_name='search-service'");
    expect(await runtime.acknowledge({ desired_version: 8, revision: 'b'.repeat(64), status: 'failed', error_code: 'old_ack' })).toBe(false);
    expect((await runtime.read())?.revision).toBe(revision);
    expect(await runtime.acknowledge({ desired_version: 10, revision: 'c'.repeat(64), status: 'failed', error_code: 'storage_unavailable' })).toBe(true);
    expect((await pool.query("SELECT applied_version,status,error_message FROM config_service_states WHERE service_name='search-service'")).rows[0])
      .toEqual({ applied_version: 8, status: 'failed', error_message: 'storage_unavailable' });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
