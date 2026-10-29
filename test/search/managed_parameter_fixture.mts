// Isolated parameter-side fixture: production stores/routes, never BPU/services.
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { PgConfigStore } from '../../srs-web-console/backend/src/store/pgStore.js';
import { PublishOrchestrator } from '../../srs-web-console/backend/src/store/publishOrchestrator.js';
import { SearchConfigAdapter, DEFAULT_SEARCH_SETTINGS } from '../../srs-web-console/backend/src/store/searchConfigAdapter.js';
import { SearchRuntimeStore } from '../../srs-web-console/backend/src/store/searchRuntimeStore.js';
import { SearchJobs } from '../../srs-web-console/backend/src/store/searchJobs.js';
import { SearchIndexShards } from '../../srs-web-console/backend/src/store/searchIndexShards.js';
import { configRoutes } from '../../srs-web-console/backend/src/routes/config.js';
import { searchRuntimeRoutes } from '../../srs-web-console/backend/src/routes/searchRuntimeRoutes.js';
import { searchIndexRoutes } from '../../srs-web-console/backend/src/routes/searchIndexRoutes.js';
import { sanitizeImportDocSecrets } from '../../srs-web-console/backend/src/routes/configPolicy.js';
import { resolveServiceByToken } from '../../srs-web-console/backend/src/services/serviceTokens.js';
import { buildSearchSourceCatalog } from '../../srs-web-console/backend/src/services/searchSourceCatalog.js';
import { readAppliedSearchConfiguration, readAppliedSearchConnection, readEffectiveSearchConfiguration } from '../../srs-web-console/backend/src/services/searchConnection.js';

const require = createRequire(new URL('../../srs-web-console/backend/package.json', import.meta.url));
const Fastify = require('fastify'), { Pool } = require('pg'), { z } = require('zod');
const execute = promisify(execFile);
const INPUT = '00000000-0000-4000-8000-000000000001', OUTPUT = '00000000-0000-4000-8000-000000000002';
const PROCESSOR = 'search-bpu-fixture', VOLUME = '64a5b078-4c84-4766-9bc6-68c247294079';
const BASE = 'http://127.0.0.1:25441';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function privateJson(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid!() || info.size > 65536)
    throw new Error('fixture_private_file_required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function writePrivate(path: string, value: unknown, ackAt?: number) {
  const temporary = path + '.new-' + randomUUID();
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  if (ackAt !== undefined) utimesSync(temporary, new Date(ackAt), new Date(ackAt));
  renameSync(temporary, path);
}

export async function runManagedParameterFixture(root: string, directory: string) {
  if (process.env.AINVR_SEARCH_TEST_PG !== '1' || userInfo().username !== 'sunrise')
    throw new Error('explicit_sunrise_isolated_fixture_required');
  const child = relative(resolve(root, 'test/results'), directory);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('fixture_results_directory_required');
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || (dir.mode & 0o077) || dir.uid !== process.getuid!()) throw new Error('fixture_private_directory_required');
  const options = z.object({ schema: z.literal(1), mode: z.enum(['software-preflight', 'managed-hardware']),
    volume_id: z.literal(VOLUME), relative_path: z.string().regex(/^ainvr-tests\/search-managed-[a-zA-Z0-9_-]{1,80}$/),
  }).strict().parse(privateJson(resolve(directory, 'managed-options.json')));
  for (const name of ['parameter-ready.json', 'search-service-bootstrap.json', 'fixture-admin.json', 'client-access.json']) {
    try { lstatSync(resolve(directory, name)); throw new Error('new_fixture_directory_required'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Same read-only inventory implementation as the OS helper, without loading
  // production helper credentials or contacting its management service.
  const readInventory = async () => {
    const code = "import sys,json;sys.path.insert(0,sys.argv[1]);import storage;print(json.dumps(storage.inventory()))";
    const result = await execute('/usr/bin/python3', ['-c', code, resolve(root, 'shared/os-helper')],
      { timeout: 12000, maxBuffer: 524288 });
    return JSON.parse(result.stdout);
  };
  const inventory = await readInventory();
  const volume = inventory.volumes?.filter((v: any) => v.id === VOLUME && v.selectable && !v.system && !v.readOnly && v.state === 'mounted');
  if (volume?.length !== 1) throw new Error('authorized_test_volume_unavailable');
  const schema = 'search_managed_' + randomUUID().replaceAll('-', ''), database = schema;
  const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
  const admin = new Pool(connection);
  const store = new PgConfigStore({ poolConfig: { ...connection, options: `-c search_path=${schema}`, max: 4 }, masterKeyPath: resolve(directory, 'fixture-master.key') });
  const runtime = new SearchRuntimeStore(store.pool), jobs = new SearchJobs(store.pool), shards = new SearchIndexShards(store.pool);
  const manager = randomBytes(48).toString('hex'), ai = randomBytes(48).toString('hex'), administrator = randomBytes(48).toString('hex');
  const tokens = new Map([[manager, 'search-service'], [ai, 'ai-service']]);
  const app = Fastify({ logger: false, bodyLimit: 262144 });
  const orchestrator = new PublishOrchestrator(store, [new SearchConfigAdapter()]);
  let stopping = false, mutating = false, generation = 1, accessReady = false;
  let lastAck: { desired_version: number; revision: string; at: number } | null = null;
  const actions: Record<string, number> = {}, actionStatuses: Record<string, number> = {},
    acks: { desired_version: number; revision: string; status: string; at_ms: number }[] = [];
  const managementPrincipal = async (request: any) => resolveServiceByToken(tokens, request.headers['x-service-token']) === 'search-service';
  const producerPrincipal = async (request: any) => resolveServiceByToken(tokens, request.headers['x-service-token']) === 'ai-service';
  const sourceCatalog = async () => {
    const state = await store.getServiceState('ai-service');
    if (!state?.appliedVersion) throw new Error('fixture_source_pending');
    const [aiDocs, channels] = await Promise.all([store.getVersionSnapshotForService(state.appliedVersion, 'ai-service'), store.getVersionSnapshotForService(state.appliedVersion, 'channels')]);
    const channelList = channels.find(d => d.group === 'system' && d.name === 'settings')?.config.channels;
    return buildSearchSourceCatalog(channelList as any, aiDocs.filter(d => d.group === 'channels').map(d => ({ id: d.name, config: d.config })));
  };
  const dependencies = { store, sourceCatalog, volumes: async () => inventory,
    modelAuthority: () => runtime.modelAuthority() };
  const accessPath = resolve(directory, 'client-access.json');
  async function inactive(reason: 'config_pending' | 'disabled') {
    const state = await store.getServiceState('search-service'); accessReady = false;
    writePrivate(accessPath, { schema_version: 'ainvr.search.managed_fixture.v1', fixture_mode: options.mode,
      enabled: false, reason, desired_version: state?.desiredVersion ?? 1, revision: null, console: null, producer: null });
  }
  async function refreshAccess(proof: NonNullable<typeof lastAck>) {
    if (mutating || stopping) return;
    const effective = await readAppliedSearchConfiguration(dependencies, runtime);
    if (!effective || effective.desired_version !== proof.desired_version || effective.revision !== proof.revision) {
      await inactive('config_pending'); return;
    }
    const grant = await app.inject({ method: 'GET', url: '/api/internal/search/producer-config', headers: { 'x-service-token': ai } });
    const producer = grant.json();
    const config = await readAppliedSearchConnection(dependencies, runtime);
    const current = await readAppliedSearchConfiguration(dependencies, runtime);
    if (mutating || stopping) return;
    if (!current || current.revision !== proof.revision || current.desired_version !== proof.desired_version) {
      await inactive('config_pending'); return;
    }
    const enabled = current.settings.enabled && producer.enabled && producer.revision === proof.revision && config?.baseUrl === 'http://127.0.0.1:8400';
    accessReady = Boolean(enabled);
    // mtime is the actual ACK observation, not a fresh lease fabricated by a
    // later control operation. Every new successful ACK (same revision too)
    // replaces this file; pending/disabled files contain no business key.
    writePrivate(accessPath, { schema_version: 'ainvr.search.managed_fixture.v1', fixture_mode: options.mode,
      enabled: Boolean(enabled), reason: enabled ? null : current.settings.enabled ? 'config_pending' : 'disabled',
      desired_version: proof.desired_version, revision: proof.revision,
      console: enabled ? { endpoint: config!.baseUrl, api_token: config!.apiToken } : null, producer: enabled ? producer : null }, proof.at);
  }
  async function saveSources() {
    const suffix = generation === 1 ? '' : `_g${generation}`, now = Date.now();
    const inputPath = `/live/search-fixture-raw${suffix}`, outputPath = `/live/search-fixture-ai${suffix}`;
    const channels = [{ id: INPUT, name: 'Managed fixture input', upstreamProtocol: 'rtmp', streamName: inputPath.slice(6), downstreamProtocols: ['rtmp'], inputGeneration: String(generation), createdAt: now, updatedAt: now },
      { id: OUTPUT, name: 'Managed fixture AI output', upstreamProtocol: 'rtmp', streamName: outputPath.slice(6), downstreamProtocols: ['rtmp'], inputGeneration: String(generation), createdAt: now, updatedAt: now }];
    await store.upsertDocument({ service: 'channels', group: 'system', name: 'settings', config: { channels } }, 'isolated-fixture');
    await store.upsertDocument({ service: 'ai-service', group: 'channels', name: PROCESSOR, config: { enabled: true, inference_fps: 10,
      analytics: { enabled: true }, model: { adapter: 'yolov8_bpu' }, snapshot: { projection_mode: 'none' },
      stream: { url: 'rtmp://127.0.0.1' + inputPath }, publish: { enabled: true, target_url: 'rtmp://127.0.0.1' + outputPath } } }, 'isolated-fixture');
    const version = await store.publish('Isolated fixture AI source snapshot', 'isolated-fixture', { services: ['ai-service'], prepare: async () => {} });
    await store.updateServiceState({ serviceName: 'ai-service', desiredVersion: version.version, appliedVersion: version.version, status: 'applied', restartRequired: false });
  }
  async function publish(enabled: boolean) {
    const before = (await store.getServiceState('search-service'))?.desiredVersion;
    const old = await store.getDocument('search-service', 'system', 'settings');
    const settings = { ...structuredClone(DEFAULT_SEARCH_SETTINGS), ...(old?.config ?? {}), enabled,
      model: { package_id: 'siglip2-base-full-int8' }, index_storage: { volume_id: VOLUME, relative_path: options.relative_path },
      limits: { ...DEFAULT_SEARCH_SETTINGS.limits, producer_bytes: 33554432, retention_days: 1, max_samples: 1000, max_bytes: 134217728 } };
    const reply = await app.inject({ method: 'POST', url: '/api/v1/config/apply', headers: { 'x-fixture-admin': administrator },
      payload: { changes: [{ service: 'search-service', group: 'system', name: 'settings', config: settings }] } });
    if (reply.statusCode !== 202) throw new Error(reply.statusCode === 409 ? 'fixture_apply_busy' : 'fixture_publish_failed');
    const id = reply.json().data.id;
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const state = await store.getServiceState('search-service');
      if (state?.desiredVersion !== before) return { apply_id: id, desired_version: state!.desiredVersion };
      await sleep(25);
    }
    throw new Error('fixture_publish_timeout');
  }
  async function stop() {
    if (stopping) return; stopping = true;
    // Capture only bounded non-secret index/ACK metadata before this fixture's
    // owned schema is dropped, including on hardware assertion failures.
    try {
      const [jobRows, shardRows, ack] = await Promise.all([
        store.pool.query(`SELECT id,kind,state,generation,attempts,left(error_code,96) AS error_code,
          left(result_ref,160) AS result_ref,lease_owner,lease_until,expires_at,
          requested_checkpoint::text,claimed_checkpoint::text,completed_checkpoint::text,
          payload->>'shard_id' AS shard_id,payload->>'channel_id' AS channel_id,
          payload->>'model_version' AS model_version,payload->>'day' AS day
          FROM search_jobs WHERE actor='internal-search-index' AND kind IN ('index','rebuild') ORDER BY id LIMIT 32`),
        store.pool.query(`SELECT id,channel_id,model_version,day::text,state,revision::text,published_revision::text,
          checkpoint::text,record_count,byte_count::text,directory_storage_generation,storage_generation,
          published_storage_generation,build_job_id,build_job_generation
          FROM search_index_shards ORDER BY id LIMIT 32`),
        runtime.read(),
      ]);
      const debug = { fixture_only: true, fixture_mode: options.mode, recorded_at: new Date().toISOString(),
        actions, action_statuses: actionStatuses, acks, runtime: ack, jobs: jobRows.rows, shards: shardRows.rows };
      if (Buffer.byteLength(JSON.stringify(debug)) > 131072) throw new Error('debug_bound');
      writePrivate(resolve(directory, 'parameter-debug.json'), debug);
    } catch {
      writePrivate(resolve(directory, 'parameter-debug.json'), { fixture_only: true, capture_failed: true,
        reason: 'fixture_debug_unavailable', actions, action_statuses: actionStatuses, acks });
    }
    await app.close(); await store.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await store.init();
    const safeAi = await sanitizeImportDocSecrets('ai-service', { snapshot_store: { mongo_uri: 'mongodb://127.0.0.1:25440', db_name: database } }, store, 'isolated-fixture');
    await store.upsertDocument({ service: 'ai-service', group: 'system', name: 'settings', config: safeAi }, 'isolated-fixture');
    await saveSources();
    app.addHook('onRequest', async (request: any, reply: any) => {
      const service = resolveServiceByToken(tokens, request.headers['x-service-token']);
      const isAdmin = request.headers['x-fixture-admin'] === administrator;
      if (!service && !isAdmin) return reply.code(403).send({ error: 'forbidden' });
      if (service) request.boundService = service;
      if (request.url.startsWith('/fixture/') && !isAdmin) return reply.code(403).send({ error: 'forbidden' });
      if (request.url.startsWith('/api/v1/config/') && request.url.split('?')[0] !== '/api/v1/config/apply')
        return reply.code(403).send({ error: 'fixture_route_not_allowed' });
    });
    app.addHook('preHandler', async (request: any, reply: any) => {
      if (request.method === 'POST' && request.url === '/api/v1/config/apply' &&
          Array.isArray(request.body?.changes) && request.body.changes.some((change: any) => change.service !== 'search-service'))
        return reply.code(403).send({ error: 'fixture_service_not_allowed' });
    });
    app.addHook('onResponse', async (request: any, reply: any) => {
      if (request.url === '/api/internal/search/runtime-state' && reply.statusCode === 200 && request.body?.status === 'applied') {
        const proof = { desired_version: request.body.desired_version, revision: request.body.revision, at: Date.now() };
        lastAck = proof; acks.push({ desired_version: proof.desired_version, revision: proof.revision, status: 'applied', at_ms: proof.at });
        if (acks.length > 16) acks.shift();
        await refreshAccess(proof);
      }
      const action = request.body?.action;
      if (typeof action === 'string' && /^[a-z_]{1,24}$/.test(action) && Object.keys(actions).length < 32) actions[action] = (actions[action] ?? 0) + 1;
      if (typeof action === 'string' && /^[a-z_]{1,24}$/.test(action) && Object.keys(actionStatuses).length < 64) {
        const key = `${action}:${reply.statusCode}`; actionStatuses[key] = (actionStatuses[key] ?? 0) + 1;
      }
    });
    await app.register(configRoutes, { prefix: '/api', pgStore: store, orchestrator, serviceTokens: tokens });
    await app.register(searchRuntimeRoutes, { prefix: '/api', internalPrincipal: managementPrincipal, producerPrincipal,
      principal: async (request: any) => request.headers['x-fixture-admin'] === administrator ? 'isolated-admin' : null,
      dependencies, runtime, managementConnection: async () => null });
    await app.register(searchIndexRoutes, { prefix: '/api', principal: managementPrincipal, jobs, shards, context: async () => {
      const applied = await readAppliedSearchConfiguration(dependencies, runtime);
      return applied?.settings.enabled && applied.index_directory.generation && applied.active_model_pin ? { revision: applied.revision,
        storageGeneration: applied.index_directory.generation, packageId: applied.settings.model.package_id!,
        modelVersion: applied.active_model_pin.model_version,
        channels: applied.sources.map(source => source.channel_id), retentionDays: applied.settings.limits.retention_days } : null;
    } });
    app.get('/fixture/state', async () => {
      const state = await store.getServiceState('search-service'), ack = await runtime.read();
      const effective = await readEffectiveSearchConfiguration(dependencies);
      const index = await store.pool.query('SELECT state,count(*)::int AS count FROM search_jobs GROUP BY state ORDER BY state');
      const settings = await store.getDocument('search-service', 'system', 'settings');
      const callers = settings?.config.callers as { key?: string }[] | undefined;
      const aiSettings = await store.getDocument('ai-service', 'system', 'settings');
      const history = aiSettings?.config.snapshot_store as { mongo_uri?: string } | undefined;
      return { fixture_only: true, fixture_mode: options.mode, desired_version: state?.desiredVersion, applied_version: state?.appliedVersion ?? null,
        status: state?.status, enabled: effective.settings.enabled, revision: effective.revision, ack, access_ready: accessReady,
        source_generation: generation, sources: effective.sources, index_directory: effective.index_directory, jobs: index.rows, actions, acks,
        search_callers_encrypted: callers?.length === 2 && callers.every(c => /^\$\{secret:search-service\//.test(c.key ?? '')),
        history_connection_encrypted: /^\$\{secret:ai-service\//.test(history?.mongo_uri ?? ''),
        real_pg: true, actual_native_or_bpu_verified: false };
    });
    app.post('/fixture/control', async (request: any, reply: any) => {
      const body = z.object({ action: z.enum(['enable', 'disable', 'source_generation']) }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_fixture_control' });
      if (mutating) return reply.code(409).send({ error: 'fixture_control_busy' });
      mutating = true;
      try {
        await inactive('config_pending');
        if (body.data.action === 'source_generation') { ++generation; await saveSources(); return { source_generation: generation }; }
        return await publish(body.data.action === 'enable');
      } finally { mutating = false; if (lastAck) await refreshAccess(lastAck); }
    });
    await app.ready(); await inactive('config_pending'); await publish(true);
    writePrivate(resolve(directory, 'search-service-bootstrap.json'), { control_url: BASE, service_token: manager });
    writePrivate(resolve(directory, 'fixture-admin.json'), { base_url: BASE, admin_token: administrator, ai_service_token: ai });
    await app.listen({ host: '127.0.0.1', port: 25441 });
    const effective = await readEffectiveSearchConfiguration(dependencies);
    writePrivate(resolve(directory, 'parameter-ready.json'), { ready: true, fixture_only: true, fixture_mode: options.mode, port: 25441,
      desired_version: effective.desired_version, model_package_id: effective.settings.model.package_id, real_pg: true,
      storage_directory_created: false, actual_native_or_bpu_verified: false });
    process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
    return { close: stop };
  } catch {
    await stop().catch(() => {});
    throw new Error('isolated_managed_parameter_fixture_failed');
  }
}
