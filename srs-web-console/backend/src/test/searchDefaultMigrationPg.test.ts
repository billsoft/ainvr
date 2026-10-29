import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { DEFAULT_SEARCH_SETTINGS } from '../store/searchConfigAdapter.js';

const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
const migration = (name: string) => readFileSync(new URL(`../store/migrations/${name}`, import.meta.url), 'utf8');
const oldMigration = migration('018_search_runtime.sql');
const legacy = JSON.parse(oldMigration.match(/VALUES\('search-service','system','settings','([\s\S]*?)'::jsonb/)![1]!) as Record<string, unknown>;
const advance = migration('020_search_siglip2_default.sql');
const source = { snapshot_store: { mongo_uri: '${secret:ai-service/history}', db_name: 'unchanged_history' } };

async function isolated(test: (pool: Pool) => Promise<void>, preexisting = false) {
  const schema = 'search_default_' + randomUUID().replaceAll('-', '');
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
  try {
    await pool.query(migration('001_initial_schema.sql'));
    await pool.query("INSERT INTO config_versions(version,status) VALUES(7,'published')");
    await pool.query('INSERT INTO config_documents(service,"group",name,config) VALUES($1,$2,$3,$4)', ['ai-service', 'system', 'settings', JSON.stringify(source)]);
    await pool.query("UPDATE config_service_states SET applied_version=7,desired_version=7,status='applied' WHERE service_name='ai-service'");
    await pool.query("INSERT INTO config_secrets(key_path,ciphertext) VALUES('ai-service/history',decode('00','hex'))");
    if (preexisting) await pool.query(`INSERT INTO config_documents(service,"group",name,config,description,created_at,updated_at)
      VALUES('search-service','system','settings',$1,'智能录像搜索（默认关闭）',now()-interval '1 day',now()-interval '1 day')`, [JSON.stringify(legacy)]);
    await pool.query(oldMigration);
    await pool.query("UPDATE config_service_states SET applied_version=8,status='applied',restart_required=true WHERE service_name='search-service'");
    await test(pool);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
async function state(pool: Pool) {
  return {
    documents: (await pool.query('SELECT * FROM config_documents ORDER BY id')).rows,
    services: (await pool.query('SELECT * FROM config_service_states ORDER BY id')).rows,
    versions: (await pool.query('SELECT * FROM config_versions ORDER BY id')).rows,
    snapshots: (await pool.query('SELECT * FROM config_snapshots ORDER BY id')).rows,
    secrets: (await pool.query('SELECT * FROM config_secrets ORDER BY id')).rows,
    audits: (await pool.query('SELECT * FROM config_audit_logs ORDER BY id')).rows,
  };
}

it.skipIf(!enabled)('020 advances only the untouched 018 seed, publishes a full snapshot, and is idempotent', async () => {
  await isolated(async pool => {
    const before = await state(pool);
    expect(before.documents.find(row => row.service === 'search-service')!.config).toEqual(legacy);
    await pool.query(advance);
    const after = await state(pool);
    const search = after.documents.find(row => row.service === 'search-service')!;
    expect(search.config).toEqual(DEFAULT_SEARCH_SETTINGS);
    expect(search.config.enabled).toBe(false);
    expect(search.config.callers).toEqual([]);
    expect(after.services.find(row => row.service_name === 'search-service')).toMatchObject({ applied_version: 8, desired_version: 9, status: 'pending', restart_required: false });
    expect(after.services.filter(row => row.service_name !== 'search-service')).toEqual(before.services.filter(row => row.service_name !== 'search-service'));
    expect(after.documents.filter(row => row.service !== 'search-service')).toEqual(before.documents.filter(row => row.service !== 'search-service'));
    expect(after.secrets).toEqual(before.secrets);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    const latest = after.versions.find(row => row.version === 9)!;
    expect(latest).toMatchObject({ status: 'published', published_by: 'migration' });
    const snapshot = after.snapshots.filter(row => row.version_id === latest.id);
    expect(snapshot).toHaveLength(after.documents.length);
    expect(snapshot.find(row => row.service === 'search-service')!.config).toEqual(search.config);
    expect(snapshot.find(row => row.service === 'ai-service')!.config).toEqual(source);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ actor: 'migration', service: 'search-service', action: 'publish', version_before: 8, version_after: 9 });
    await pool.query(advance);
    expect(await state(pool)).toEqual(after);
  });
});

const preservedCases: [string, (pool: Pool) => Promise<unknown>][] = [
  ['explicit so400m selection with unchanged JSON', pool => pool.query(`INSERT INTO config_audit_logs(actor,action,service,"group",config_name)
    VALUES('admin','update','search-service','system','settings')`)],
  ['edited then restored seed without an audit entry', pool => pool.query("UPDATE config_documents SET config=config,created_at=created_at-interval '1 day' WHERE service='search-service'")],
  ['explicit null model', pool => pool.query(`UPDATE config_documents SET config=jsonb_set(config,'{model,package_id}','null'::jsonb) WHERE service='search-service'`)],
  ['another model selection', pool => pool.query(`UPDATE config_documents SET config=jsonb_set(config,'{model,package_id}','"siglip2-base-pruned-int8"'::jsonb) WHERE service='search-service'`)],
  ['enabled service', pool => pool.query(`UPDATE config_documents SET config=jsonb_set(config,'{enabled}','true'::jsonb) WHERE service='search-service'`)],
  ['custom quota', pool => pool.query(`UPDATE config_documents SET config=jsonb_set(config,'{limits,max_bytes}','2147483648'::jsonb) WHERE service='search-service'`)],
  ['custom extra field', pool => pool.query(`UPDATE config_documents SET config=config||'{"custom_setting":true}'::jsonb WHERE service='search-service'`)],
  ['custom description', pool => pool.query("UPDATE config_documents SET description='operator choice' WHERE service='search-service'")],
  ['existing search credentials', pool => pool.query("INSERT INTO config_secrets(key_path,ciphertext) VALUES('search-service/api_keys/console',decode('00','hex'))")],
  ['different current desired snapshot', async pool => {
    const version = await pool.query("INSERT INTO config_versions(version,status,published_by) VALUES(9,'published','admin') RETURNING id");
    await pool.query(`INSERT INTO config_snapshots(version_id,service,"group",name,config)
      VALUES($1,'search-service','system','settings',$2)`, [version.rows[0].id, JSON.stringify({ ...legacy, model: { package_id: null } })]);
    await pool.query("UPDATE config_service_states SET desired_version=9 WHERE service_name='search-service'");
  }],
];
it.skipIf(!enabled).each(preservedCases)('020 preserves %s without publishing or changing any state', async (_name, modify) => {
  await isolated(async pool => {
    await modify(pool);
    const before = await state(pool);
    await pool.query(advance);
    await pool.query(advance);
    expect(await state(pool)).toEqual(before);
  });
});
it.skipIf(!enabled)('020 preserves an explicit pre-018 so400m document even when its JSON equals the seed', async () => {
  await isolated(async pool => {
    const before = await state(pool);
    await pool.query(advance);
    expect(await state(pool)).toEqual(before);
  }, true);
});
