// Read-only preservation proof. Values, URIs and credentials never leave this process.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { searchSeed020Proof } from './search_seed_migration_proof.mjs';

const root = path.resolve(process.argv[2]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let client;
try {
  process.loadEnvFile(path.join(root, 'deploy/s100p/runtime/backend.env'));
  const { default: pg } = await import(pathToFileURL(path.join(root, 'srs-web-console/backend/node_modules/pg/lib/index.js')).href);
  client = new pg.Client({ host: process.env.CONFIG_PG_HOST, port: Number(process.env.CONFIG_PG_PORT ?? 5432),
    user: process.env.CONFIG_PG_USER, password: process.env.CONFIG_PG_PASSWORD, database: process.env.CONFIG_PG_DATABASE,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result = { config_documents: {} };
  const documents = await client.query('SELECT service,"group",name,to_jsonb(t)-ARRAY[\'created_at\',\'updated_at\'] AS value FROM config_documents t ORDER BY service,"group",name');
  for (const row of documents.rows) result.config_documents[`${row.service}/${row.group}/${row.name}`] = hash(row.value);
  const tables = { config_secrets: ['created_at', 'updated_at'], alarm_arming_sources: ['updated_at'],
    alarm_monitors: ['updated_at'], alarm_trigger_definitions: ['updated_at'], alarm_trigger_assignments: ['updated_at'],
    alarm_triggers: ['updated_at'], alarm_zones: ['updated_at'], flow_counter_definitions: ['updated_at'],
    flow_counter_bindings: ['created_at', 'updated_at'], flow_counters: ['updated_at'], gb28181_settings: ['updated_at'],
    gb28181_devices: ['updated_at'], gb28181_bindings: [], onvif_settings: ['updated_at'],
    onvif_devices: ['capabilities', 'last_probe_at', 'last_error', 'updated_at'] };
  for (const [table, exclude] of Object.entries(tables)) {
    // Table names are a fixed first-party allowlist, never request input.
    const query = `SELECT to_jsonb(t)-$1::text[] AS value FROM ${table} t ORDER BY (to_jsonb(t)-$1::text[])::text`;
    const rows = (await client.query(query, [exclude])).rows.map(row => row.value);
    result[table] = { count: rows.length, sha256: hash(rows) };
  }
  result.search_seed_020 = await searchSeed020Proof(client, root);
  await client.query('ROLLBACK');
  console.log(JSON.stringify(result));
} catch {
  console.error('Cannot verify customer parameter preservation');
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
