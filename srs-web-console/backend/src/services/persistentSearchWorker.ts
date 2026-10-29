import { z } from 'zod';
import type { SearchSourceChannel } from './searchSourceCatalog.js';
import { sameSearchScope, searchPageSchema, searchQuerySchema, searchRangeSchema, searchResultSchema,
  type SearchCoverage, type SearchPage, type SearchQuery, type SearchResult, type SearchScope, type SearchWorker } from './searchContract.js';
import { SearchNativeError, type NativeCoverageRange, type NativeSearchSession, type SearchNativeClient } from './searchNativeClient.js';

type NativePort = Pick<SearchNativeClient, 'status' | 'match' | 'coverage' | 'image' | 'searchImage' | 'beginSearch' | 'publishSearch' | 'readSearch' | 'searchFeedback' | 'cancelSearch'>;
type Kind = 'object' | 'scene';
export interface PersistentSearchOptions {
  native: NativePort;
  /** Refuse excess interactive queries immediately; never queue in the BFF. */
  queryConcurrency?: number | (() => Promise<number>);
  sessionTtlSeconds?: number | (() => Promise<number>);
  /** Current server-side grants, refreshed on every read and mutation. */
  channels: (actor: string) => Promise<SearchSourceChannel[]>;
  /** Nonblocking wake only; PG/Mongo retain all durable task/result state. */
  verificationPublished?: () => void;
  verificationCancel?: (id: string, actor: string) => Promise<void>;
  verificationAvailability?: () => { available: boolean | null; reason: string | null };
  /** Optional proven policy for the entire requested historical interval.
   * Current channel capabilities cannot establish it. Null/empty means unknown,
   * never permission to mark that history fully sampled. */
  coverageKinds?: (channelId: string, actor: string, scope: SearchScope) => Promise<readonly Kind[] | null>;
  /** Must honor signal for remote I/O. One shared page budget prevents a slow
   * recorder from delaying the first search results. */
  recordingAvailability?: (input: { channelId: string; from: string; to: string; actor: string; signal: AbortSignal }) => Promise<'available' | 'missing' | 'pending'>;
}
export class PersistentSearchError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) { super(message); }
}
function translated(error: unknown): never {
  if (error instanceof PersistentSearchError || error instanceof z.ZodError) throw error;
  if (error instanceof SearchNativeError) {
    if (error.code === 'scope_denied') throw noAccess();
    if (error.code === 'query_too_long' || error.code === 'query_too_large')
      throw new PersistentSearchError(error.code, 400, '搜索描述过长，请保留关键特征后重试');
    if (error.code === 'query_invalid_utf8' || error.code === 'query_unrepresentable')
      throw new PersistentSearchError(error.code, 400, '当前模型无法编码这段描述，请使用普通文字改写后重试');
    if (error.code === 'busy') throw new PersistentSearchError('search_busy', 429, '搜索服务繁忙，请稍后重试');
    if (error.code === 'capacity') throw new PersistentSearchError('search_capacity', 429, '近期搜索数量已达上限，请稍后重试');
    if (error.code === 'cancelled') throw new PersistentSearchError('search_cancelled', 410, '搜索已取消，请重新搜索');
    if (error.code === 'conflict') throw new PersistentSearchError('search_conflict', 409, '这次搜索的条件已改变，请重新搜索');
    if (error.code === 'not_found') throw new PersistentSearchError('search_expired', 404, '搜索结果已过期，请重新搜索');
    if (error.code === 'model_pending') throw new PersistentSearchError('search_not_ready', 503, '搜索模型尚未就绪');
    if (error.code === 'storage_unavailable') throw new PersistentSearchError('search_storage_unavailable', 503, '搜索历史存储暂不可用');
  }
  throw new PersistentSearchError('search_unavailable', 503, '搜索服务暂不可用，请稍后重试');
}
const actorSchema = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const idSchema = z.string().uuid();
const noAccess = () => new PersistentSearchError('search_scope_denied', 403, '部分通道已不可用或无权访问，请重新选择');
const expired = () => new PersistentSearchError('search_expired', 404, '搜索结果已过期，请重新搜索');
function projection<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new Error('invalid_search_projection');
  return parsed.data;
}
function covers(from: number, to: number, ranges: NativeCoverageRange[]): boolean {
  if (ranges.some(r => r.state !== 'sampled' && r.from < to && r.to > from)) return false;
  let until = from;
  for (const range of ranges.filter(r => r.state === 'sampled').sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (range.from > until) return false;
    until = Math.max(until, range.to);
    if (until >= to) return true;
  }
  return false;
}
async function configuredNumber(read: number | (() => Promise<number>), schema: z.ZodNumber): Promise<number> {
  try {
    const parsed = schema.safeParse(typeof read === 'function' ? await read() : read);
    if (parsed.success) return parsed.data;
  } catch { /* Configuration failures are server failures, including Zod errors. */ }
  throw new PersistentSearchError('search_configuration_unavailable', 503, '搜索配置暂不可用，请稍后重试');
}
/** Mongo owns the bounded shortlist and feedback. This adapter projects that
 * snapshot for the console; it does not create an in-memory result authority,
 * independent job queue, or another model inference path. */
export class PersistentSearchWorker implements SearchWorker {
  private readonly queryConcurrency: () => Promise<number>;
  private readonly sessionTtlSeconds: () => Promise<number>;
  // A transient resource meter only. Mongo remains the result/session authority;
  // PG remains the background-task authority. No queued query or payload lives here.
  private readonly activeQueryActors = new Set<string>();
  // Bound the applied-configuration reads too. This is admission accounting,
  // not a wait queue: excess actors are refused before invoking their getter.
  private readonly checkingQueryActors = new Set<string>();
  constructor(private readonly options: PersistentSearchOptions) {
    const concurrency = options.queryConcurrency === undefined ? 2 : options.queryConcurrency;
    const ttl = options.sessionTtlSeconds === undefined ? 3600 : options.sessionTtlSeconds;
    const concurrencySchema = z.number().int().min(1).max(8), ttlSchema = z.number().int().min(60).max(86400);
    if (typeof concurrency !== 'function') concurrencySchema.parse(concurrency);
    if (typeof ttl !== 'function') ttlSchema.parse(ttl);
    this.queryConcurrency = () => configuredNumber(concurrency, concurrencySchema);
    this.sessionTtlSeconds = () => configuredNumber(ttl, ttlSchema);
  }
  status() { return this.options.native.status(); }
  private wakeVerification() { try { this.options.verificationPublished?.(); } catch { /* Optional background work never fails the shortlist. */ } }
  private async authorize(scope: SearchScope, actor: string) {
    actorSchema.parse(actor); searchRangeSchema.parse(scope);
    const visible = new Map((await this.options.channels(actor)).map(c => [c.id, c.name]));
    if (scope.channel_ids.some(id => !visible.has(id))) throw noAccess();
    return visible;
  }
  private async classify(scope: SearchScope, actor: string, ranges: NativeCoverageRange[]): Promise<SearchCoverage['state']> {
    if (!ranges.length) return 'unknown';
    const from = Date.parse(scope.from), to = Date.parse(scope.to);
    let unknownPolicy = false;
    for (const channel of scope.channel_ids) {
      // Conservative default includes the independent scene branch; a detector
      // alone cannot establish coverage of objects it never classified.
      const required = this.options.coverageKinds ? await this.options.coverageKinds(channel, actor, scope) : ['object', 'scene'] as const;
      if (required === null || !required.length) { unknownPolicy = true; continue; }
      if (required.length > 2 || new Set(required).size !== required.length || required.some(k => k !== 'object' && k !== 'scene'))
        throw new Error('invalid_sampling_policy');
      for (const kind of required) if (!covers(from, to, ranges.filter(r => r.channel === channel && r.scene === (kind === 'scene')))) return 'partial';
    }
    return unknownPolicy ? 'unknown' : 'sampled';
  }
  private async coverageRanges(scope: SearchScope, model: string): Promise<NativeCoverageRange[] | null> {
    try { return await this.options.native.coverage(scope, model); }
    catch (error) {
      // Degrade only the independent coverage read, never permission or query failures.
      if (error instanceof SearchNativeError && ['unavailable', 'storage_unavailable', 'busy', 'invalid_response'].includes(error.code)) return null;
      throw error;
    }
  }
  async coverage(scope: SearchScope, actor: string): Promise<SearchCoverage> {
    try {
      await this.authorize(scope, actor);
      const status = await this.status();
      if (!status.model_version) throw new SearchNativeError(status.reason === 'storage_unavailable' ? 'storage_unavailable' : 'model_pending');
      const ranges = await this.coverageRanges(scope, status.model_version);
      const state = ranges === null ? 'unknown' : await this.classify(scope, actor, ranges);
      await this.authorize(scope, actor);
      return { scope, state, ranges: (ranges ?? []).map(r => ({
        channel_id: r.channel, from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(),
        kind: r.scene ? 'scene' : 'object', state: r.state,
      })) };
    } catch (error) { return translated(error); }
  }
  async query(raw: SearchQuery, actor: string): Promise<SearchPage> {
    let checking = false, admitted = false;
    try {
      const input = searchQuerySchema.parse(raw); actorSchema.parse(actor);
      if (this.checkingQueryActors.has(actor) || this.activeQueryActors.has(actor) || this.checkingQueryActors.size >= 8)
        throw new PersistentSearchError('search_busy', 429, '搜索服务繁忙，请稍后重试');
      this.checkingQueryActors.add(actor); checking = true;
      const concurrency = await this.queryConcurrency();
      // Transfer the bounded configuration permit into a query permit. No
      // await between checking current capacity and adding the admitted actor.
      this.checkingQueryActors.delete(actor); checking = false;
      if (this.activeQueryActors.has(actor) || this.activeQueryActors.size >= concurrency)
        throw new PersistentSearchError('search_busy', 429, '搜索服务繁忙，请稍后重试');
      this.activeQueryActors.add(actor); admitted = true;
      await this.authorize(input.scope, actor);
      let snapshot = await this.options.native.readSearch(input.request_id, actor);
      if (snapshot && (snapshot.query !== input.query || snapshot.verify !== input.verify || !sameSearchScope(snapshot.scope, input.scope)))
        throw new PersistentSearchError('search_conflict', 409, '这次搜索的条件已改变，请重新搜索');
      if (snapshot?.published) { if (snapshot.verify) this.wakeVerification(); return await this.project(snapshot, actor); }
      const status = await this.status();
      if (!status.ready || !status.model_version) throw new SearchNativeError(status.reason === 'storage_unavailable' ? 'storage_unavailable' : status.reason === 'model_pending' ? 'model_pending' : 'unavailable');
      if (snapshot && snapshot.model_version !== status.model_version) throw new SearchNativeError('model_pending');
      const version = await this.options.native.beginSearch(input, actor, status.model_version, Date.now() + (await this.sessionTtlSeconds()) * 1000);
      // Another process may have completed the same request during admission.
      snapshot = await this.options.native.readSearch(input.request_id, actor);
      if (!snapshot || snapshot.version !== version) throw expired();
      if (!snapshot.published) {
        const hits = await this.options.native.match(input.query, input.scope, status.model_version);
        const ranges = await this.coverageRanges(input.scope, status.model_version);
        let coverage = ranges === null ? 'unknown' : await this.classify(input.scope, actor, ranges);
        if (hits.partial && coverage === 'sampled') coverage = 'partial';
        // Authorization can change while BPU work runs. No new snapshot is
        // published after loss of a channel grant.
        await this.authorize(input.scope, actor);
        await this.options.native.publishSearch(input.request_id, actor, version, coverage,
          hits.items.map(item => ({ sample_id: item.id, similarity: item.similarity, ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}), ...(item.evidence_refs ? { evidence_refs: item.evidence_refs } : {}) })));
      }
      const page = await this.options.native.readSearch(input.request_id, actor);
      if (!page) throw expired();
      if (!page.published || page.version !== version || !sameSearchScope(page.scope, input.scope)) throw new Error('invalid_search_publication');
      if (page.verify) this.wakeVerification();
      return await this.project(page, actor);
    } catch (error) { return translated(error); }
    finally {
      if (checking) this.checkingQueryActors.delete(actor);
      if (admitted) this.activeQueryActors.delete(actor);
    }
  }
  private async resultProjection(sample: NativeSearchSession['items'][number], snapshot: NativeSearchSession, actor: string,
    visible: Map<string, string>, signal: AbortSignal, ordinal = 0): Promise<SearchResult> {
    if (!snapshot.scope.channel_ids.includes(sample.channel_id) || !visible.has(sample.channel_id)) throw noAccess();
    const recording = sample.evidence.recording_channel_id;
    if (recording && !visible.has(recording)) throw noAccess();
    const at = new Date(sample.captured_ms).toISOString();
    let recordingState: SearchResult['recording']['state'] = recording ? 'pending' : 'missing';
    if (recording && this.options.recordingAvailability && !signal.aborted) {
      const provider = this.options.recordingAvailability;
      recordingState = await new Promise<SearchResult['recording']['state']>(resolve => {
        const finish = (value: SearchResult['recording']['state']) => { signal.removeEventListener('abort', aborted); resolve(value); };
        const aborted = () => finish('pending'); signal.addEventListener('abort', aborted, { once: true });
        // Promise.resolve also contains a synchronous adapter exception.
        void Promise.resolve().then(() => provider({ channelId: recording, from: sample.started_ms === undefined ? at : new Date(sample.started_ms).toISOString(),
            to: sample.ended_ms === undefined ? at : new Date(sample.ended_ms).toISOString(), actor, signal }))
          .then(value => finish(value), () => finish('pending'));
        if (signal.aborted) aborted();
      });
    }
    const availability = this.options.verificationAvailability?.();
    const unavailable = snapshot.verify && ordinal < 5 && availability?.available === false;
    return projection(searchResultSchema, {
      id: sample.id, channel_id: sample.channel_id, channel_name: visible.get(sample.channel_id),
      source_input_id: sample.evidence.source_input_id, processor_id: sample.processor_id || null,
      output_channel_id: sample.evidence.output_channel_id, kind: sample.kind,
      started_at: sample.started_ms === undefined ? at : new Date(sample.started_ms).toISOString(),
      ended_at: sample.ended_ms === undefined ? at : new Date(sample.ended_ms).toISOString(),
      frames: sample.frames?.map(frame => ({ id: frame.id, captured_at: new Date(frame.captured_ms).toISOString(), role: frame.role, ...(sample.kind === 'object' && frame.bbox ? { bbox: frame.bbox } : {}) }))
        ?? [{ id: sample.evidence.frame_id, captured_at: at, role: 'match' }],
      recording: { channel_id: recording, state: recordingState },
      // Only authoritative per-slot progress may claim queued/running/final.
      // Uncalibrated search decisions never reuse alarm-review thresholds.
      verification: snapshot.verify && sample.verification ? { state: sample.verification.state, validated: false,
        cached: sample.verification.cached, reason: sample.verification.reason } : unavailable
        ? { state: 'unavailable', validated: false, cached: false, reason: availability.reason ?? 'task_unavailable' } : { state: 'candidate' },
      feedback: sample.feedback === null ? null : sample.feedback ? 'relevant' : 'irrelevant',
    });
  }
  private async project(snapshot: NativeSearchSession, actor: string, offset = 0): Promise<SearchPage> {
    const visible = await this.authorize(snapshot.scope, actor);
    if (!snapshot.published) throw new PersistentSearchError('search_busy', 429, '这次搜索尚未完成，请稍后重试');
    // Keep recorder checks bounded as well; a large page must not fan out sixty
    // requests to another service concurrently.
    const items: SearchResult[] = [];
    const signal = AbortSignal.timeout(2000);
    for (const [index, sample] of snapshot.items.entries()) items.push(await this.resultProjection(sample, snapshot, actor, visible, signal, offset + index));
    const current = await this.authorize(snapshot.scope, actor);
    if (items.some(item => item.recording.channel_id && !current.has(item.recording.channel_id))) throw noAccess();
    return projection(searchPageSchema, { search_id: snapshot.search_id, scope: snapshot.scope, model_version: snapshot.model_version,
      coverage: snapshot.coverage, items, next_cursor: snapshot.next_offset === null ? null : `v1.${snapshot.next_offset}` });
  }
  async page(id: string, cursor: string | undefined, actor: string): Promise<SearchPage | null> {
    try {
      idSchema.parse(id); actorSchema.parse(actor);
      let offset = 0;
      if (cursor !== undefined) {
        const value = z.string().regex(/^v1\.(0|[1-5]?\d|60)$/).parse(cursor); offset = Number(value.slice(3));
      }
      const snapshot = await this.options.native.readSearch(id, actor, offset);
      return snapshot ? await this.project(snapshot, actor, offset) : null;
    } catch (error) { return translated(error); }
  }
  private async owned(id: string, resultId: string, actor: string) {
    idSchema.parse(id); idSchema.parse(resultId); actorSchema.parse(actor);
    // At most sixty immutable slots, with expired/deleted samples omitted by
    // the authoritative store. A result ID alone never grants image access.
    const snapshot = await this.options.native.readSearch(id, actor, 0, 60);
    if (!snapshot?.published) return null;
    const visible = await this.authorize(snapshot.scope, actor);
    const sample = snapshot.items.find(item => item.id === resultId);
    return sample ? { snapshot, sample, visible } : null;
  }
  async result(id: string, resultId: string, actor: string) {
    try {
      const row = await this.owned(id, resultId, actor);
      if (!row) return null;
      const item = await this.resultProjection(row.sample, row.snapshot, actor, row.visible, AbortSignal.timeout(2000), row.snapshot.items.findIndex(item => item.id === row.sample.id));
      const current = await this.authorize(row.snapshot.scope, actor);
      if (item.recording.channel_id && !current.has(item.recording.channel_id)) throw noAccess();
      return { search_id: id, scope: row.snapshot.scope, item };
    } catch (error) { return translated(error); }
  }
  async image(id: string, resultId: string, frameId: string, actor: string): Promise<Buffer | null> {
    try {
      idSchema.parse(frameId); const row = await this.owned(id, resultId, actor);
      if (!row || !(row.sample.frames ?? [{ id: row.sample.evidence.frame_id }]).some(frame => frame.id === frameId)) return null;
      if (row.sample.evidence.recording_channel_id && !row.visible.has(row.sample.evidence.recording_channel_id)) throw noAccess();
      // The native operation checks snapshot fingerprint and reads JPEG under
      // one storage lock. A second raw sample-ID lookup could race ID reuse.
      const bytes = await this.options.native.searchImage(id, actor, row.sample.id, frameId);
      const current = await this.authorize(row.snapshot.scope, actor);
      if (row.sample.evidence.recording_channel_id && !current.has(row.sample.evidence.recording_channel_id)) throw noAccess();
      return bytes;
    } catch (error) { return translated(error); }
  }
  async feedback(id: string, resultId: string, relevant: boolean, actor: string): Promise<void> {
    try {
      z.boolean().parse(relevant); const row = await this.owned(id, resultId, actor);
      if (!row) throw expired();
      if (row.sample.evidence.recording_channel_id && !row.visible.has(row.sample.evidence.recording_channel_id)) throw noAccess();
      await this.options.native.searchFeedback(id, actor, resultId, relevant);
    } catch (error) { return translated(error); }
  }
  async cancel(id: string, actor: string): Promise<void> {
    try {
      idSchema.parse(id); actorSchema.parse(actor);
      // Cancel the known active remote request promptly; native cancellation
      // retains durable submitted references for crash/restart compensation.
      try { await this.options.verificationCancel?.(id, actor); } catch { /* Native cancellation still must happen. */ }
      await this.options.native.cancelSearch(id, actor);
      this.wakeVerification();
    }
    catch (error) { return translated(error); }
  }
}
