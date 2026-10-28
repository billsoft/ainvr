import { z } from 'zod';
import { endpoint, limitedBytes, limitedJson, type InternalServiceConnection } from './internalServiceHttp.js';
import { searchQuerySchema, searchRangeSchema, type SearchQuery, type SearchScope, type SearchStatus } from './searchContract.js';

const identity = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.string().min(1).max(128);
const decimal = z.string().regex(/^\d{1,19}$/);
export const nativeSampleSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  id: identity, channel_id: identity, processor_id: z.string().max(256),
  stream_session_id: z.string().min(1).max(256), track_id: z.string().max(256),
  model_version: model, captured_ms: integer, kind: z.enum(['object', 'scene']), expires_ms: integer,
  evidence: z.object({
    schema_version: z.literal('1.0'), source_input_id: identity,
    output_channel_id: identity.nullable(), recording_channel_id: identity.nullable(),
    stream_session_id: z.string().min(1).max(256), source_pts_ns: decimal, source_frame_index: decimal,
    frame_id: identity, frame_width: z.number().int().min(1).max(16384), frame_height: z.number().int().min(1).max(16384),
    role: z.enum(['match', 'before', 'after', 'context']),
  }).passthrough(),
}).strict().superRefine((sample, ctx) => {
  if (sample.evidence.stream_session_id !== sample.stream_session_id || sample.expires_ms <= sample.captured_ms ||
    (sample.kind === 'object' && (!sample.processor_id || !sample.track_id)))
    ctx.addIssue({ code: 'custom', message: 'Invalid native evidence identity' });
});
export type NativeSample = z.infer<typeof nativeSampleSchema>;
const nativeMatchSchema = z.object({
  model_version: model, partial: z.boolean(),
  items: z.array(z.object({
    // Parse the complete sample separately, since refinement schemas cannot be extended.
    similarity: z.number().finite().min(-1.00001).max(1.00001),
  }).passthrough()).max(60),
}).strict();
export interface NativeMatch {
  model_version: string; partial: boolean;
  items: (NativeSample & { similarity: number })[];
}
const rangeSchema = z.object({
  channel: identity, from: integer, to: integer, scene: z.boolean(), state: z.enum(['sampled', 'pending', 'gap']),
}).strict();
export type NativeCoverageRange = z.infer<typeof rangeSchema>;
export interface NativeSearchSession {
  search_id: string; version: string; query: string; model_version: string;
  verify: boolean; expires_ms: number; published: boolean;
  coverage: 'unknown' | 'partial' | 'sampled'; scope: SearchScope;
  items: (NativeSample & { similarity: number; feedback: boolean | null })[];
  next_offset: number | null;
}
const actorSchema = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativeSessionSchema = z.object({
  search_id: identity, version: versionSchema, query: z.string().min(1).max(1024), model_version: model,
  verify: z.boolean(), expires_ms: integer, published: z.boolean(), coverage: z.enum(['unknown', 'partial', 'sampled']),
  scope: z.object({ channel_ids: z.array(identity).min(1).max(100), from_ms: integer, to_ms: integer, limit: z.literal(60) }).strict(),
  items: z.array(z.object({ similarity: z.number().finite().min(-1.00001).max(1.00001), feedback: z.boolean().nullable() }).passthrough()).max(60),
  next_offset: z.number().int().min(1).max(60).nullable(),
}).strict();
export class SearchNativeError extends Error {
  constructor(readonly code: 'unavailable' | 'model_pending' | 'storage_unavailable' | 'busy' | 'not_found' | 'invalid_response' | 'cancelled' | 'conflict' | 'capacity' | 'query_invalid_utf8' | 'query_too_large' | 'query_too_long' | 'query_unrepresentable') { super(code); }
}
const statusSchema = z.object({
  ready: z.boolean(), reason: z.enum(['disabled', 'config_pending', 'model_pending', 'service_unavailable', 'storage_unavailable']).nullable(),
  model_version: model.nullable(),
}).strict().superRefine((status, ctx) => {
  if (status.ready ? status.reason !== null || !status.model_version : status.reason === null)
    ctx.addIssue({ code: 'custom', message: 'Invalid readiness' });
});
function nativeScope(scope: SearchScope) {
  searchRangeSchema.parse(scope);
  return { channel_ids: scope.channel_ids, from_ms: Date.parse(scope.from), to_ms: Date.parse(scope.to), limit: 60 };
}
/** Compute/storage port for the leased worker. SearchJobs remains the task
 * authority; this client never creates an alternate queue or retries writes. */
export class SearchNativeClient {
  constructor(
    private readonly connection: () => Promise<InternalServiceConnection | null>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async request(path: string, body?: unknown): Promise<Response> {
    try {
      const config = await this.connection(); if (!config) throw new SearchNativeError('unavailable');
      const target = endpoint(config, path);
      if (config.apiToken.length > 512 || /[\r\n]/.test(config.apiToken)) throw new SearchNativeError('unavailable');
      const response = await this.fetchImpl(target, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'x-service-token': config.apiToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response;
      if (response.status === 404) { await response.body?.cancel(); throw new SearchNativeError('not_found'); }
      if (response.status === 429) {
        const reason = z.object({ error: z.string() }).safeParse(await limitedJson(response));
        throw new SearchNativeError(reason.success && reason.data.error === 'search_capacity' ? 'capacity' : 'busy');
      }
      if (response.status === 409) { await response.body?.cancel(); throw new SearchNativeError('conflict'); }
      if (response.status === 410) { await response.body?.cancel(); throw new SearchNativeError('cancelled'); }
      const error = z.object({ error: z.string() }).safeParse(await limitedJson(response));
      if (error.success && response.status === 400) {
        const code = z.enum(['query_invalid_utf8', 'query_too_large', 'query_too_long', 'query_unrepresentable']).safeParse(error.data.error);
        if (code.success) throw new SearchNativeError(code.data);
      }
      if (error.success && response.status === 503 && ['model_pending', 'storage_unavailable'].includes(error.data.error))
        throw new SearchNativeError(error.data.error as 'model_pending' | 'storage_unavailable');
      throw new SearchNativeError('unavailable');
    } catch (error) {
      if (error instanceof SearchNativeError) throw error;
      throw new SearchNativeError('unavailable'); // Never echo URLs, credentials or remote text.
    }
  }
  private async json(path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(path, body);
    try {
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
      return await limitedJson(response);
    } catch { await response.body?.cancel().catch(() => undefined); throw new SearchNativeError('invalid_response'); }
  }
  async status(): Promise<SearchStatus> {
    try { return statusSchema.parse(await this.json('/v1/status')); }
    catch (error) {
      return { ready: false, model_version: null, reason: error instanceof SearchNativeError && error.code === 'storage_unavailable' ? 'storage_unavailable' : 'service_unavailable' };
    }
  }
  async match(query: string, scope: SearchScope, expectedModel: string): Promise<NativeMatch> {
    model.parse(expectedModel); z.string().trim().min(1).max(256).parse(query);
    const input = nativeScope(scope);
    try {
      const raw = nativeMatchSchema.parse(await this.json('/v1/match', { query, scope: input }));
      if (raw.model_version !== expectedModel) throw new Error();
      const ids = new Set<string>();
      const items = raw.items.map(row => {
        const { similarity, ...value } = row; const sample = nativeSampleSchema.parse(value);
        if (ids.has(sample.id) || !scope.channel_ids.includes(sample.channel_id) || sample.captured_ms < input.from_ms ||
          sample.captured_ms >= input.to_ms || sample.model_version !== expectedModel || sample.expires_ms <= Date.now()) throw new Error();
        ids.add(sample.id); return { ...sample, similarity };
      });
      return { ...raw, items };
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async coverage(scope: SearchScope, modelVersion: string) {
    model.parse(modelVersion); const input = nativeScope(scope);
    try {
      const raw = z.object({ model_version: model, ranges: z.array(rangeSchema).max(10000) }).strict()
        .parse(await this.json('/v1/coverage', { model_version: modelVersion, scope: input }));
      if (raw.model_version !== modelVersion || raw.ranges.some(r => !scope.channel_ids.includes(r.channel) ||
        r.from < input.from_ms || r.to > input.to_ms || r.to <= r.from)) throw new Error();
      // This reports recorded intervals only. Coverage classification belongs to
      // the configured sampling policy, never to transport success or row count.
      return raw.ranges;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async image(id: string, channel: string, modelVersion: string): Promise<Buffer | null> {
    identity.parse(id); identity.parse(channel); model.parse(modelVersion);
    const query = new URLSearchParams({ channel_id: channel, model_version: modelVersion });
    return this.jpeg(`/v1/samples/${id}/image?${query}`);
  }
  private async jpeg(path: string, body?: unknown): Promise<Buffer | null> {
    let response: Response;
    try { response = await this.request(path, body); }
    catch (error) { if (error instanceof SearchNativeError && error.code === 'not_found') return null; throw error; }
    try {
      if (response.headers.get('content-type') !== 'image/jpeg') throw new Error();
      const bytes = await limitedBytes(response, 8 * 1024 * 1024);
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes.at(-1) !== 217) throw new Error();
      return bytes;
    } catch { await response.body?.cancel().catch(() => undefined); throw new SearchNativeError('invalid_response'); }
  }
  async searchImage(id: string, actor: string, sampleId: string, frameId: string): Promise<Buffer | null> {
    identity.parse(id); actorSchema.parse(actor); identity.parse(sampleId); identity.parse(frameId);
    return this.jpeg('/v1/searches/image', { id, actor, sample_id: sampleId, frame_id: frameId });
  }
  async beginSearch(input: SearchQuery, actor: string, modelVersion: string, expiresMs: number): Promise<string> {
    const query = searchQuerySchema.parse(input); actorSchema.parse(actor); model.parse(modelVersion);
    integer.refine(value => value > Date.now() && value <= Date.now() + 86400000).parse(expiresMs);
    try {
      return z.object({ version: versionSchema }).strict().parse(await this.json('/v1/searches/begin', {
        id: query.request_id, actor, query: query.query, scope: nativeScope(query.scope), model_version: modelVersion,
        verify: query.verify, expires_ms: expiresMs,
      })).version;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async publishSearch(id: string, actor: string, version: string, coverage: NativeSearchSession['coverage'],
    items: { sample_id: string; similarity: number; fingerprint?: string }[]): Promise<boolean> {
    identity.parse(id); actorSchema.parse(actor); versionSchema.parse(version);
    z.enum(['unknown', 'partial', 'sampled']).parse(coverage);
    z.array(z.object({ sample_id: identity, similarity: z.number().finite().min(-1.00001).max(1.00001), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(60).parse(items);
    try {
      return z.object({ published: z.boolean() }).strict().parse(await this.json('/v1/searches/publish', { id, actor, version, coverage, items })).published;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async readSearch(id: string, actor: string, offset = 0, limit = 20): Promise<NativeSearchSession | null> {
    identity.parse(id); actorSchema.parse(actor); z.number().int().min(0).max(60).parse(offset); z.number().int().min(1).max(60).parse(limit);
    try {
      const value = nativeSessionSchema.parse(await this.json('/v1/searches/read', { id, actor, offset, limit }));
      const scope = searchRangeSchema.parse({ channel_ids: value.scope.channel_ids,
        from: new Date(value.scope.from_ms).toISOString(), to: new Date(value.scope.to_ms).toISOString() });
      if (value.search_id !== id || value.items.length > limit ||
        (value.next_offset !== null && (value.next_offset !== offset + limit || value.next_offset > 60)) ||
        (!value.published && (value.items.length || value.next_offset !== null || value.coverage !== 'unknown'))) throw new Error();
      if (value.expires_ms <= Date.now()) return null;
      const ids = new Set<string>();
      const items = value.items.map(row => {
        const { similarity, feedback, ...rest } = row; const sample = nativeSampleSchema.parse(rest);
        if (ids.has(sample.id) || !scope.channel_ids.includes(sample.channel_id) || sample.model_version !== value.model_version ||
          sample.captured_ms < value.scope.from_ms || sample.captured_ms >= value.scope.to_ms || sample.expires_ms <= Date.now()) throw new Error();
        ids.add(sample.id); return { ...sample, similarity, feedback };
      });
      return { ...value, scope, items };
    } catch (error) {
      if (error instanceof SearchNativeError && error.code === 'not_found') return null;
      if (error instanceof SearchNativeError) throw error;
      throw new SearchNativeError('invalid_response');
    }
  }
  async searchFeedback(id: string, actor: string, sampleId: string, relevant: boolean): Promise<void> {
    identity.parse(id); actorSchema.parse(actor); identity.parse(sampleId); z.boolean().parse(relevant);
    try { z.object({ stored: z.literal(true) }).strict().parse(await this.json('/v1/searches/feedback', { id, actor, sample_id: sampleId, relevant })); }
    catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async cancelSearch(id: string, actor: string): Promise<void> {
    identity.parse(id); actorSchema.parse(actor);
    try { z.object({ cancelled: z.literal(true) }).strict().parse(await this.json('/v1/searches/cancel', { id, actor })); }
    catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
}
