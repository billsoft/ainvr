import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SearchJob, SearchJobs } from '../store/searchJobs.js';
import type { SearchModelMigrationContext } from './searchModelMigrationActivation.js';
import { SearchMigrationArtifactError, type SearchModelMigrationArtifacts } from './searchModelMigrationArtifacts.js';
import { searchMigrationModelProfileSchema, searchModelMigrationFingerprint, searchModelMigrationPayloadSchema,
  searchModelMigrationProgressSchema, type SearchMigrationModel, type SearchMigrationModelProfile, type SearchModelMigrationPayload,
  type SearchModelMigrationProgress } from './searchModelMigrationContract.js';
import { SearchNativeError, type SearchNativeClient, type NativeMigrationSample,
  type NativeMigrationWriteProof, type NativeMigrationTargetStored } from './searchNativeClient.js';
import { SearchReencodeAiError, type SearchReencodeAiClient } from './searchReencodeAi.js';

type Jobs = Pick<SearchJobs, 'get' | 'renewMigration' | 'checkpointMigration' | 'finishMigration' |
  'failMigration' | 'authorizeMigrationWrite' | 'authorizeMigrationArtifacts'>;
type Native = Pick<SearchNativeClient, 'verifyMigrationModel' | 'scanMigration' | 'migrationImage' |
  'migrationWriteTarget' | 'migrationTargetReceipt' | 'migrationArtifacts'>;
type Context = Omit<SearchModelMigrationContext, 'extent'>;
interface Options {
  jobs: Jobs;
  native: Native;
  ai: Pick<SearchReencodeAiClient, 'encode' | 'capabilities'>;
  artifacts: Pick<SearchModelMigrationArtifacts, 'prepare'>;
  context: () => Promise<Context | null>;
  heartbeatMs?: number;
  retryMs?: number;
  /** Bound definite prewrite/read outages; uncertain writes/checkpoints retain exact retry semantics. */
  maxRetryMs?: number;
  now?: () => number;
}
type FailureCode = 'model_unavailable' | 'history_unavailable' | 'storage_unavailable' |
  'capacity_exceeded' | 'source_changed' | 'encoding_failed' | 'artifact_invalid';
class Failure extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
class Stale extends Error {}
export type SearchReencodeOutcome = 'finished' | 'stale' | 'failed' | 'busy';
const same = isDeepStrictEqual;
const pin = (profile: SearchMigrationModel) => ({ package_id: profile.package_id,
  package_sha256: profile.package_sha256, model_version: profile.model_version });

/** Executes one already claimed PG job, using its parent's worker identity.
 * SearchJobs alone owns ordering, leases and checkpoints. Only one original
 * JPEG and one frozen write body are resident; no alternate queue or PG vector
 * store is introduced. The caller owns parent renewal and shutdown signalling. */
export class SearchReencodeRunner {
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private running = false;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = z.number().int().min(100).max(10000).parse(options.heartbeatMs ?? 2000);
    this.retryMs = z.number().int().min(10).max(10000).parse(options.retryMs ?? 1000);
    this.maxRetryMs = z.number().int().min(100).max(3600000).parse(options.maxRetryMs ?? 300000);
  }
  async runClaimed(input: SearchJob, worker: string, signal?: AbortSignal): Promise<SearchReencodeOutcome> {
    z.string().uuid().parse(worker);
    if (this.running) return 'busy';
    this.running = true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> | null = null;
    let job = input;
    const active = () => {
      if (abort.signal.aborted || this.now() >= job.expires_at.getTime()) throw new Stale();
    };
    const renew = async () => {
      active();
      if (!await this.options.jobs.renewMigration(job.id, worker, job.generation, 30000)) throw new Stale();
    };
    const watch = () => {
      timer = setTimeout(() => {
        renewing = renew().catch(cancel).finally(() => {
          renewing = null;
          if (!abort.signal.aborted) watch();
        });
      }, this.heartbeatMs);
      timer.unref?.();
    };
    const pause = async () => {
      active();
      try { await delay(this.retryMs, undefined, { signal: abort.signal }); } catch { throw new Stale(); }
      active();
    };
    try {
      // The actual row prevents a stale caller from replaying a prior cursor or
      // a checkpoint whose successful reply was lost on the previous process.
      const actual = await this.options.jobs.get(input.id, input.actor, true);
      if (!actual || actual.actor !== input.actor || actual.state !== 'running' || actual.kind !== 'rebuild' ||
          actual.lease_owner !== worker || actual.generation !== input.generation ||
          !actual.lease_until || actual.lease_until.getTime() <= this.now()) throw new Stale();
      job = actual;
      const payload = searchModelMigrationPayloadSchema.parse(job.payload);
      let progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
      const fingerprint = searchModelMigrationFingerprint(payload);
      if (progress.payload_fingerprint !== fingerprint) throw new Failure('artifact_invalid');
      const proof: NativeMigrationWriteProof = { job_id: job.id, worker, generation: job.generation,
        actor: job.actor, payload_fingerprint: fingerprint };
      await renew(); watch();
      const authorized = async (sample?: NativeMigrationSample) => {
        active();
        const context = await this.options.context();
        if (!context || context.revision !== payload.config_revision || context.storage_generation !== payload.storage_generation ||
            !same(pin(context.source), payload.source) || payload.scope.channel_ids.some(id => !context.channels.includes(id)))
          throw new Failure('source_changed');
        const grant = progress.phase === 'encoding' ?
          await this.options.jobs.authorizeMigrationWrite(job.id, worker, job.generation, job.actor, fingerprint, context,
            sample ? { sample_id: sample.id, fingerprint: sample.fingerprint, channel_id: sample.channel_id,
              captured_ms: sample.captured_ms, ordinal: sample.ordinal, jpeg_sha256: sample.jpeg_sha256 } : undefined) :
          await this.options.jobs.authorizeMigrationArtifacts(job.id, worker, job.generation, job.actor, fingerprint, context);
        active();
        if (!grant || !same(grant.target, payload.target) || !same(grant.source, payload.source) ||
            grant.payload_fingerprint !== fingerprint || grant.generation !== job.generation || grant.worker !== worker ||
            grant.lease_until_ms <= this.now() + 1000) throw new Stale();
        return grant;
      };
      const checkpoint = async (next: SearchModelMigrationProgress) => {
        active();
        // Retry only the exact frozen PG CAS; never redo image/BPU/write work
        // after a checkpoint response is lost. The store recognizes same-after.
        for (;;) {
          try {
            if (!await this.options.jobs.checkpointMigration(job.id, worker, job.generation, progress, next)) throw new Stale();
            break;
          } catch (error) { if (error instanceof Stale) throw error; await pause(); }
        }
        progress = next; job = { ...job, migration_progress: next };
      };
      if (progress.phase === 'encoding') {
        const capabilities = await this.options.ai.capabilities(abort.signal);
        if (!capabilities.implemented || !capabilities.target_package_ids.includes(payload.target.package_id))
          throw new Failure('model_unavailable');
        const target = searchMigrationModelProfileSchema.parse(await this.readNative(async () => {
          await authorized(); return this.options.native.verifyMigrationModel(payload.target.package_id);
        }, pause));
        if (!target.files_verified || !target.production_approval_declared || target.pruned || !same(pin(target), payload.target))
          throw new Failure('model_unavailable');
        await authorized();
        let after = progress.cursor?.ordinal ?? payload.source_after_watermark ?? null;
        for (;;) {
          active();
          const scan = await this.readNative(async () => {
            await authorized(); return this.options.native.scanMigration(payload.source.model_version, payload.scope,
              after, payload.source_high_watermark, payload.batch_size);
          }, pause);
          for (const source of scan.items) {
            const stored = await this.encodeSample(payload, source, target, proof, authorized, pause, active, abort.signal);
            const targetCheckpoint = stored && BigInt(stored.ordinal) > BigInt(progress.target_checkpoint ?? '0') ?
              stored.ordinal : progress.target_checkpoint;
            await checkpoint({ ...progress, cursor: { ordinal: source.ordinal, sample_id: source.id }, scanned: progress.scanned + 1,
              encoded: progress.encoded + (stored ? 1 : 0), unavailable: progress.unavailable + (stored ? 0 : 1),
              target_checkpoint: targetCheckpoint });
          }
          if (scan.exhausted) {
            await authorized();
            await checkpoint({ ...progress, phase: 'building_index', source_completed_through: payload.source_high_watermark,
              target_checkpoint: progress.target_checkpoint ?? '0' });
            break;
          }
          // A scanned page can contain only expired/deleted metadata. Native's
          // checked cursor may advance beyond its last visible item. Keep that
          // scan cursor transient; PG counts/cursor advance only for actual
          // processed samples. A crash merely rescans hidden metadata.
          if (scan.next_cursor === null || BigInt(scan.next_cursor) <= BigInt(after ?? '0'))
            throw new Failure('artifact_invalid');
          after = scan.next_cursor;
          await authorized();
        }
      }
      let artifactsStarted = false;
      while (progress.phase === 'building_index') {
        await authorized();
        try {
          const state = await this.readNative(async () => {
            await authorized(); return this.options.native.migrationArtifacts(proof, artifactsStarted ? 'status' : 'start');
          }, pause);
          artifactsStarted = true;
          if (state.state === 'unavailable') throw new Failure(state.reason === 'storage_unavailable' ?
            'storage_unavailable' : ['capacity_exceeded', 'migration_index_capacity', 'migration_report_capacity'].includes(state.reason ?? '') ?
              'capacity_exceeded' : 'artifact_invalid');
          if (state.state !== 'ready') { await pause(); continue; }
          const artifacts = await this.options.artifacts.prepare(job), report = artifacts.report;
          await authorized();
          await checkpoint({ ...progress, phase: 'awaiting_acceptance', coverage_sha256: report.coverage_sha256,
            index_manifest_sha256: artifacts.index_manifest_sha256, target_checkpoint: report.target_checkpoint,
            coverage_snapshot: { required: report.scanned, matched: report.encoded, unavailable: report.unavailable } });
        } catch (error) {
          if (error instanceof SearchMigrationArtifactError && error.code === 'migration_artifacts_pending') { await pause(); continue; }
          throw error;
        }
      }
      if (progress.phase !== 'awaiting_acceptance') throw new Failure('artifact_invalid');
      await authorized();
      for (;;) {
        try {
          if (!await this.options.jobs.finishMigration(job.id, worker, job.generation, progress)) {
            const saved = await this.options.jobs.get(job.id, job.actor, true);
            if (!saved || saved.generation !== job.generation || saved.state !== 'succeeded' ||
                !same(searchModelMigrationProgressSchema.parse(saved.migration_progress),
                  searchModelMigrationProgressSchema.parse(progress))) throw new Stale();
          }
          return 'finished';
        } catch (error) {
          if (error instanceof Stale) throw error;
          // Finish may have committed before its reply was lost. Renewal then
          // correctly fails for a succeeded row; reconcile that durable outcome
          // before treating the aborted running lease as stale.
          try {
            const saved = await this.options.jobs.get(job.id, job.actor, true);
            if (saved?.generation === job.generation && saved.state === 'succeeded' &&
                same(searchModelMigrationProgressSchema.parse(saved.migration_progress),
                  searchModelMigrationProgressSchema.parse(progress))) return 'finished';
          } catch { /* Only an exact durable terminal row is authoritative. */ }
          await pause();
        }
      }
    } catch (error) {
      if (error instanceof Stale || abort.signal.aborted || signal?.aborted) return 'stale';
      const code: FailureCode = error instanceof Failure ? error.code : error instanceof SearchReencodeAiError ?
        (error.code === 'target_changed' ? 'source_changed' :
          ['model_unavailable', 'not_authorized'].includes(error.code) ? 'model_unavailable' : 'encoding_failed') :
        error instanceof SearchNativeError && error.code === 'capacity' ? 'capacity_exceeded' :
        error instanceof SearchMigrationArtifactError || error instanceof z.ZodError ? 'artifact_invalid' : 'history_unavailable';
      try { return await this.options.jobs.failMigration(job.id, worker, job.generation, code) ? 'failed' : 'stale'; }
      catch { return 'stale'; } // An unknown PG outcome is not a terminal ACK.
    } finally {
      abort.abort();
      if (timer !== undefined) clearTimeout(timer);
      await renewing;
      signal?.removeEventListener('abort', cancel);
      this.running = false;
    }
  }
  /** Only idempotent reads and explicit artifact start/status can retry here.
   * Every attempt rechecks authority through its supplied read closure. Bad
   * contracts, capacity and source changes remain explicit failures. */
  private async readNative<T>(read: () => Promise<T>, pause: () => Promise<void>, bounded = true): Promise<T> {
    let retryStarted: number | null = null;
    for (;;) {
      try { return await read(); }
      catch (error) {
        if (!(error instanceof SearchNativeError) || !['busy', 'unavailable'].includes(error.code)) throw error;
        retryStarted ??= this.now();
        if (bounded && this.now() - retryStarted >= this.maxRetryMs) throw new Failure('history_unavailable');
        await pause();
      }
    }
  }
  private async encodeSample(payload: SearchModelMigrationPayload, source: NativeMigrationSample,
    target: SearchMigrationModelProfile, proof: NativeMigrationWriteProof,
    authorized: (source?: NativeMigrationSample) => Promise<{ lease_until_ms: number; job_expires_ms: number }>,
    pause: () => Promise<void>, active: () => void, signal: AbortSignal): Promise<NativeMigrationTargetStored | null> {
    await authorized(source);
    const receipt = (uncertainWrite = false) => this.readNative(async () => {
      await authorized(source); return this.options.native.migrationTargetReceipt(proof, source, payload.target);
    }, pause, !uncertainWrite);
    const old = await receipt();
    if (old.stored) { await authorized(source); return old; }
    if (old.status === 'source_changed') return null;
    // A slot can legitimately advance during the base migration. A replaced
    // target is not permission to overwrite it: encode the actual new source,
    // then let Native's existing source-currentness/frame-order/slot CAS decide.
    // This is required for the final catch-up wave; old or unrelated evidence
    // remains protected by that authoritative conditional write.
    // An absent receipt is not evidence that an earlier write was rejected.
    // Re-read the exact original and encode it again only because Native's
    // migration-only same-lineage first-write-wins CAS cannot replace a prior
    // vector. Any returned ACK names the actual retained target fingerprint.
    const jpeg = await this.readNative(async () => {
      await authorized(source); return this.options.native.migrationImage(source, payload.scope);
    }, pause);
    if (!jpeg) return null;
    let vector: number[];
    let retryStarted: number | null = null;
    for (;;) {
      const grant = await authorized(source);
      const expires = Math.min(this.now() + 29000, grant.lease_until_ms, grant.job_expires_ms, source.expires_ms);
      if (expires <= this.now() + 1000) return null;
      try {
        const result = await this.options.ai.encode({ jpeg, dimensions: target.dimensions, signal, request: {
          schema_version: 'search-reencode-image-v1', request_id: randomUUID(), job_id: proof.job_id,
          generation: proof.generation, payload_fingerprint: proof.payload_fingerprint, target: payload.target,
          sample_id: source.id, source_fingerprint: source.fingerprint, jpeg_sha256: source.jpeg_sha256, expires_ms: expires,
        } });
        vector = result.vector; break;
      } catch (error) {
        if (error instanceof SearchReencodeAiError && ['busy', 'timeout', 'unavailable', 'expired'].includes(error.code)) {
          retryStarted ??= this.now();
          if (this.now() - retryStarted >= this.maxRetryMs) throw new Failure('model_unavailable');
          await pause(); continue;
        }
        if (error instanceof SearchReencodeAiError && error.code === 'unsupported_image') return null;
        throw error;
      }
    }
    await authorized(source);
    // One bounded frozen vector is retained until an exact receipt is known.
    // Transport loss never increments the cursor, and does not invoke BPU again.
    for (;;) {
      active();
      try {
        const stored = await this.options.native.migrationWriteTarget(proof, source, target, vector);
        await authorized(source); return stored;
      } catch (error) {
        if (error instanceof SearchNativeError && error.code === 'capacity') throw error;
        await authorized(source);
        const saved = await receipt(true);
        if (saved.stored) { await authorized(source); return saved; }
        if (saved.status !== 'not_found') return null;
        await pause(); // same frozen body only; Native rechecks source and PG.
      }
    }
  }
}
