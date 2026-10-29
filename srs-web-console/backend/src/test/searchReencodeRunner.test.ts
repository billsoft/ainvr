import { randomUUID, createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SearchReencodeRunner } from '../services/searchReencodeRunner.js';
import { SearchReencodeAiError } from '../services/searchReencodeAi.js';
import { SearchMigrationArtifactError } from '../services/searchModelMigrationArtifacts.js';
import { SearchNativeError, type NativeMigrationSample, type SearchNativeClient } from '../services/searchNativeClient.js';
import { searchModelMigrationFingerprint, type SearchModelMigrationProgress, type SearchModelMigrationPayload } from '../services/searchModelMigrationContract.js';
import type { SearchJob } from '../store/searchJobs.js';

/** Explicit software ports: these tests cover orchestration/uncertainty, not
 * physical BPU, a PG transaction, Mongo persistence or actual index coverage. */
function fixture() {
  const now = Date.now(), worker = randomUUID(), channel = randomUUID();
  const sourcePin = { package_id: 'old-package', package_sha256: 'a'.repeat(64), model_version: `search-v1-${'a'.repeat(64)}` };
  const targetPin = { package_id: 'siglip2-base-full-int8', package_sha256: 'b'.repeat(64), model_version: `search-v1-${'b'.repeat(64)}` };
  const jpeg = Buffer.from([255,216,5,255,217]), imageSha = createHash('sha256').update(jpeg).digest('hex');
  const scope = { channel_ids: [channel], from: new Date(now-10000).toISOString(), to: new Date(now+10000).toISOString() };
  const payload: SearchModelMigrationPayload = { schema_version: 'search-reencode-v1', purpose: 'reencode',
    source: sourcePin, target: targetPin, scope, config_revision: 'c'.repeat(64), storage_generation: 'd'.repeat(64),
    source_high_watermark: '9007199254740994', batch_size: 32, acceptance_criteria_sha256: 'e'.repeat(64) };
  const fp = searchModelMigrationFingerprint(payload);
  const progress: SearchModelMigrationProgress = { schema_version: 'search-reencode-progress-v1', payload_fingerprint: fp,
    phase: 'encoding', cursor: null, scanned: 0, encoded: 0, unavailable: 0, source_completed_through: null,
    target_checkpoint: null, coverage_sha256: null, index_manifest_sha256: null };
  const job: SearchJob = { id: randomUUID(), actor: 'administrator', kind: 'rebuild', payload, state: 'running', generation: 1,
    attempts: 1, lease_owner: worker, lease_until: new Date(now+30000), expires_at: new Date(now+600000), migration_progress: progress };
  const source: NativeMigrationSample = { id: randomUUID(), fingerprint: 'f'.repeat(64), ordinal: '9007199254740993',
    jpeg_sha256: imageSha, channel_id: channel, processor_id: randomUUID(), stream_session_id: 'original-session', track_id: 'person-7',
    captured_ms: now, expires_ms: now+600000, model_version: sourcePin.model_version, kind: 'object', evidence: {
      schema_version: '1.0', source_input_id: randomUUID(), output_channel_id: randomUUID(), recording_channel_id: randomUUID(),
      stream_session_id: 'original-session', source_pts_ns: '9007199254740993000', source_frame_index: '128', frame_id: randomUUID(),
      frame_width: 1920, frame_height: 1080, role: 'match',
    } };
  const stored = { stored: true as const, sample_id: randomUUID(), model_version: targetPin.model_version,
    fingerprint: '1'.repeat(64), ordinal: '9007199254740994', jpeg_sha256: imageSha };
  let committed = false;
  const profile = { ...targetPin, dimensions: 3, input_spec_version: 'test-only', files_verified: true,
    production_approval_declared: true, pruned: false, runtime_ready: false as const };
  const context = vi.fn(async () => ({ revision: payload.config_revision, storage_generation: payload.storage_generation,
    desired_version: 12, source: sourcePin, channels: [channel] }));
  const jobs = {
    get: vi.fn(async () => structuredClone(job)), renewMigration: vi.fn(async () => true),
    authorizeMigrationWrite: vi.fn(async () => ({ job_id: job.id, worker, generation: job.generation, payload_fingerprint: fp,
      source: sourcePin, target: targetPin, scope: { channel_ids: [channel], from_ms: now-10000, to_ms: now+10000 },
      source_high_watermark: payload.source_high_watermark, lease_until_ms: Date.now()+30000, job_expires_ms: now+600000, target_checkpoint: '0' })),
    authorizeMigrationArtifacts: vi.fn(async () => jobs.authorizeMigrationWrite()),
    checkpointMigration: vi.fn(async (_id, _worker, _generation, before, after) => {
      if (JSON.stringify(job.migration_progress) === JSON.stringify(after)) return true;
      expect(job.migration_progress).toEqual(before); job.migration_progress = structuredClone(after); return true;
    }),
    finishMigration: vi.fn(async () => { job.state = 'succeeded'; return true; }),
    failMigration: vi.fn(async (_id, _worker, _generation, code) => { job.state = 'failed'; job.error_code = code; return true; }),
  };
  const native = {
    verifyMigrationModel: vi.fn(async () => profile),
    scanMigration: vi.fn<SearchNativeClient['scanMigration']>(async () => ({ source_model: sourcePin.model_version, through: payload.source_high_watermark,
      items: [source], next_cursor: null, exhausted: true })),
    migrationImage: vi.fn(async () => jpeg),
    migrationTargetReceipt: vi.fn(async () => committed ? { ...stored, status: 'committed' as const } :
      { stored: false as const, status: 'not_found' as const, sample_id: null, fingerprint: null, ordinal: null,
        jpeg_sha256: null, model_version: targetPin.model_version }),
    migrationWriteTarget: vi.fn(async () => { committed = true; return stored; }),
    migrationArtifacts: vi.fn(async () => ({ state: 'ready', checkpoint: payload.source_high_watermark,
      source_completed_through: payload.source_high_watermark, target_checkpoint: stored.ordinal,
      coverage_snapshot: { required: 1, matched: 1, unavailable: 0 }, coverage_sha256: '2'.repeat(64),
      index_manifest_sha256: '3'.repeat(64), reason: null })),
  };
  const ai = { capabilities: vi.fn(async () => ({ schema_version: 'search-reencode-capabilities-v1', implemented: true,
    target_package_ids: [targetPin.package_id], max_image_bytes: 8388608, max_duration_ms: 30000,
    cpu_model_fallback: false, cpu_image_processing: false })), encode: vi.fn(async input => ({ ...input.request, input_kind: 'retained-jpeg',
    preprocessing_version: 'jpeg-jpu-full-bt601-gles-area256-v1', image_width: 104, image_height: 320, dimensions: 3, vector: [1,0,0] })) };
  const artifacts = { prepare: vi.fn(async () => ({ report: { schema_version: 'search-reencode-artifacts-v1',
    payload_fingerprint: fp, source: sourcePin, target: targetPin, scope, source_completed_through: payload.source_high_watermark,
    target_checkpoint: committed ? stored.ordinal : '0', scanned: 1, encoded: committed ? 1 : 0, unavailable: committed ? 0 : 1,
    coverage_sha256: '2'.repeat(64), partitions: committed ? [{ channel_id: channel, day: new Date(now).toISOString().slice(0,10),
      checkpoint: stored.ordinal, records: 1 }] : [] }, index_manifest_sha256: '3'.repeat(64) })) };
  const runner = () => new SearchReencodeRunner({ jobs: jobs as never, native: native as never, ai: ai as never,
    artifacts: artifacts as never, context, retryMs: 10, heartbeatMs: 100 });
  return { runner, worker, source, job, jobs, native, ai, profile, payload, jpeg, context, artifacts, stored,
    commit: () => { committed = true; } };
}
it('uses one real-work port sequence and finishes awaiting acceptance without activating a model', async () => {
  const f = fixture(); expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.native.scanMigration).toHaveBeenCalledWith(f.payload.source.model_version, f.payload.scope, null, '9007199254740994', 32);
  expect(f.ai.encode).toHaveBeenCalledTimes(1); expect(f.ai.encode.mock.calls[0]![0].jpeg).toEqual(f.jpeg);
  expect(f.native.migrationWriteTarget.mock.calls[0]!.slice(1)).toEqual([f.source, f.profile, [1,0,0]]);
  const final = f.job.migration_progress as SearchModelMigrationProgress;
  expect(final).toMatchObject({ phase: 'awaiting_acceptance', scanned: 1, encoded: 1, unavailable: 0,
    target_checkpoint: '9007199254740994', coverage_snapshot: { required: 1, matched: 1, unavailable: 0 } });
  expect(JSON.stringify(final)).not.toContain('vector'); expect(f.jobs.finishMigration).toHaveBeenCalledOnce();
});
it('adopts a proven old target receipt without loading an image or invoking BPU again', async () => {
  const f = fixture(); f.commit(); f.job.attempts = 2; f.job.generation = 2;
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).not.toHaveBeenCalled(); expect(f.native.migrationImage).not.toHaveBeenCalled();
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
});
it('recovers a lost target-write ACK from its actual receipt and never reencodes', async () => {
  const f = fixture(); f.native.migrationWriteTarget.mockImplementationOnce(async () => { f.commit(); throw new SearchNativeError('unavailable'); });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished'); expect(f.ai.encode).toHaveBeenCalledOnce();
  expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
});
it('an absent receipt after an unknown write only permits an identical frozen body retry', async () => {
  const f = fixture(); f.native.migrationWriteTarget.mockRejectedValueOnce(new SearchNativeError('unavailable'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished'); expect(f.ai.encode).toHaveBeenCalledOnce();
  expect(f.native.migrationWriteTarget).toHaveBeenCalledTimes(2);
  expect(f.native.migrationWriteTarget.mock.calls[0]).toEqual(f.native.migrationWriteTarget.mock.calls[1]);
});
it('first-write-wins adoption records the actual stored fingerprint, not the newly computed vector as a new write', async () => {
  const f = fixture(); f.job.attempts = 2; f.job.generation = 2;
  // The Native oracle returns its prior immutable vector's receipt after this
  // process reencoded the same original; no new ordinal is allocated.
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect((f.job.migration_progress as SearchModelMigrationProgress).target_checkpoint).toBe(f.stored.ordinal);
  expect(f.jobs.checkpointMigration.mock.calls[0]![4].encoded).toBe(1);
});
it('a changed source is unavailable without exporting another image', async () => {
  const f = fixture(); f.native.migrationTargetReceipt.mockResolvedValueOnce({ stored: false, status: 'source_changed',
    sample_id: null, fingerprint: null, ordinal: null, jpeg_sha256: null, model_version: f.payload.target.model_version } as never);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).not.toHaveBeenCalled(); expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
  expect(f.job.migration_progress).toMatchObject({ encoded: 0, unavailable: 1 });
});
it('a newly advanced source slot can catch up through the authoritative Native conditional write', async () => {
  const f = fixture(); f.native.migrationTargetReceipt.mockResolvedValueOnce({ stored: false, status: 'replaced',
    sample_id: null, fingerprint: null, ordinal: null, jpeg_sha256: null, model_version: f.payload.target.model_version } as never);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect(f.job.migration_progress).toMatchObject({ encoded: 1, unavailable: 0 });
});
it('an authoritative rejected slot replacement does not become an unconditional overwrite', async () => {
  const f = fixture(); f.native.migrationTargetReceipt.mockResolvedValue({ stored: false, status: 'replaced',
    sample_id: null, fingerprint: null, ordinal: null, jpeg_sha256: null, model_version: f.payload.target.model_version } as never);
  f.native.migrationWriteTarget.mockRejectedValueOnce(new SearchNativeError('conflict'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce(); expect(f.job.migration_progress).toMatchObject({ encoded: 0, unavailable: 1 });
});
it('configuration change during inference prohibits the target write and cursor advancement', async () => {
  const f = fixture(), original = f.ai.encode.getMockImplementation()!;
  f.ai.encode.mockImplementationOnce(async input => { f.context.mockResolvedValue(null as never); return original(input); });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed');
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled(); expect(f.jobs.checkpointMigration).not.toHaveBeenCalled();
  expect(f.job.error_code).toBe('source_changed');
});
it('caller cancellation never publishes an in-flight result or reports a fake terminal failure', async () => {
  const f = fixture(), cancel = new AbortController();
  f.ai.encode.mockImplementationOnce(async () => { cancel.abort(); throw new SearchReencodeAiError('cancelled'); });
  expect(await f.runner().runClaimed(f.job, f.worker, cancel.signal)).toBe('stale');
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled(); expect(f.jobs.failMigration).not.toHaveBeenCalled();
});
it('losing renewal while BPU runs revokes the result before a write', async () => {
  const f = fixture(), original = f.ai.encode.getMockImplementation()!;
  f.jobs.renewMigration.mockResolvedValueOnce(true).mockResolvedValue(false);
  f.ai.encode.mockImplementationOnce(async input => { await new Promise(resolve => setTimeout(resolve, 140)); return original(input); });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('stale');
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled(); expect(f.jobs.failMigration).not.toHaveBeenCalled();
});
it('retries an uncertain checkpoint using the identical before/after CAS without recomputing or rewriting', async () => {
  const f = fixture(), original = f.jobs.checkpointMigration.getMockImplementation()!;
  f.jobs.checkpointMigration.mockImplementationOnce(async (...args) => { await original(...args); throw Error('lost PG reply'); });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect(f.jobs.checkpointMigration.mock.calls[0]).toEqual(f.jobs.checkpointMigration.mock.calls[1]);
});
it('uses current durable progress after restart rather than a stale caller snapshot', async () => {
  const f = fixture(), stale = structuredClone(f.job); f.commit();
  f.job.migration_progress = { ...(f.job.migration_progress as SearchModelMigrationProgress), phase: 'building_index',
    cursor: { ordinal: f.source.ordinal, sample_id: f.source.id }, scanned: 1, encoded: 1,
    source_completed_through: f.payload.source_high_watermark, target_checkpoint: f.stored.ordinal };
  expect(await f.runner().runClaimed(stale, f.worker)).toBe('finished');
  expect(f.native.scanMigration).not.toHaveBeenCalled(); expect(f.ai.encode).not.toHaveBeenCalled();
});
it('waits for actual index/report availability instead of treating encoding completion as ready', async () => {
  const f = fixture(); f.artifacts.prepare.mockRejectedValueOnce(new SearchMigrationArtifactError());
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished'); expect(f.artifacts.prepare).toHaveBeenCalledTimes(2);
  expect(f.ai.encode).toHaveBeenCalledOnce();
});
it('a missing retained JPEG is reported unavailable without generating a substitute image', async () => {
  const f = fixture(); f.native.migrationImage.mockResolvedValueOnce(null as never);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished'); expect(f.ai.encode).not.toHaveBeenCalled();
  expect(f.job.migration_progress).toMatchObject({ phase: 'awaiting_acceptance', unavailable: 1,
    coverage_snapshot: { required: 1, matched: 0, unavailable: 1 } });
});
it('a pruned or changed model package fails before evidence export or inference', async () => {
  const f = fixture(); f.profile.pruned = true;
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('model_unavailable');
  expect(f.native.migrationImage).not.toHaveBeenCalled(); expect(f.ai.encode).not.toHaveBeenCalled();
});
it('one runner refuses a concurrent leased execution instead of creating a second queue', async () => {
  const f = fixture(), runner = f.runner(), original = f.ai.encode.getMockImplementation()!;
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.ai.encode.mockImplementationOnce(async input => { await waiting; return original(input); });
  const first = runner.runClaimed(f.job, f.worker); await vi.waitFor(() => expect(f.ai.encode).toHaveBeenCalled());
  expect(await runner.runClaimed(f.job, f.worker)).toBe('busy'); release(); expect(await first).toBe('finished');
});
it('unsupported images remain explicit missing evidence without a CPU fallback', async () => {
  const f = fixture(); f.ai.encode.mockRejectedValueOnce(new SearchReencodeAiError('unsupported_image'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished'); expect(f.ai.encode).toHaveBeenCalledOnce();
  expect(f.native.migrationWriteTarget).not.toHaveBeenCalled(); expect(f.job.migration_progress).toMatchObject({ unavailable: 1 });
});
it('capacity rejection is terminal for the job and does not endlessly retry or evict source evidence', async () => {
  const f = fixture(); f.native.migrationWriteTarget.mockRejectedValueOnce(new SearchNativeError('capacity'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('capacity_exceeded');
  expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce(); expect(f.jobs.checkpointMigration).not.toHaveBeenCalled();
});
it('does not allow stale workers to query originals or renew a replacement lease', async () => {
  const f = fixture(); f.job.lease_owner = randomUUID();
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('stale');
  expect(f.native.verifyMigrationModel).not.toHaveBeenCalled(); expect(f.jobs.renewMigration).not.toHaveBeenCalled();
});
it('lost finish acknowledgement is reconciled against the identical durable succeeded row', async () => {
  const f = fixture(), original = f.jobs.finishMigration.getMockImplementation()!;
  f.jobs.finishMigration.mockImplementationOnce(async () => { await original(); throw Error('lost finish ACK'); });
  f.jobs.finishMigration.mockImplementationOnce(async () => false);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.jobs.failMigration).not.toHaveBeenCalled();
});
it('hidden-only metadata pages advance transient scan position without fabricating PG sample counts', async () => {
  const f = fixture(); f.native.scanMigration.mockResolvedValueOnce({ source_model: f.payload.source.model_version,
    through: f.payload.source_high_watermark, items: [], next_cursor: '9007199254740992', exhausted: false });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.native.scanMigration.mock.calls[1]![2]).toBe('9007199254740992');
  expect(f.job.migration_progress).toMatchObject({ scanned: 1, encoded: 1, unavailable: 0 });
  expect(f.jobs.checkpointMigration).toHaveBeenCalledTimes(3);
});
it('an unknown failure acknowledgement is never advertised as a confirmed terminal state', async () => {
  const f = fixture(); f.profile.pruned = true; f.jobs.failMigration.mockRejectedValueOnce(Error('unknown PG write'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('stale'); expect(f.job.state).toBe('running');
});
it('temporary metadata/receipt outages retry only reads without rerunning BPU or losing progress', async () => {
  const f = fixture(); f.native.scanMigration.mockRejectedValueOnce(new SearchNativeError('busy'));
  f.native.migrationTargetReceipt.mockRejectedValueOnce(new SearchNativeError('unavailable'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.native.scanMigration).toHaveBeenCalledTimes(2); expect(f.ai.encode).toHaveBeenCalledOnce();
  expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce(); expect(f.jobs.failMigration).not.toHaveBeenCalled();
});
it('read retries recheck context and cannot export originals after a configuration change', async () => {
  const f = fixture(); f.native.migrationTargetReceipt.mockImplementationOnce(async () => {
    f.context.mockResolvedValue(null as never); throw new SearchNativeError('unavailable');
  });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('source_changed');
  expect(f.native.migrationTargetReceipt).toHaveBeenCalledOnce(); expect(f.native.migrationImage).not.toHaveBeenCalled();
});
it('a package without a hardware reencoder fails preflight instead of retrying indefinitely', async () => {
  const f = fixture(); f.ai.capabilities.mockResolvedValueOnce({ implemented: false, target_package_ids: [] } as never);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('model_unavailable');
  expect(f.native.scanMigration).not.toHaveBeenCalled(); expect(f.native.migrationImage).not.toHaveBeenCalled();
  expect(f.ai.encode).not.toHaveBeenCalled();
});
it('a license denial does not become a perpetual transient hardware retry', async () => {
  const f = fixture(); f.ai.encode.mockRejectedValueOnce(new SearchReencodeAiError('not_authorized'));
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('model_unavailable');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
});
it('a lost write ACK followed by an unavailable receipt only retries receipt lookup, never BPU or the write', async () => {
  const f = fixture();
  f.native.migrationWriteTarget.mockImplementationOnce(async () => {
    f.commit(); f.native.migrationTargetReceipt.mockRejectedValueOnce(new SearchNativeError('unavailable'));
    throw new SearchNativeError('unavailable');
  });
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('finished');
  expect(f.ai.encode).toHaveBeenCalledOnce(); expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
  expect(f.job.migration_progress).toMatchObject({ scanned: 1, encoded: 1 });
});
it.each(['migration_index_capacity', 'migration_report_capacity'])('Native %s remains an explicit capacity failure without declaring partial evidence ready', async reason => {
  const f = fixture(); f.native.migrationArtifacts.mockResolvedValueOnce({ state: 'unavailable', reason } as never);
  expect(await f.runner().runClaimed(f.job, f.worker)).toBe('failed'); expect(f.job.error_code).toBe('capacity_exceeded');
  expect(f.artifacts.prepare).not.toHaveBeenCalled(); expect(f.jobs.finishMigration).not.toHaveBeenCalled();
  expect(f.job.migration_progress).toMatchObject({ phase: 'building_index' });
});

it('a persistent prewrite hardware outage becomes a visible failure after its retry budget',async()=>{
  const f=fixture();let clock=Date.now();f.ai.encode.mockImplementation(async()=>{clock+=60;throw new SearchReencodeAiError('busy');});
  const runner=new SearchReencodeRunner({jobs:f.jobs as never,native:f.native as never,ai:f.ai as never,
    artifacts:f.artifacts as never,context:f.context,retryMs:10,maxRetryMs:100,now:()=>clock});
  expect(await runner.runClaimed(f.job,f.worker)).toBe('failed');expect(f.job.error_code).toBe('model_unavailable');
  expect(f.ai.encode).toHaveBeenCalledTimes(3);expect(f.native.migrationWriteTarget).not.toHaveBeenCalled();
});
it('a persistent metadata outage is bounded without advancing the durable sample cursor',async()=>{
  const f=fixture();let clock=Date.now();f.native.scanMigration.mockImplementation(async()=>{clock+=60;throw new SearchNativeError('busy');});
  const runner=new SearchReencodeRunner({jobs:f.jobs as never,native:f.native as never,ai:f.ai as never,
    artifacts:f.artifacts as never,context:f.context,retryMs:10,maxRetryMs:100,now:()=>clock});
  expect(await runner.runClaimed(f.job,f.worker)).toBe('failed');expect(f.job.error_code).toBe('history_unavailable');
  expect(f.jobs.checkpointMigration).not.toHaveBeenCalled();expect(f.ai.encode).not.toHaveBeenCalled();
});
it('the retry budget never discards an uncertain committed write while its exact receipt recovers',async()=>{
  const f=fixture();let clock=Date.now();
  f.native.migrationWriteTarget.mockImplementationOnce(async()=>{f.commit();
    for(let i=0;i<4;i++)f.native.migrationTargetReceipt.mockImplementationOnce(async()=>{clock+=100;throw new SearchNativeError('unavailable');});
    throw new SearchNativeError('unavailable');});
  const runner=new SearchReencodeRunner({jobs:f.jobs as never,native:f.native as never,ai:f.ai as never,
    artifacts:f.artifacts as never,context:f.context,retryMs:10,maxRetryMs:100,now:()=>clock});
  expect(await runner.runClaimed(f.job,f.worker)).toBe('finished');expect(f.jobs.failMigration).not.toHaveBeenCalled();
  expect(f.ai.encode).toHaveBeenCalledOnce();expect(f.native.migrationWriteTarget).toHaveBeenCalledOnce();
});
