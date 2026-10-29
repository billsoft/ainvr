// Explicit isolated test process. Production route/stores, synthetic vectors.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { searchIndexRoutes, type SearchIndexContext } from '../../srs-web-console/backend/src/routes/searchIndexRoutes.js';
import { SearchJobs } from '../../srs-web-console/backend/src/store/searchJobs.js';
import { SearchIndexShards } from '../../srs-web-console/backend/src/store/searchIndexShards.js';
const require = createRequire(new URL('../../srs-web-console/backend/package.json', import.meta.url));
const Fastify = require('fastify');
const { Pool } = require('pg');
if (process.argv.length !== 4 || !['--run-isolated-fixture','--run-managed-fixture'].includes(process.argv[2]!) || process.env.AINVR_SEARCH_TEST_PG !== '1')
  throw new Error('explicit_isolated_fixture_required');
const root = realpathSync(new URL('../..', import.meta.url));
const directory = realpathSync(resolve(process.argv[3]));
const allowed = relative(resolve(root, 'test/results'), directory);
if (!allowed || allowed.startsWith('..') || isAbsolute(allowed)) throw new Error('fixture_results_directory_required');
if (process.argv[2] === '--run-managed-fixture') {
  const { runManagedParameterFixture } = await import('./managed_parameter_fixture.mjs');
  await runManagedParameterFixture(root, directory);
} else {
const token = 's'.repeat(48), revision = 'b'.repeat(64), source = '22222222-2222-4222-8222-222222222222';
const model = 'search-v1-' + 'a'.repeat(64), schema = 'search_wire_' + randomUUID().replaceAll('-', '');
const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
const admin = new Pool(connection), pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 4 });
const app = Fastify({ logger: false });
let context: SearchIndexContext | null = null, lost = 0, stopping = false, catalogVisible = false;
const actions: Record<string, number> = Object.create(null);
const errors: { action: string; status: number; body: unknown }[] = [];
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await app.close(); await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  process.exitCode = code;
}
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const name of ['017_search.sql', '019_search_shard_publication.sql', '021_search_refresh_gc.sql'])
    await pool.query(readFileSync(resolve(root, 'srs-web-console/backend/src/store/migrations', name), 'utf8'));
  const principal = async (request: { headers: Record<string, unknown> }) => request.headers['x-service-token'] === token;
  app.addHook('onSend', async (request: { body?: { action?: string } }, reply: { statusCode: number; code(n: number): unknown }, payload: unknown) => {
    const action = request.body?.action;
    if (action && /^[a-z_]{1,24}$/.test(action)) {
      actions[action] = (actions[action] ?? 0) + 1;
      if (reply.statusCode >= 400 && errors.length < 8) errors.push({ action, status: reply.statusCode, body: JSON.parse(String(payload)) });
    }
    if (request.body?.action === 'publish' && reply.statusCode === 200 && lost === 0) {
      // Durable PG publication happened; only its response is deliberately lost.
      ++lost; reply.code(503); return JSON.stringify({ error: 'fixture_lost_publication_response' });
    }
    if (request.body?.action === 'catalog' && reply.statusCode === 200 && !catalogVisible) {
      const result = JSON.parse(String(payload));
      return JSON.stringify({ ...result, items: [], next_cursor: null });
    }
    return payload;
  });
  app.post('/fixture/context', async (request: { headers: Record<string, unknown>; body: unknown }, reply: { code(n: number): { send(v: unknown): unknown } }) => {
    if (!await principal(request)) return reply.code(403).send({ error: 'forbidden' });
    const data = request.body as { storage_generation?: string };
    if (!data || Object.keys(data).join() !== 'storage_generation' || !/^[a-f0-9]{64}$/.test(data.storage_generation ?? ''))
      return reply.code(400).send({ error: 'invalid_fixture_context' });
    if (context && context.storageGeneration !== data.storage_generation) return reply.code(409).send({ error: 'fixture_context_frozen' });
    context = { revision, storageGeneration: data.storage_generation!, packageId: 'siglip2-base-full-int8',modelVersion:model, channels: [source], retentionDays: 30 };
    return { ready: true };
  });
  app.get('/fixture/state', async (request: { headers: Record<string, unknown> }, reply: { code(n: number): { send(v: unknown): unknown } }) => {
    if (!await principal(request)) return reply.code(403).send({ error: 'forbidden' });
    const jobs = await pool.query('SELECT state,generation,attempts,error_code,result_ref,requested_checkpoint,completed_checkpoint,claimed_checkpoint FROM search_jobs ORDER BY id LIMIT 8');
    const shards = await pool.query(`SELECT id,state,revision,published_revision,manifest_key,checkpoint,record_count,retired_revision
      FROM search_index_shards WHERE published_revision IS NOT NULL ORDER BY id LIMIT 8`);
    return { lost_publication_responses: lost, jobs: jobs.rows, shards: shards.rows, actions, errors, model, fixture_only: true };
  });
  app.post('/fixture/recovery', async (request: { headers: Record<string, unknown> }, reply: { code(n: number): { send(v: unknown): unknown } }) => {
    if (!await principal(request)) return reply.code(403).send({ error: 'forbidden' });
    catalogVisible = true; return { ready: true };
  });
  await app.register(searchIndexRoutes, { prefix: '/api', principal, context: async () => context,
    jobs: new SearchJobs(pool), shards: new SearchIndexShards(pool) });
  await app.listen({ host: '127.0.0.1', port: 25441 });
  writeFileSync(resolve(directory, 'parameter-ready.json'), JSON.stringify({ ready: true, port: 25441, fixture_only: true }), { flag: 'wx', mode: 0o600 });
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
} catch (error) {
  // The fixture uses no credentials and only its dedicated loopback databases.
  console.error('isolated_index_parameter_fixture_failed', error instanceof Error ? error.message : 'unknown');
  await stop(1);
}
}
