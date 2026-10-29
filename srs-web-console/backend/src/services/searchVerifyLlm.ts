import { createHash } from 'node:crypto';
import { z } from 'zod';
import { limitedBytes } from './internalServiceHttp.js';
import { searchVerificationProfileFingerprint, searchVerificationResultSchema, validateSearchVerificationProfile,
  type SearchVerificationBinding, type SearchVerificationProfile, type SearchVerificationResult } from './searchVerificationContract.js';

export interface SearchVerifyLlmConnection { baseUrl: string; inference: string | null; inferenceTimeoutMs?: number }
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const profileSchema = z.object({ template: z.literal('search-verify-zh-v1'), template_sha256: hash,
  preprocessing_version: z.string().min(1).max(128), decision_policy: z.literal('abc-visible-v1'),
  model: z.object({ package_id: z.string().min(1).max(128), package_sha256: hash }).strict().nullable(),
  enabled: z.boolean(), available: z.boolean(), reason: z.enum(['disabled', 'model_not_loaded', 'decision_vocabulary_unavailable']).nullable(),
  validated: z.literal(false),
}).strict().superRefine((v, ctx) => {
  if (v.available ? !v.enabled || !v.model || v.reason !== null : v.reason === null)
    ctx.addIssue({ code: 'custom', message: 'invalid_search_task_profile' });
});
export class SearchVerifyLlmError extends Error {
  constructor(readonly code: 'task_unavailable' | 'request_timeout' | 'search_busy' | 'input_too_long' | 'invalid_result' | 'cancelled' | 'inference_failed') { super(code); }
}
export const searchVerifyQuerySha = (query: string) => createHash('sha256').update(query.trim(), 'utf8').digest('hex');
/** Matches the LLM's canonical nlohmann object dump, not API field order. */
export function searchVerifyInputSha(query: string, binding: SearchVerificationBinding, profile: SearchVerificationProfile, kind: 'object' | 'scene') {
  return createHash('sha256').update(JSON.stringify({ evidence_sha256: binding.jpeg_sha256, frame_id: binding.frame_id,
    kind, model_sha256: profile.model_package_sha256, preprocessing_version: profile.preprocessing_version,
    query: query.trim(), question_scope: binding.question_scope, template_sha256: profile.template_sha256 }), 'utf8').digest('hex');
}
export interface SearchVerifyLlmPort {
  profile(signal?: AbortSignal): Promise<SearchVerificationProfile | null>;
  verify(input: { requestId: string; query: string; kind: 'object' | 'scene'; binding: SearchVerificationBinding;
    profile: SearchVerificationProfile; jpeg: Buffer; signal?: AbortSignal }): Promise<SearchVerificationResult>;
  cancel(requestId: string, signal?: AbortSignal): Promise<boolean>;
}
/** Uses the dedicated applied search-verify caller. It neither loads a model nor
 * borrows alarm credentials; unknown HTTP outcomes are never inference retries. */
export class SearchVerifyLlmClient implements SearchVerifyLlmPort {
  constructor(private readonly connection: () => Promise<SearchVerifyLlmConnection | null>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async request(path: string, body: unknown | undefined, maximumMs: number, signal?: AbortSignal): Promise<unknown> {
    try {
      const config = await this.connection();
      if (!config?.inference || config.inference.length < 32 || config.inference.length > 512 || /[\r\n]/.test(config.inference)) throw new SearchVerifyLlmError('task_unavailable');
      const base = new URL(config.baseUrl);
      if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'host.docker.internal', '[::1]'].includes(base.hostname) ||
        base.port !== '8300' || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new SearchVerifyLlmError('task_unavailable');
      const configured = config.inferenceTimeoutMs ?? 60000;
      if (!Number.isInteger(configured) || configured < 1000 || configured > 440000) throw new SearchVerifyLlmError('task_unavailable');
      const timeout = AbortSignal.timeout(Math.min(maximumMs, configured));
      const response = await this.fetchImpl(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${config.inference}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new SearchVerifyLlmError('invalid_result'); }
      const raw: unknown = JSON.parse((await limitedBytes(response, 16384)).toString('utf8'));
      if (response.ok) return raw;
      if (response.status === 410) throw new SearchVerifyLlmError('cancelled');
      if (response.status === 429 || response.status === 409) throw new SearchVerifyLlmError('search_busy');
      if (response.status === 504) throw new SearchVerifyLlmError('request_timeout');
      const error = z.object({ error: z.object({ code: z.string() }).passthrough() }).passthrough().safeParse(raw);
      if (error.success && ['input_too_long', 'query_too_long'].includes(error.data.error.code)) throw new SearchVerifyLlmError('input_too_long');
      throw new SearchVerifyLlmError(response.status === 401 || response.status === 403 || response.status === 503 ? 'task_unavailable' : 'inference_failed');
    } catch (error) {
      if (error instanceof SearchVerifyLlmError) throw error;
      if (signal?.aborted) throw new SearchVerifyLlmError('cancelled');
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new SearchVerifyLlmError('request_timeout');
      throw new SearchVerifyLlmError('inference_failed');
    }
  }
  async profile(signal?: AbortSignal): Promise<SearchVerificationProfile | null> {
    try {
      const raw = profileSchema.parse(await this.request('/v1/ainvr/tasks/search-verify-zh-v1/profile', undefined, 3000, signal));
      if (!raw.available || !raw.model) return null;
      const profile = { task_id: raw.template, template_sha256: raw.template_sha256, preprocessing_version: raw.preprocessing_version,
        decision_policy: raw.decision_policy, model_package_id: raw.model.package_id, model_package_sha256: raw.model.package_sha256 };
      return validateSearchVerificationProfile({ ...profile, profile_fp: searchVerificationProfileFingerprint(profile) });
    } catch (error) { if (error instanceof z.ZodError) throw new SearchVerifyLlmError('invalid_result'); throw error; }
  }
  async verify(input: Parameters<SearchVerifyLlmPort['verify']>[0]): Promise<SearchVerificationResult> {
    const profile = validateSearchVerificationProfile(input.profile), binding = input.binding, query = input.query.trim();
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.requestId) || !query || Buffer.byteLength(query, 'utf8') > 1024 ||
      searchVerifyQuerySha(query) !== binding.query_sha256 || binding.profile_fp !== profile.profile_fp ||
      input.jpeg.length < 4 || input.jpeg.length > 8 * 1024 * 1024 || input.jpeg[0] !== 255 || input.jpeg[1] !== 216 ||
      input.jpeg.at(-2) !== 255 || input.jpeg.at(-1) !== 217 || createHash('sha256').update(input.jpeg).digest('hex') !== binding.jpeg_sha256)
      throw new SearchVerifyLlmError('invalid_result');
    try {
      const result = searchVerificationResultSchema.parse(await this.request('/v1/ainvr/tasks/search-verify-zh-v1', {
        request_id: input.requestId, query, question_scope: binding.question_scope,
        evidence: { kind: input.kind, frame_id: binding.frame_id, sha256: binding.jpeg_sha256 }, image: { jpeg_base64: input.jpeg.toString('base64'), fit: 'letterbox' },
      }, 440000, input.signal));
      if (result.request_id !== input.requestId || result.frame_id !== binding.frame_id || result.evidence_sha256 !== binding.jpeg_sha256 ||
        result.query_sha256 !== binding.query_sha256 || result.question_scope !== binding.question_scope || result.kind !== input.kind ||
        result.template_sha256 !== profile.template_sha256 || result.preprocessing_version !== profile.preprocessing_version ||
        result.model.package_id !== profile.model_package_id || result.model.package_sha256 !== profile.model_package_sha256 ||
        result.input_sha256 !== searchVerifyInputSha(query, binding, profile, input.kind)) throw new SearchVerifyLlmError('invalid_result');
      return result;
    } catch (error) { if (error instanceof z.ZodError) throw new SearchVerifyLlmError('invalid_result'); throw error; }
  }
  async cancel(requestId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) throw new SearchVerifyLlmError('invalid_result');
    try {
      const result = z.object({ request_id: z.string(), cancelled: z.boolean() }).strict()
        .parse(await this.request('/v1/ainvr/tasks/search-verify-zh-v1/cancel', { request_id: requestId }, 3000, signal));
      if (result.request_id !== requestId) throw new SearchVerifyLlmError('invalid_result');
      return result.cancelled;
    } catch (error) { if (error instanceof z.ZodError) throw new SearchVerifyLlmError('invalid_result'); throw error; }
  }
}
