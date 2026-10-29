// Real isolated PG migration proof tests. No production env/credentials/services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { searchSeed020Proof } from '../../deploy-package/search_seed_migration_proof.mjs';
if (process.env.AINVR_SEARCH_TEST_PG !== '1') throw new Error('Run only with the isolated search PG harness');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { default: pg } = await import(pathToFileURL(path.join(root, 'srs-web-console/backend/node_modules/pg/lib/index.js')).href);
const migrations = path.join(root, 'srs-web-console/backend/src/store/migrations');
const initial = await readFile(path.join(migrations, '001_initial_schema.sql'), 'utf8');
const seed = await readFile(path.join(migrations, '018_search_runtime.sql'), 'utf8');
const advance = await readFile(path.join(migrations, '020_search_siglip2_default.sql'), 'utf8');

async function fixture(run) {
  const client = new pg.Client({ host: '127.0.0.1', port: 25439, database: 'alarm_test', user: 'alarm_test',
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const schema = `search_seed_proof_${randomBytes(8).toString('hex')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(initial);
    await client.query(`INSERT INTO config_documents(service,"group",name,config) VALUES('unrelated','system','settings','{"keep":true}')`);
    await client.query(seed);
    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}
async function proof(client) {
  // Any accidental write/row lock in the proof itself fails the regression.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { return await searchSeed020Proof(client, root); }
  finally { await client.query('ROLLBACK'); }
}

test('untouched 018 seed produces exact expected hash and completed 020 publication proof', async () => fixture(async client => {
  const before = await proof(client);
  assert.ok(before.eligible); assert.equal(before.completed, null);
  await client.query(advance);
  const after = await proof(client);
  assert.equal(after.eligible, null); assert.ok(after.completed);
  assert.equal(after.completed.document_id, before.eligible.document_id);
  assert.equal(after.completed.version_before, before.eligible.desired_version);
  assert.equal(after.completed.document_hash, before.eligible.expected_after_hash);
  assert.notEqual(after.completed.document_hash, before.eligible.document_hash);
  assert.equal(after.migration_sha256, before.migration_sha256);
  assert.equal(JSON.stringify(after).includes('package_id'), false);
  assert.equal(JSON.stringify(after).includes('config'), false);
}));

for (const [name, edit] of [
  ['enabled user configuration', `UPDATE config_documents SET config=jsonb_set(config,'{enabled}','true') WHERE service='search-service'`],
  ['custom field', `UPDATE config_documents SET config=config||'{"custom":1}' WHERE service='search-service'`],
  ['custom description', `UPDATE config_documents SET description='user choice' WHERE service='search-service'`],
  ['prior audit', `INSERT INTO config_audit_logs(actor,action,service) VALUES('admin','update','search-service')`],
  ['existing credential', `INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version) VALUES('search-service/test',decode('01','hex'),'aes-256-gcm',1)`],
  ['different desired snapshot', `UPDATE config_snapshots SET config=jsonb_set(config,'{enabled}','true') WHERE service='search-service'`],
]) test(`020 proof rejects ${name}`, async () => fixture(async client => {
  await client.query(edit);
  assert.equal((await proof(client)).eligible, null);
  await client.query(advance);
  assert.equal((await proof(client)).completed, null);
}));

test('post-020 arbitrary edits and forged audit details cannot authorize preservation exception', async () => fixture(async client => {
  await client.query(advance);
  assert.ok((await proof(client)).completed);
  await client.query(`UPDATE config_audit_logs SET detail=detail||'{"extra":true}' WHERE service='search-service'`);
  assert.equal((await proof(client)).completed, null);
}));

test('incomplete supposedly published full snapshot is not accepted', async () => fixture(async client => {
  await client.query(advance);
  const value = await proof(client); assert.ok(value.completed);
  await client.query(`DELETE FROM config_snapshots WHERE service='unrelated' AND version_id=(SELECT id FROM config_versions WHERE version=$1)`, [value.completed.version_after]);
  assert.equal((await proof(client)).completed, null);
}));

test('editing back to seed without matching creation time remains ineligible', async () => fixture(async client => {
  await client.query(`UPDATE config_documents SET updated_at=created_at+interval '1 second' WHERE service='search-service'`);
  assert.equal((await proof(client)).eligible, null);
  await client.query(advance);
  assert.equal((await proof(client)).completed, null);
}));
