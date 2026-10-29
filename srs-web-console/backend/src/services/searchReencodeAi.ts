import { createHash } from 'node:crypto';
import { z } from 'zod';
import { endpoint, limitedBytes, type InternalServiceConnection } from './internalServiceHttp.js';
import { searchMigrationModelSchema, type SearchMigrationModel } from './searchModelMigrationContract.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const searchReencodeRequestSchema = z.object({
  schema_version: z.literal('search-reencode-image-v1'), request_id: uuid, job_id: uuid,
  generation: integer.refine(value => value > 0), payload_fingerprint: hash,
  target: searchMigrationModelSchema, sample_id: uuid, source_fingerprint: hash,
  jpeg_sha256: hash, expires_ms: integer,
}).strict().superRefine((value, context) => {
  if (value.target.model_version !== `search-v1-${value.target.package_sha256}`)
    context.addIssue({ code: 'custom', message: 'reencode_target_identity_mismatch' });
});
export type SearchReencodeRequest = z.infer<typeof searchReencodeRequestSchema>;
export const searchReencodeResultSchema = searchReencodeRequestSchema.innerType().extend({
  input_kind: z.literal('retained-jpeg'),
  preprocessing_version: z.literal('jpeg-jpu-full-bt601-gles-area256-v1'),
  image_width: z.number().int().min(2).max(8192), image_height: z.number().int().min(2).max(8192),
  dimensions: z.number().int().min(1).max(4096), vector: z.array(z.number().finite().min(-1.00001).max(1.00001)).min(1).max(4096),
}).strict().superRefine((value, context) => {
  const square = value.vector.reduce((sum, item) => sum + item * item, 0);
  if (value.dimensions !== value.vector.length || Math.abs(square - 1) > .001 ||
      value.target.model_version !== `search-v1-${value.target.package_sha256}`)
    context.addIssue({ code: 'custom', message: 'reencode_vector_contract_invalid' });
});
export type SearchReencodeResult = z.infer<typeof searchReencodeResultSchema>;
export const searchReencodeCapabilitiesSchema = z.object({
  schema_version: z.literal('search-reencode-capabilities-v1'), implemented: z.boolean(),
  target_package_ids: z.array(searchMigrationModelSchema.shape.package_id).max(16)
    .refine(ids => new Set(ids).size === ids.length),
  max_image_bytes: z.number().int().min(1).max(8 * 1024 * 1024),
  max_duration_ms: z.number().int().min(1001).max(30000),
  cpu_model_fallback: z.literal(false), cpu_image_processing: z.literal(false),
}).strict().refine(value => value.implemented || value.target_package_ids.length === 0);
export type SearchReencodeCapabilities = z.infer<typeof searchReencodeCapabilitiesSchema>;
export class SearchReencodeAiError extends Error {
  constructor(readonly code: 'unavailable' | 'busy' | 'expired' | 'invalid_result' | 'cancelled' | 'timeout' |
    'unsupported_image' | 'target_changed' | 'model_unavailable' | 'not_authorized') { super(code); }
}

/** Reuses the authenticated AI control service and fixed internal transport.
 * Only one original JPEG is sent, as raw bytes; no browser URL, model path,
 * base64 image copy, independent queue, fallback model or inference retry. */
export class SearchReencodeAiClient {
  constructor(private readonly connection: () => Promise<InternalServiceConnection | null>,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now = Date.now) {}
  /** Capability is implementation support only, never a claim that the model
   * is loaded, licensed or currently fits the shared hardware budget. */
  async capabilities(signal?: AbortSignal): Promise<SearchReencodeCapabilities> {
    try {
      if (signal?.aborted) throw new SearchReencodeAiError('cancelled');
      const config = await this.connection(); if (!config) throw new SearchReencodeAiError('unavailable');
      const target = endpoint(config, '/api/v1/search/reencode/capabilities');
      if (config.apiToken.length > 512 || /[\r\n]/.test(config.apiToken)) throw new SearchReencodeAiError('unavailable');
      const timeout = AbortSignal.timeout(Math.min(config.timeoutMs, 5000));
      const response = await this.fetchImpl(target, { method: 'GET', redirect: 'error', headers: { 'x-api-key': config.apiToken },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SearchReencodeAiError([401,403].includes(response.status) ? 'not_authorized' : 'unavailable');
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw new SearchReencodeAiError('invalid_result');
      }
      const value = searchReencodeCapabilitiesSchema.parse(JSON.parse((await limitedBytes(response, 8192)).toString('utf8')));
      if (signal?.aborted) throw new SearchReencodeAiError('cancelled');
      return value;
    } catch (error) {
      if (error instanceof SearchReencodeAiError) throw error;
      if (signal?.aborted) throw new SearchReencodeAiError('cancelled');
      throw new SearchReencodeAiError(error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_result' : 'unavailable');
    }
  }
  async encode(input: { request: SearchReencodeRequest; dimensions: number; jpeg: Buffer; signal?: AbortSignal }): Promise<SearchReencodeResult> {
    const request = searchReencodeRequestSchema.parse(input.request), now = this.now();
    if (request.expires_ms <= now + 1000 || request.expires_ms > now + 30000)
      throw new SearchReencodeAiError('expired');
    z.number().int().min(1).max(4096).parse(input.dimensions);
    if (input.jpeg.length < 4 || input.jpeg.length > 8 * 1024 * 1024 || input.jpeg[0] !== 255 || input.jpeg[1] !== 216 ||
        input.jpeg.at(-2) !== 255 || input.jpeg.at(-1) !== 217 || createHash('sha256').update(input.jpeg).digest('hex') !== request.jpeg_sha256)
      throw new SearchReencodeAiError('invalid_result');
    const header = JSON.stringify(request);
    if (Buffer.byteLength(header) > 2048 || /[^\x20-\x7e]/.test(header)) throw new SearchReencodeAiError('invalid_result');
    try {
      if (input.signal?.aborted) throw new SearchReencodeAiError('cancelled');
      const connection = await this.connection(); if (!connection) throw new SearchReencodeAiError('unavailable');
      const target = endpoint(connection, '/api/v1/search/reencode');
      if (connection.apiToken.length > 512 || /[\r\n]/.test(connection.apiToken)) throw new SearchReencodeAiError('unavailable');
      const remaining = request.expires_ms - this.now(); if (remaining <= 1000) throw new SearchReencodeAiError('expired');
      const timeout = AbortSignal.timeout(Math.min(connection.timeoutMs, remaining));
      const response = await this.fetchImpl(target, { method: 'POST', redirect: 'error', headers: {
        'x-api-key': connection.apiToken, 'content-type': 'image/jpeg', 'x-ainvr-search-reencode': header,
      }, body: new Uint8Array(input.jpeg.buffer, input.jpeg.byteOffset, input.jpeg.byteLength),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout });
      if (!response.ok) {
        let reason: string | undefined;
        if (/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
          try { reason = z.object({ error: z.object({ code: z.string().max(128) }).passthrough() }).passthrough()
            .parse(JSON.parse((await limitedBytes(response, 8192)).toString('utf8'))).error.code; } catch { /* Do not trust vendor exception text. */ }
        } else await response.body?.cancel();
        if (reason === 'search_reencode_target_changed') throw new SearchReencodeAiError('target_changed');
        if (reason === 'search_reencode_unsupported_image') throw new SearchReencodeAiError('unsupported_image');
        if (reason === 'search_reencode_model_unavailable') throw new SearchReencodeAiError('model_unavailable');
        if ([401,403].includes(response.status)) throw new SearchReencodeAiError('not_authorized');
        throw new SearchReencodeAiError(response.status === 429 ? 'busy' :
          response.status === 410 ? 'expired' : response.status === 504 ? 'timeout' : 'unavailable');
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw new SearchReencodeAiError('invalid_result');
      }
      const result = searchReencodeResultSchema.parse(JSON.parse((await limitedBytes(response, 131072)).toString('utf8')));
      if (input.signal?.aborted) throw new SearchReencodeAiError('cancelled');
      if (this.now() >= request.expires_ms) throw new SearchReencodeAiError('expired');
      for (const key of Object.keys(request) as (keyof SearchReencodeRequest)[])
        if (JSON.stringify(result[key]) !== JSON.stringify(request[key])) throw new SearchReencodeAiError('invalid_result');
      if (result.dimensions !== input.dimensions) throw new SearchReencodeAiError('invalid_result');
      return result;
    } catch (error) {
      if (error instanceof SearchReencodeAiError) throw error;
      if (input.signal?.aborted) throw new SearchReencodeAiError('cancelled');
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new SearchReencodeAiError('timeout');
      throw new SearchReencodeAiError(error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_result' : 'unavailable');
    }
  }
}
