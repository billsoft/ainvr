// Real isolated PostgreSQL 001--024 + SearchJobs control integration.
// Native samples/receipts/index reports and AI are EXPLICIT SOFTWARE ORACLES.
// This does not validate MongoDB, JPEG/GLES/BPU execution or semantic accuracy.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { SearchJobs, type SearchJob } from '../store/searchJobs.js';
import { SearchRuntimeStore } from '../store/searchRuntimeStore.js';
import { DEFAULT_SEARCH_SETTINGS } from '../store/searchConfigAdapter.js';
import { SearchReencodeRunner } from '../services/searchReencodeRunner.js';
import { SearchReencodeAiError } from '../services/searchReencodeAi.js';
import { SearchNativeError, type SearchNativeClient, type NativeMigrationSample, type NativeMigrationTargetStored } from '../services/searchNativeClient.js';
import { type SearchModelMigrationPayload, type SearchModelMigrationProgress, searchModelMigrationFingerprint } from '../services/searchModelMigrationContract.js';
import { searchMigrationSourceIdsDigest, type SearchMigrationPlanPayload } from '../services/searchModelMigrationPlan.js';

const enabled = process.env.AINVR_SEARCH_TEST_PG === '1';
const h = (s: string) => s.repeat(64);
const sourcePin = { package_id: 'siglip2-base-full-int8', package_sha256: h('a'), model_version: `search-v1-${h('a')}` };
const targetPin = { package_id: 'siglip2-base-full-int8', package_sha256: h('b'), model_version: `search-v1-${h('b')}` };
const connection = { host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' };
async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const schema = 'search_runner_' + randomUUID().replaceAll('-', '');
  const admin = new Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connection, options: `-c search_path=${schema}`, max: 8 });
  try {
    const directory = new URL('../store/migrations/', import.meta.url);
    const files = readdirSync(directory).filter(name => /^(?:00[1-9]|01[0-9]|02[0-4])_.*\.sql$/.test(name)).sort();
    expect(files).toHaveLength(24);
    for (const name of files) await pool.query(readFileSync(new URL(name, directory), 'utf8'));
    await run(await fixture(pool));
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
async function fixture(pool: Pool) {
  const jobs = new SearchJobs(pool), runtime = new SearchRuntimeStore(pool), channel = randomUUID(), now = Date.now();
  const settings = { ...structuredClone(DEFAULT_SEARCH_SETTINGS), enabled: true, model: { package_id: sourcePin.package_id } };
  await pool.query(`UPDATE config_documents SET config=$1 WHERE service='search-service'`, [JSON.stringify(settings)]);
  await pool.query(`UPDATE config_snapshots SET config=$1 WHERE service='search-service'`, [JSON.stringify(settings)]);
  const version = (await pool.query(`SELECT desired_version FROM config_service_states WHERE service_name='search-service'`)).rows[0].desired_version as number;
  expect(await runtime.acknowledge({ desired_version: version, revision: h('c'), status: 'applied', error_code: null, active_model: sourcePin })).toBe(true);
  const scope = { channel_ids: [channel], from: new Date(now - 10000).toISOString(), to: new Date(now + 10000).toISOString() };
  const payload: SearchModelMigrationPayload = { schema_version: 'search-reencode-v1', purpose: 'reencode', source: sourcePin, target: targetPin,
    scope, config_revision: h('c'), storage_generation: h('d'), source_high_watermark: '100', batch_size: 32, acceptance_criteria_sha256: h('e') };
  const context = { revision: h('c'), storage_generation: h('d'), desired_version: version, source: sourcePin, channels: [channel] };
  const jpeg = Buffer.from([255, 216, 5, 255, 217]);
  const source: NativeMigrationSample = { id: randomUUID(), channel_id: channel, processor_id: 'software-oracle-processor',
    stream_session_id: 'software-oracle-session', track_id: 'track-1', model_version: sourcePin.model_version,
    captured_ms: now, expires_ms: now + 3600000, kind: 'object', fingerprint: h('f'), ordinal: '99',
    jpeg_sha256: createHash('sha256').update(jpeg).digest('hex'), evidence: { schema_version: '1.0', source_input_id: randomUUID(),
      output_channel_id: channel, recording_channel_id: channel, stream_session_id: 'software-oracle-session', source_pts_ns: '123000000',
      source_frame_index: '1', frame_id: randomUUID(), frame_width: 1920, frame_height: 1080, role: 'match' } };
  const stored: NativeMigrationTargetStored = { stored: true, sample_id: randomUUID(), model_version: targetPin.model_version,
    fingerprint: h('1'), ordinal: '200', jpeg_sha256: source.jpeg_sha256 };
  const oracle = { committed: false };
  const profile = { ...targetPin, dimensions: 3, input_spec_version: 'explicit-software-oracle-only', files_verified: true,
    production_approval_declared: true, pruned: false, runtime_ready: false as const };
  const native = {
    verifyMigrationModel: vi.fn<SearchNativeClient['verifyMigrationModel']>(async () => profile),
    scanMigration: vi.fn<SearchNativeClient['scanMigration']>(async () => ({ source_model: sourcePin.model_version, through: '100', items: [source], next_cursor: null, exhausted: true })),
    migrationImage: vi.fn<SearchNativeClient['migrationImage']>(async () => jpeg),
    migrationTargetReceipt: vi.fn<SearchNativeClient['migrationTargetReceipt']>(async () => oracle.committed ? { ...stored, status: 'committed' } :
      { stored: false, status: 'not_found', sample_id: null, fingerprint: null, ordinal: null, jpeg_sha256: null, model_version: targetPin.model_version }),
    migrationWriteTarget: vi.fn<SearchNativeClient['migrationWriteTarget']>(async () => { oracle.committed = true; return stored; }),
    migrationArtifacts: vi.fn<SearchNativeClient['migrationArtifacts']>(async () => ({ state: 'ready', checkpoint: '100', source_completed_through: '100',
      target_checkpoint: oracle.committed ? '200' : '0', coverage_snapshot: { required: 1, matched: oracle.committed ? 1 : 0, unavailable: oracle.committed ? 0 : 1 },
      coverage_sha256: h('2'), index_manifest_sha256: h('3'), reason: null })),
  };
  const ai = { capabilities: vi.fn(async () => ({ schema_version: 'search-reencode-capabilities-v1' as const,
    implemented: true, target_package_ids: [targetPin.package_id], max_image_bytes: 8388608, max_duration_ms: 30000,
    cpu_model_fallback: false as const, cpu_image_processing: false as const })),
    encode: vi.fn(async (input: Parameters<import('../services/searchReencodeAi.js').SearchReencodeAiClient['encode']>[0]) => ({
    ...input.request, input_kind: 'retained-jpeg' as const, preprocessing_version: 'jpeg-jpu-full-bt601-gles-area256-v1' as const,
    image_width: 104, image_height: 320, dimensions: 3, vector: [1, 0, 0] })) };
  const artifacts = { prepare: vi.fn(async (job: SearchJob) => ({ report: { schema_version: 'search-reencode-artifacts-v1' as const,
    payload_fingerprint: searchModelMigrationFingerprint(job.payload as SearchModelMigrationPayload), source: sourcePin, target: targetPin, scope,
    source_completed_through: '100', target_checkpoint: oracle.committed ? '200' : '0', scanned: 1, encoded: oracle.committed ? 1 : 0,
    unavailable: oracle.committed ? 0 : 1, coverage_sha256: h('2'), partitions: oracle.committed ? [{ channel_id: channel,
      day: new Date(now).toISOString().slice(0, 10), checkpoint: '200', records: 1 }] : [] }, index_manifest_sha256: h('3') })) };
  // Real PG methods remain the only task/lease/checkpoint authority. Spies can
  // drop a committed reply without replacing the SQL implementation.
  const port = { get: jobs.get.bind(jobs), renewMigration: vi.fn(jobs.renewMigration.bind(jobs)),
    authorizeMigrationWrite: vi.fn(jobs.authorizeMigrationWrite.bind(jobs)), authorizeMigrationArtifacts: vi.fn(jobs.authorizeMigrationArtifacts.bind(jobs)),
    checkpointMigration: vi.fn(jobs.checkpointMigration.bind(jobs)), finishMigration: vi.fn(jobs.finishMigration.bind(jobs)), failMigration: vi.fn(jobs.failMigration.bind(jobs)) };
  const readContext = vi.fn(async () => context);
  const runner = () => new SearchReencodeRunner({ jobs: port, native, ai, artifacts, context: readContext, heartbeatMs: 100, retryMs: 10 });
  const claim = async () => { await jobs.enqueueMigration('administrator', randomUUID(), payload); const worker = randomUUID();
    const job = (await jobs.claimMigration(worker))!; expect(job).not.toBeNull(); return { job, worker }; };
  return { jobs, pool, runtime, payload, context, scope, channel, source, stored, oracle, ai, native, artifacts, port, readContext, runner, claim };
}

it.skipIf(!enabled)('actual PG claim/authorize/checkpoint/finish reaches awaiting acceptance without changing active model', async () => isolated(async f => {
  const { job, worker } = await f.claim(); expect(await f.runner().runClaimed(job, worker)).toBe('finished');
  const saved = (await f.jobs.get(job.id, job.actor))!;
  expect(saved).toMatchObject({ state: 'succeeded', lease_owner: null, migration_acceptance: null });
  expect(saved.migration_progress).toMatchObject({ phase: 'awaiting_acceptance', scanned: 1, encoded: 1, unavailable: 0, target_checkpoint: '200' });
  expect(f.port.authorizeMigrationWrite).toHaveBeenCalled(); expect(f.port.authorizeMigrationArtifacts).toHaveBeenCalled();
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect((await f.runtime.read())!.active_model).toEqual(sourcePin);
  expect(JSON.stringify(saved.migration_progress)).not.toMatch(/vector|jpeg|api_token/);
}));
it.skipIf(!enabled)('a real committed checkpoint with a lost response is retried as the identical PG CAS exactly once', async () => isolated(async f => {
  const { job, worker } = await f.claim();
  f.port.checkpointMigration.mockImplementationOnce(async (...args) => { expect(await f.jobs.checkpointMigration(...args)).toBe(true); throw Error('test_lost_committed_pg_reply'); });
  expect(await f.runner().runClaimed(job, worker)).toBe('finished');
  expect(f.port.checkpointMigration.mock.calls[0]).toEqual(f.port.checkpointMigration.mock.calls[1]);
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1 });
}));
it.skipIf(!enabled)('a lost finish response is reconciled from the actual durable succeeded row', async () => isolated(async f => {
  const { job, worker } = await f.claim();
  f.port.finishMigration.mockImplementationOnce(async (...args) => { expect(await f.jobs.finishMigration(...args)).toBe(true); throw Error('test_lost_finish_reply'); });
  expect(await f.runner().runClaimed(job, worker)).toBe('finished'); expect(f.port.finishMigration).toHaveBeenCalledOnce();
  expect(f.port.failMigration).not.toHaveBeenCalled(); expect((await f.jobs.get(job.id, job.actor))!.state).toBe('succeeded');
}));
it.skipIf(!enabled)('unknown target ACK across runner/process replacement recovers via receipt under a newly claimed real PG generation', async () => isolated(async f => {
  const { job, worker } = await f.claim(); const cancel = new AbortController();
  f.native.migrationWriteTarget.mockImplementationOnce(async () => { f.oracle.committed = true; cancel.abort(); throw new SearchNativeError('unavailable'); });
  expect(await f.runner().runClaimed(job, worker, cancel.signal)).toBe('stale');
  expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 0, cursor: null });
  await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
  const nextWorker = randomUUID(), recovered = (await f.jobs.claimMigration(nextWorker))!;
  expect(recovered.generation).toBe(job.generation + 1); expect(await f.jobs.renewMigration(job.id, worker, job.generation)).toBe(false);
  expect(await f.runner().runClaimed(recovered, nextWorker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1, target_checkpoint: f.stored.ordinal });
}));
it.skipIf(!enabled)('unknown write plus absent oracle receipt retries the same frozen body before the real PG cursor moves', async () => isolated(async f => {
  const { job, worker } = await f.claim(); f.native.migrationWriteTarget.mockRejectedValueOnce(new SearchNativeError('unavailable'));
  expect(await f.runner().runClaimed(job, worker)).toBe('finished');
  expect(f.native.migrationWriteTarget).toHaveBeenCalledTimes(2); expect(f.native.migrationWriteTarget.mock.calls[0]).toEqual(f.native.migrationWriteTarget.mock.calls[1]);
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1 });
}));
it.skipIf(!enabled)('a committed target ACK and an unavailable receipt lookup recover without repeating AI or advancing real PG twice', async () => isolated(async f => {
  const { job, worker } = await f.claim(), lookup = f.native.migrationTargetReceipt.getMockImplementation()!;
  f.native.migrationTargetReceipt.mockImplementationOnce((...args) => lookup(...args)).mockRejectedValueOnce(new SearchNativeError('unavailable'));
  f.native.migrationWriteTarget.mockImplementationOnce(async () => { f.oracle.committed = true; throw new SearchNativeError('unavailable'); });
  expect(await f.runner().runClaimed(job, worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect(f.native.migrationTargetReceipt).toHaveBeenCalledTimes(3);
  expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1, unavailable: 0, target_checkpoint: '200' });
}));
it.skipIf(!enabled)('a replaced old target does not skip a newly authorized source during final incremental migration', async () => isolated(async f => {
  const { job, worker } = await f.claim();
  f.native.migrationTargetReceipt.mockResolvedValueOnce({ status: 'replaced', stored: false, sample_id: null, fingerprint: null,
    ordinal: null, jpeg_sha256: null, model_version: targetPin.model_version });
  expect(await f.runner().runClaimed(job, worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect(f.port.authorizeMigrationWrite.mock.calls.some(call => call[6] && (call[6] as { fingerprint?: string }).fingerprint === f.source.fingerprint)).toBe(true);
  expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1, unavailable: 0 });
}));
it.skipIf(!enabled)('real cancellation during software inference fences writes and leaves no fabricated terminal ACK', async () => isolated(async f => {
  const { job, worker } = await f.claim(), encode = f.ai.encode.getMockImplementation()!;
  f.ai.encode.mockImplementationOnce(async input => { expect(await f.jobs.cancelMigration(job.id, job.actor)).toBe(true); return encode(input); });
  expect(await f.runner().runClaimed(job, worker)).toBe('stale'); expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
  expect(f.port.checkpointMigration).not.toHaveBeenCalled(); expect(f.port.failMigration).not.toHaveBeenCalled();
  expect((await f.jobs.get(job.id, job.actor, true))!).toMatchObject({ state: 'cancelled', generation: job.generation + 1 });
}));
it.skipIf(!enabled)('actual expired lease and replacement worker generation reject old inference before target write', async () => isolated(async f => {
  const { job, worker } = await f.claim(), encode = f.ai.encode.getMockImplementation()!; let next: SearchJob | null = null; const replacement = randomUUID();
  f.ai.encode.mockImplementationOnce(async input => { await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
    next = await f.jobs.claimMigration(replacement); return encode(input); });
  expect(await f.runner().runClaimed(job, worker)).toBe('stale'); expect(next!.generation).toBe(job.generation + 1);
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled(); expect(f.port.checkpointMigration).not.toHaveBeenCalled();
  expect(await f.runner().runClaimed(next!, replacement)).toBe('finished'); expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 1, encoded: 1 });
}));
it.skipIf(!enabled)('a real runtime revision change revokes migration permission even if the context oracle is stale', async () => isolated(async f => {
  const { job, worker } = await f.claim(), encode = f.ai.encode.getMockImplementation()!;
  f.ai.encode.mockImplementationOnce(async input => { await f.pool.query(`UPDATE search_runtime_state SET revision=$1 WHERE singleton=true`, [h('f')]); return encode(input); });
  expect(await f.runner().runClaimed(job, worker)).toBe('stale'); expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
  expect(f.port.checkpointMigration).not.toHaveBeenCalled(); expect((await f.jobs.get(job.id, job.actor))!.migration_progress).toMatchObject({ scanned: 0 });
}));
it.skipIf(!enabled)('unimplemented retained-JPEG target capability fails the real job before exporting original evidence', async () => isolated(async f => {
  const { job, worker } = await f.claim();f.ai.capabilities.mockResolvedValueOnce({ schema_version: 'search-reencode-capabilities-v1',
    implemented: false, target_package_ids: [], max_image_bytes: 8388608, max_duration_ms: 30000, cpu_model_fallback: false, cpu_image_processing: false });
  expect(await f.runner().runClaimed(job, worker)).toBe('failed');
  expect((await f.jobs.get(job.id, job.actor))!).toMatchObject({ state: 'failed', error_code: 'model_unavailable' });
  expect(f.native.migrationImage).not.toHaveBeenCalled();expect(f.ai.encode).not.toHaveBeenCalled();
}));
it.skipIf(!enabled)('AI authorization refusal releases the real PG job without retrying forever or counting an encoded image', async () => isolated(async f => {
  const { job, worker } = await f.claim();f.ai.encode.mockRejectedValueOnce(new SearchReencodeAiError('not_authorized'));
  expect(await f.runner().runClaimed(job, worker)).toBe('failed');expect(f.ai.encode).toHaveBeenCalledOnce();
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
  expect((await f.jobs.get(job.id, job.actor))!).toMatchObject({ state: 'failed', migration_progress: expect.objectContaining({ scanned: 0, encoded: 0 }) });
}));
it.skipIf(!enabled)('plan child claims and execution require the same actual parent worker', async () => isolated(async f => {
  const plan: SearchMigrationPlanPayload = { schema_version: 'search-reencode-plan-v1', purpose: 'reencode_plan', source: sourcePin, target: targetPin,
    config_revision: f.payload.config_revision, storage_generation: f.payload.storage_generation, acceptance_criteria_sha256: f.payload.acceptance_criteria_sha256,
    source_count: 1, source_ids_sha256: searchMigrationSourceIdsDigest([f.channel]), extent: { from_ms: Date.parse(f.scope.from), to_ms: Date.parse(f.scope.to), source_high_watermark: '100' } };
  const parent = await f.jobs.enqueueMigrationPlan('administrator', randomUUID(), plan), worker = randomUUID();
  const lease = (await f.jobs.claimMigrationPlan(worker))!; expect(lease.id).toBe(parent.id);
  const children = (await f.jobs.prepareMigrationPlanChildren(parent.id, worker, lease.generation, [f.channel]))!.created;
  expect(children).toHaveLength(1); const other = randomUUID(); expect(await f.jobs.claimMigration(other)).toBeNull();
  const child = (await f.jobs.claimMigration(worker))!; expect(child.id).toBe(children[0]!.id);
  expect(await f.runner().runClaimed(child, other)).toBe('stale'); expect(f.ai.encode).not.toHaveBeenCalled();
  expect(await f.runner().runClaimed(child, worker)).toBe('finished');
  expect((await f.jobs.get(child.id, child.actor))!).toMatchObject({ state: 'succeeded', migration_acceptance: null });
  expect((await f.jobs.get(parent.id, parent.actor))!.state).toBe('running');
}));
it.skipIf(!enabled)('expiring a real parent lease during child inference blocks child writes and checkpointing', async () => isolated(async f => {
  const plan: SearchMigrationPlanPayload = { schema_version: 'search-reencode-plan-v1', purpose: 'reencode_plan', source: sourcePin, target: targetPin,
    config_revision: f.payload.config_revision, storage_generation: f.payload.storage_generation, acceptance_criteria_sha256: f.payload.acceptance_criteria_sha256,
    source_count: 1, source_ids_sha256: searchMigrationSourceIdsDigest([f.channel]), extent: { from_ms: Date.parse(f.scope.from), to_ms: Date.parse(f.scope.to), source_high_watermark: '100' } };
  const parent = await f.jobs.enqueueMigrationPlan('administrator', randomUUID(), plan), worker = randomUUID(), lease = (await f.jobs.claimMigrationPlan(worker))!;
  await f.jobs.prepareMigrationPlanChildren(parent.id, worker, lease.generation, [f.channel]); const child = (await f.jobs.claimMigration(worker))!;
  const encode = f.ai.encode.getMockImplementation()!;
  f.ai.encode.mockImplementationOnce(async input => { await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [parent.id]); return encode(input); });
  expect(await f.runner().runClaimed(child, worker)).toBe('stale'); expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
  expect(f.port.checkpointMigration).not.toHaveBeenCalled(); expect((await f.jobs.get(child.id, child.actor))!.migration_progress).toMatchObject({ scanned: 0 });
}));
