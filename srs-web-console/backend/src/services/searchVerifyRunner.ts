import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { SearchJobs, SearchJob } from '../store/searchJobs.js';
import type { SearchNativeClient } from './searchNativeClient.js';
import type { SearchScope } from './searchContract.js';
import { searchVerificationProfileSchema, validateSearchVerificationProfile,
  type SearchVerificationBinding, type SearchVerificationCursor, type SearchVerificationInspection,
  type SearchVerificationProfile, type SearchVerificationTarget, type SearchVerificationAbortReason } from './searchVerificationContract.js';
import { SearchVerifyLlmError, type SearchVerifyLlmPort } from './searchVerifyLlm.js';

type NativePort = Pick<SearchNativeClient, 'scanVerification' | 'inspectVerification' | 'queueVerification' | 'beginVerification' |
  'finishVerification' | 'abortVerification' | 'searchImage'>;
const taskSchema = z.object({ schema_version: z.literal('1.0'), task: z.literal('search-verify-zh-v1'),
  search_id: z.string().uuid(), search_version: z.string().regex(/^[a-f0-9]{64}$/), sample_id: z.string().uuid(),
  frame_id: z.string().uuid(), sample_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  query_sha256: z.string().regex(/^[a-f0-9]{64}$/), profile: searchVerificationProfileSchema,
}).strict();
type Task = z.infer<typeof taskSchema>;
function requestKey(actor: string, task: Task) {
  const hex = createHash('sha256').update(JSON.stringify(['ainvr-search-verify-job-v1', [actor, task.search_id, task.search_version,
    task.sample_id, task.frame_id, task.sample_fingerprint, task.query_sha256, task.profile.profile_fp]])).digest('hex').slice(0, 32).split('');
  hex[12] = '8'; hex[16] = '89ab'[Number.parseInt(hex[16]!, 16) & 3]!;
  const value = hex.join(''); return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
interface Options {
  jobs: Pick<SearchJobs, 'enqueue' | 'claim' | 'get' | 'renew' | 'finish' | 'cancel' | 'retryUnsubmittedVerification'>;
  native: NativePort;
  llm: SearchVerifyLlmPort;
  /** Same current grants used by PersistentSearchWorker. No browser scope is trusted. */
  channels: (actor: string) => Promise<readonly { id: string }[]>;
  enabled?: () => Promise<boolean>;
  intervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}
type Active = { searchId: string; actor: string; requestId: string; controller: AbortController };
/** One serial PG lease consumer. Mongo remains the verification/result authority;
 * this object holds only the one active I/O cancellation handle, never a queue. */
export class SearchVerifyRunner {
  private readonly worker = randomUUID();
  private readonly intervalMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private cursor: SearchVerificationCursor | null = null;
  private profileFp: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private worked = false;
  private recentActors: string[] = [];
  private running: Promise<void> | null = null;
  private active: Active | null = null;
  private availability: { available: boolean | null; reason: string | null } = { available: null, reason: null };
  constructor(private readonly options: Options) {
    this.intervalMs = z.number().int().min(100).max(30000).parse(options.intervalMs ?? 2000);
    this.heartbeatMs = z.number().int().min(100).max(10000).parse(options.heartbeatMs ?? 2000);
    this.now = options.now ?? Date.now;
  }
  currentAvailability() { return { ...this.availability }; }
  start() {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule()); }, 0);
    this.timer.unref?.();
  }
  /** Wake a bounded scan after a published shortlist; no query waits for it. */
  wake() {
    this.cursor = null;
    if (this.stopped || this.running) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule()); }, 0);
    this.timer.unref?.();
  }
  private schedule() {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule()); }, this.worked ? 0 : this.intervalMs);
    this.timer.unref?.();
  }
  async stop() {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const active = this.active;
    active?.controller.abort();
    if (active) await this.cancelLlm(active.requestId);
    await this.running;
  }
  async cancel(searchId: string, actor: string) {
    const active = this.active;
    if (active?.searchId === searchId && active.actor === actor) {
      active.controller.abort(); await this.cancelLlm(active.requestId);
    }
    // Pending jobs need no remote inference cancellation. The authoritative
    // native cancelled-session scan recovers submitted IDs after a restart.
    this.wake();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.worked = false;
    const task = this.runTick().catch(() => undefined).finally(() => { if (this.running === task) this.running = null; });
    this.running = task; return task;
  }
  private async permitted(scope: SearchScope, actor: string) {
    const ids = new Set((await this.options.channels(actor)).map(channel => channel.id));
    return scope.channel_ids.every(id => ids.has(id));
  }
  private async cancelLlm(requestId: string) {
    try { await this.options.llm.cancel(requestId, AbortSignal.timeout(3000)); } catch { /* Preserve native submitted proof if cleanup cannot be acknowledged. */ }
  }
  private async cleanup(inspection: SearchVerificationInspection, reason: SearchVerificationAbortReason) {
    if (!inspection.binding || !inspection.submitted) return;
    const a = inspection.submitted;
    // Cancelling an unknown ID is idempotent. If the transport fails, retain the
    // durable submitted proof so a later bounded scan can try cancellation.
    try { await this.options.llm.cancel(a.request_id, AbortSignal.timeout(3000)); }
    catch { return; }
    await this.options.native.abortVerification(inspection.binding, a.job_id, a.generation, a.request_id, reason);
  }
  private async runTick() {
    if (this.options.enabled && !await this.options.enabled()) { this.availability = { available: false, reason: 'task_unavailable' }; return; }
    let profile: SearchVerificationProfile | null = null;
    try {
      profile = await this.options.llm.profile(AbortSignal.timeout(3000));
      this.availability = profile ? { available: true, reason: null } : { available: false, reason: 'model_unavailable' };
    } catch { this.availability = { available: false, reason: 'task_unavailable' }; /* Existing leases still need expiry/cancellation handling. */ }
    if (profile) {
      profile = validateSearchVerificationProfile(profile);
      if (this.profileFp !== profile.profile_fp) { this.profileFp = profile.profile_fp; this.cursor = null; }
      const page = await this.options.native.scanVerification(profile.profile_fp, this.cursor);
      this.cursor = page.next_cursor;
      for (const target of page.cleanup_refs) {
        if (this.stopped) return;
        const row = await this.options.native.inspectVerification(target, profile, 'visible');
        if (!row.binding || !row.submitted) continue;
        // Submitted metadata is not permission to steal another live PG lease.
        // A cancelled search is explicit intent to stop even a live request;
        // otherwise only a terminal/expired/missing job permits compensation.
        if (row.status !== 'cancelled') {
          let owner: SearchJob | null;
          try { owner = await this.options.jobs.get(row.submitted.job_id, row.binding.actor, true); }
          catch { continue; }
          if (owner?.state === 'running' && owner.lease_until && owner.expires_at.getTime() > this.now() && owner.lease_until.getTime() > this.now()) continue;
        }
        await this.cleanup(row, row.status === 'cancelled' ? 'cancelled' : row.status === 'profile_superseded' ? 'profile_changed' : 'already_submitted');
      }
      for (const target of page.refs) {
        if (this.stopped) return;
        try { await this.enqueue(target, profile); } catch { /* Queue capacity/config outages do not fail core search. Next scan retries. */ }
      }
    }
    // A missing profile is an availability observation, never a profile change.
    // Leave queued leases untouched; submitted recovery remains native-owned.
    if (this.stopped || !profile) return;
    const job = await this.options.jobs.claim(this.worker, 'verify', 30000, undefined, undefined, this.recentActors);
    if (job) {
      this.worked = true;
      this.recentActors = [job.actor, ...this.recentActors.filter(actor => actor !== job.actor)].slice(0, 1000);
      await this.process(job, profile);
    }
  }
  private async enqueue(target: SearchVerificationTarget, profile: SearchVerificationProfile) {
    const row = await this.options.native.inspectVerification(target, profile, 'visible');
    if (row.status === 'profile_superseded' || row.status === 'cancelled') {
      await this.cleanup(row, row.status === 'cancelled' ? 'cancelled' : 'profile_changed'); return;
    }
    if (!row.binding || !row.scope || !row.expires_ms || row.expires_ms <= this.now() || row.status === 'final' || row.status === 'unavailable' ||
      !await this.permitted(row.scope, target.actor)) return;
    const b = row.binding;
    if (b.question_scope !== 'visible' || b.profile_fp !== profile.profile_fp) return;
    const payload: Task = { schema_version: '1.0', task: 'search-verify-zh-v1', search_id: b.search_id, search_version: b.version,
      sample_id: b.sample_id, frame_id: b.frame_id, sample_fingerprint: b.fingerprint, query_sha256: b.query_sha256, profile };
    let job = await this.options.jobs.enqueue(target.actor, requestKey(target.actor, payload), 'verify', payload);
    if (job.state === 'failed' && job.error_code === 'profile_changed') {
      // Recover only legacy failures whose current durable native record proves
      // no submission. Never reopen final, cancelled or unknown LLM work.
      const fresh = await this.options.native.inspectVerification(target, profile, 'visible');
      if (fresh.status !== 'pending' || fresh.submitted || !fresh.binding ||
          !this.matches(fresh.binding, job, payload) ||
          (fresh.verification && (fresh.verification.state !== 'queued' || fresh.verification.request_id !== null))) return;
      const retried = await this.options.jobs.retryUnsubmittedVerification(job.id, job.actor, job.generation);
      if (!retried) return;
      job = retried;
    }
    if (job.state !== 'pending' && job.state !== 'running') return;
    await this.options.native.queueVerification(b, job.id, job.generation, profile);
  }
  private target(job: SearchJob, task: Task): SearchVerificationTarget {
    return { actor: job.actor, search_id: task.search_id, version: task.search_version, sample_id: task.sample_id };
  }
  private matches(binding: SearchVerificationBinding, job: SearchJob, task: Task) {
    return binding.actor === job.actor && binding.search_id === task.search_id && binding.version === task.search_version && binding.sample_id === task.sample_id &&
      binding.frame_id === task.frame_id && binding.fingerprint === task.sample_fingerprint && binding.query_sha256 === task.query_sha256 &&
      binding.profile_fp === task.profile.profile_fp && binding.question_scope === 'visible';
  }
  private async end(job: SearchJob, errorCode?: SearchVerificationAbortReason) {
    await this.options.jobs.finish(job.id, this.worker, job.generation,
      errorCode ? { errorCode } : { resultRef: `search-verify:${job.id}` });
  }
  private async process(job: SearchJob, currentProfile: SearchVerificationProfile | null) {
    let binding: SearchVerificationBinding | null = null, requestId: string | null = null;
    let heartbeat: ReturnType<typeof setTimeout> | undefined, heartbeatRunning: Promise<void> | null = null;
    let failure: SearchVerificationAbortReason | undefined;
    const controller = new AbortController();
    const parsed = taskSchema.safeParse(job.payload);
    if (!parsed.success) { await this.end(job, 'task_unavailable'); return; }
    const task = parsed.data;
    try {
      validateSearchVerificationProfile(task.profile);
      if (job.expires_at.getTime() <= this.now()) { await this.end(job, 'job_expired'); return; }
      let row = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
      if (row.status === 'profile_superseded' || row.status === 'cancelled') {
        await this.cleanup(row, row.status === 'cancelled' ? 'cancelled' : 'profile_changed');
        await this.end(job, row.status === 'cancelled' ? 'cancelled' : 'profile_changed'); return;
      }
      if (row.submitted) {
        // A previous generation may have reached the LLM. Recovery exposes
        // metadata only, even if the underlying evidence has since expired.
        await this.cleanup(row, 'already_submitted'); await this.end(job, 'already_submitted'); return;
      }
      binding = row.binding;
      if (!binding || !this.matches(binding, job, task) || !row.scope || !row.query || !row.kind || !row.expires_ms || row.expires_ms <= this.now()) {
        await this.end(job, 'evidence_unavailable'); return;
      }
      if (!await this.permitted(row.scope, job.actor)) { failure = 'scope_denied'; throw new Error('scope_denied'); }
      if (row.status === 'final') { await this.end(job); return; }
      if (!currentProfile || currentProfile.profile_fp !== task.profile.profile_fp) { failure = 'profile_changed'; throw new Error('profile_changed'); }
      const queued = await this.options.native.queueVerification(binding, job.id, job.generation, task.profile);
      if (queued.status === 'final') { await this.end(job); return; }
      if (queued.status === 'already_submitted') {
        row = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
        await this.cleanup(row, 'already_submitted'); await this.end(job, 'already_submitted'); return;
      }
      if (!queued.stored || queued.status !== 'queued') { await this.end(job, 'evidence_unavailable'); return; }
      const jpeg = await this.options.native.searchImage(binding.search_id, job.actor, binding.sample_id, binding.frame_id);
      if (!jpeg || createHash('sha256').update(jpeg).digest('hex') !== binding.jpeg_sha256) { failure = 'evidence_unavailable'; throw new Error('evidence_unavailable'); }
      row = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
      if (!row.binding || !this.matches(row.binding, job, task) || row.binding.jpeg_sha256 !== binding.jpeg_sha256 || row.submitted ||
        !row.scope || !row.query || !row.kind || !row.expires_ms || row.expires_ms <= this.now() || !await this.permitted(row.scope, job.actor)) {
        failure = row.status === 'cancelled' ? 'cancelled' : 'evidence_unavailable'; throw new Error(failure);
      }
      const inferenceScope = row.scope, evidenceExpires = row.expires_ms, inferenceQuery = row.query, inferenceKind = row.kind;
      requestId = `search-verify:${job.id}:${job.generation}`;
      if (!await this.options.jobs.renew(job.id, this.worker, job.generation, 30000)) { failure = 'job_expired'; throw new Error(failure); }
      const begun = await this.options.native.beginVerification(binding, job.id, job.generation, requestId);
      if (begun.status === 'final') { await this.end(job); return; }
      if (begun.status === 'already_submitted') {
        await this.cleanup(await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible'), 'already_submitted');
        await this.end(job, 'already_submitted'); return;
      }
      if (!begun.stored || begun.status !== 'submit' || begun.submitted?.request_id !== requestId) { requestId = null; await this.end(job, 'evidence_unavailable'); return; }
      this.active = { actor: job.actor, searchId: task.search_id, requestId, controller };
      const watch = () => {
        heartbeat = setTimeout(() => {
          heartbeatRunning = (async () => {
            if (this.stopped || (this.options.enabled && !await this.options.enabled()) ||
              !await this.options.jobs.renew(job.id, this.worker, job.generation, 30000)) { failure = 'job_expired'; controller.abort(); return; }
            const fresh = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
            if (fresh.status !== 'submitted' || !fresh.binding || !this.matches(fresh.binding, job, task) ||
              fresh.submitted?.job_id !== job.id || fresh.submitted.generation !== job.generation || fresh.submitted.request_id !== requestId ||
              evidenceExpires <= this.now() || !await this.permitted(inferenceScope, job.actor)) {
              failure = fresh.status === 'cancelled' ? 'cancelled' : 'scope_denied'; controller.abort(); return;
            }
            watch();
          })().catch(() => { failure = 'task_unavailable'; controller.abort(); });
        }, this.heartbeatMs); heartbeat.unref?.();
      };
      watch();
      const result = await this.options.llm.verify({ requestId, query: inferenceQuery, kind: inferenceKind, binding, profile: task.profile, jpeg, signal: controller.signal });
      await heartbeatRunning;
      if (controller.signal.aborted || this.stopped) { failure ??= 'cancelled'; throw new Error(failure); }
      // Retain the one completed result while readiness is unknown. A transient
      // profile outage is neither a changed model nor permission to infer again.
      // The existing heartbeat continues checking the lease, evidence and scope.
      let freshProfile: SearchVerificationProfile | null = null;
      while (!freshProfile) {
        try {
          freshProfile = await this.options.llm.profile(AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
          this.availability = freshProfile ? { available: true, reason: null } : { available: false, reason: 'model_unavailable' };
        } catch { this.availability = { available: false, reason: 'task_unavailable' }; }
        if (controller.signal.aborted || this.stopped) { failure ??= 'cancelled'; throw new Error(failure); }
        if (!freshProfile) await delay(this.intervalMs, undefined, { signal: controller.signal });
      }
      if (heartbeat !== undefined) clearTimeout(heartbeat);
      await heartbeatRunning;
      if (controller.signal.aborted || this.stopped) { failure ??= 'cancelled'; throw new Error(failure); }
      row = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
      if (freshProfile.profile_fp !== task.profile.profile_fp) { failure = 'profile_changed'; throw new Error(failure); }
      if (row.status !== 'submitted' || !row.binding || !this.matches(row.binding, job, task) || row.binding.jpeg_sha256 !== binding.jpeg_sha256 ||
        row.submitted?.job_id !== job.id || row.submitted.generation !== job.generation || row.submitted.request_id !== requestId ||
        evidenceExpires <= this.now() || !await this.permitted(inferenceScope, job.actor)) { failure = 'scope_denied'; throw new Error(failure); }
      const saved = await this.options.native.finishVerification(binding, job.id, job.generation, requestId, result);
      if (!saved.stored && saved.status !== 'final') { failure = 'evidence_unavailable'; throw new Error(failure); }
      await this.end(job);
    } catch (error) {
      failure ??= controller.signal.aborted || this.stopped ? 'cancelled' : error instanceof SearchVerifyLlmError ? error.code : 'inference_failed';
      if (binding) {
        if (requestId) {
          try {
            await this.options.llm.cancel(requestId, AbortSignal.timeout(3000));
            const current = await this.options.native.inspectVerification(this.target(job, task), task.profile, 'visible');
            if (current.submitted) await this.cleanup(current, failure);
            else if (current.binding && this.matches(current.binding, job, task) && current.verification?.state === 'queued')
              await this.options.native.abortVerification(current.binding, job.id, job.generation, null, failure);
          } catch { /* Keep durable submitted proof for restart cleanup. */ }
        } else {
          try { await this.options.native.abortVerification(binding, job.id, job.generation, null, failure); } catch { /* Bounded scan retries. */ }
        }
      }
      await this.end(job, failure);
    } finally {
      if (heartbeat !== undefined) clearTimeout(heartbeat);
      controller.abort(); await heartbeatRunning;
      if (this.active?.requestId === requestId) this.active = null;
    }
  }
}
