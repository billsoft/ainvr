import { createHash } from 'node:crypto';
import { z } from 'zod';
import { searchBoundingBoxSchema } from './searchContract.js';
import { endpoint, limitedBytes, limitedJson, type InternalServiceConnection } from './internalServiceHttp.js';
import { searchQuerySchema, searchRangeSchema,sameSearchScope, type SearchQuery, type SearchScope, type SearchStatus } from './searchContract.js';
import { searchMigrationModelProfileSchema, searchMigrationOrdinalSchema, searchMigrationModelSchema,
  searchModelMigrationPayloadSchema,searchModelMigrationFingerprint,type SearchMigrationModelProfile,searchMigrationWriteProofSchema,type SearchMigrationWriteProof,type SearchMigrationModel } from './searchModelMigrationContract.js';
import {searchMigrationArtifactPageSchema} from './searchModelMigrationArtifacts.js';
import type {SearchJob} from '../store/searchJobs.js';
import { validateSearchVerificationProfile, searchVerificationTargetSchema, searchVerificationBindingSchema,
  searchVerificationViewSchema, searchVerificationCursorSchema, searchVerificationScanSchema, searchVerificationInspectionSchema,
  searchVerificationMutationSchema, searchVerificationResultSchema, searchVerificationAbortReasonSchema, searchVerificationProfileFingerprint,
  type SearchVerificationTarget, type SearchVerificationBinding, type SearchVerificationProfile, type SearchVerificationView,
  type SearchVerificationCursor, type SearchVerificationScan, type SearchVerificationInspection, type SearchVerificationMutation,
  type SearchVerificationResult, type SearchVerificationAbortReason } from './searchVerificationContract.js';
export * from './searchVerificationContract.js';


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
export interface NativeMigrationSample extends NativeSample { fingerprint: string; ordinal: string; jpeg_sha256: string }
export interface NativeMigrationScan { source_model: string; through: string; items: NativeMigrationSample[];
  next_cursor: string | null; exhausted: boolean }
export interface NativeMigrationArtifactState {state:'building_report'|'building_index'|'ready'|'unavailable';checkpoint:string;source_completed_through:string|null;target_checkpoint:string;coverage_snapshot:{required:number;matched:number;unavailable:number};coverage_sha256:string|null;index_manifest_sha256:string|null;reason:string|null}
export type NativeMigrationWriteProof=SearchMigrationWriteProof;
export interface NativeMigrationTargetStored {stored:true;sample_id:string;model_version:string;fingerprint:string;ordinal:string;jpeg_sha256:string}
export type NativeMigrationTargetReceipt=({status:'committed'}&NativeMigrationTargetStored)|{status:'not_found'|'source_changed'|'replaced';stored:false;sample_id:null;model_version:string;fingerprint:null;ordinal:null;jpeg_sha256:null};
export interface NativeMigrationExtent { source_model: string; from_ms: number | null; to_ms: number | null; high_watermark: string }
export interface NativeMigrationCapabilities {implemented:boolean;source_ingestion_gate:boolean;target_write:boolean;artifacts:boolean}
const evidenceRefsSchema = z.array(z.object({ sample_id: identity, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(3)
  .refine(refs => new Set(refs.map(ref => ref.sample_id)).size === refs.length);
const nativeFramesSchema = z.array(z.object({ id: identity, captured_ms: integer, role: z.enum(['match', 'before', 'after']), bbox: searchBoundingBoxSchema.optional() }).strict()).min(1).max(3)
  .refine(frames => new Set(frames.map(frame => frame.id)).size === frames.length && frames.filter(frame => frame.role === 'match').length === 1);

const nativeMatchSchema = z.object({
  model_version: model, partial: z.boolean(),
  items: z.array(z.object({
    // Parse the complete sample separately, since refinement schemas cannot be extended.
    similarity: z.number().finite().min(-1.00001).max(1.00001),
  }).passthrough()).max(60),
}).strict();
export interface NativeMatch {
  model_version: string; partial: boolean;
  items: (NativeSample & { similarity: number; evidence_refs?: z.infer<typeof evidenceRefsSchema> })[];
}
const rangeSchema = z.object({
  channel: identity, from: integer, to: integer, scene: z.boolean(), state: z.enum(['sampled', 'pending', 'gap']),
}).strict();
export type NativeCoverageRange = z.infer<typeof rangeSchema>;
export interface NativeSearchSession {
  search_id: string; version: string; query: string; model_version: string;
  verify: boolean; expires_ms: number; published: boolean;
  coverage: 'unknown' | 'partial' | 'sampled'; scope: SearchScope;
  items: (NativeSample & { similarity: number; feedback: boolean | null; verification?: SearchVerificationView; frames?: z.infer<typeof nativeFramesSchema>; started_ms?: number; ended_ms?: number })[];
  next_offset: number | null;
}
const actorSchema = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const versionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nativeSessionSchema = z.object({
  search_id: identity, version: versionSchema, query: z.string().min(1).max(1024), model_version: model,
  verify: z.boolean(), expires_ms: integer, published: z.boolean(), coverage: z.enum(['unknown', 'partial', 'sampled']),
  scope: z.object({ channel_ids: z.array(identity).min(1).max(100), from_ms: integer, to_ms: integer, limit: z.literal(60) }).strict(),
  items: z.array(z.object({ similarity: z.number().finite().min(-1.00001).max(1.00001), feedback: z.boolean().nullable(), verification: searchVerificationViewSchema.optional() }).passthrough()).max(60),
  next_offset: z.number().int().min(1).max(60).nullable(),
}).strict();
export class SearchNativeError extends Error {
  constructor(readonly code: 'scope_denied' | 'unavailable' | 'model_pending' | 'storage_unavailable' | 'busy' | 'not_found' | 'invalid_response' | 'cancelled' | 'conflict' | 'capacity' | 'query_invalid_utf8' | 'query_too_large' | 'query_too_long' | 'query_unrepresentable') { super(code); }
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
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new SearchNativeError('scope_denied'); }
      if (response.status === 404) { await response.body?.cancel(); throw new SearchNativeError('not_found'); }
      if (response.status === 429) {
        const reason = z.object({ error: z.string() }).safeParse(await limitedJson(response));
        throw new SearchNativeError(reason.success && reason.data.error === 'search_capacity' ? 'capacity' : 'busy');
      }
      if (response.status === 409) { await response.body?.cancel(); throw new SearchNativeError('conflict'); }
      if (response.status === 410) { await response.body?.cancel(); throw new SearchNativeError('cancelled'); }
      const error = z.object({ error: z.string() }).safeParse(await limitedJson(response));
      if(path==='/v1/model-migrations/write-target'&&response.status===507&&error.success&&error.data.error==='capacity_exceeded')throw new SearchNativeError('capacity');
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
  private async json(path: string, body?: unknown, maximum?: number): Promise<unknown> {
    const response = await this.request(path, body);
    try {
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
      return maximum === undefined ? await limitedJson(response) : JSON.parse((await limitedBytes(response, maximum)).toString('utf8'));
    } catch { await response.body?.cancel().catch(() => undefined); throw new SearchNativeError('invalid_response'); }
  }
  async status(): Promise<SearchStatus> {
    try { return statusSchema.parse(await this.json('/v1/status')); }
    catch (error) {
      if (error instanceof SearchNativeError && error.code === 'scope_denied') throw error;
      return { ready: false, model_version: null, reason: error instanceof SearchNativeError && error.code === 'storage_unavailable' ? 'storage_unavailable' : 'service_unavailable' };
    }
  }
  /** Implementation capability only. This never promotes model/config/storage
   * readiness and must be read with the existing management connection. */
  async migrationCapabilities():Promise<NativeMigrationCapabilities>{
    try{return z.object({implemented:z.boolean(),source_ingestion_gate:z.boolean(),target_write:z.boolean(),artifacts:z.boolean()})
      .strict().parse(await this.json('/v1/model-migrations/capabilities',undefined,2048));}
    catch(error){if(error instanceof SearchNativeError)throw error;throw new SearchNativeError('invalid_response');}
  }
  /** Construct a separate instance with the existing management connection.
   * This fixed method never accepts an HBM path, arbitrary URL or caller key. */
  async verifyMigrationModel(packageId: string): Promise<SearchMigrationModelProfile> {
    searchMigrationModelSchema.shape.package_id.parse(packageId);
    try {
      const profile = searchMigrationModelProfileSchema.parse(await this.json('/v1/models/verify', { package_id: packageId }, 8192));
      if (profile.package_id !== packageId) throw new Error();
      return profile;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async migrationWatermark(sourceModel: string, scope: SearchScope): Promise<string> {
    searchMigrationModelSchema.shape.model_version.parse(sourceModel);
    const { limit: _limit, ...range } = nativeScope(scope);
    try {
      const value = z.object({ source_model: z.literal(sourceModel), high_watermark: searchMigrationOrdinalSchema }).strict()
        .parse(await this.json('/v1/samples/watermark', { source_model: sourceModel, scope: range }, 1024));
      return value.high_watermark;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async migrationExtent(sourceModel: string, channelIds: string[]): Promise<NativeMigrationExtent> {
    searchMigrationModelSchema.shape.model_version.parse(sourceModel);
    z.array(identity).min(1).max(1024).refine(ids => new Set(ids).size === ids.length).parse(channelIds);
    try {
      const value = z.object({ source_model: z.literal(sourceModel), from_ms: integer.nullable(), to_ms: integer.nullable(),
        high_watermark: searchMigrationOrdinalSchema }).strict()
        .parse(await this.json('/v1/samples/extent', { source_model: sourceModel, channel_ids: channelIds }, 2048));
      if (value.from_ms === null ? value.to_ms !== null || value.high_watermark !== '0' :
          value.to_ms === null || value.to_ms <= value.from_ms || value.high_watermark === '0') throw new Error();
      return value;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async migrationArtifacts(proof:NativeMigrationWriteProof,action:'start'|'status'='status'):Promise<NativeMigrationArtifactState> {
    const frozen=searchMigrationWriteProofSchema.parse(proof);z.enum(['start','status']).parse(action);
    try {
      const value=z.object({state:z.enum(['building_report','building_index','ready','unavailable']),checkpoint:searchMigrationOrdinalSchema,
        source_completed_through:searchMigrationOrdinalSchema.nullable(),target_checkpoint:searchMigrationOrdinalSchema,
        coverage_snapshot:z.object({required:integer,matched:integer,unavailable:integer}).strict(),coverage_sha256:versionSchema.nullable(),index_manifest_sha256:versionSchema.nullable(),
        reason:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable()}).strict()
        .parse(await this.json('/v1/model-migrations/artifacts',{action,...frozen},8192));
      if(value.coverage_snapshot.matched+value.coverage_snapshot.unavailable!==value.coverage_snapshot.required||
        (value.state==='ready'&&(!value.coverage_sha256||!value.index_manifest_sha256||value.source_completed_through===null)))throw new Error();
      return value;
    }catch(error){if(error instanceof SearchNativeError)throw error;throw new SearchNativeError('invalid_response');}
  }
  async migrationArtifactPage(job: SearchJob,after:string|null,limit:32) {
    const payload=searchModelMigrationPayloadSchema.parse(job.payload);
    identity.parse(job.id);z.number().int().positive().parse(job.generation);z.literal(32).parse(limit);searchMigrationWriteProofSchema.shape.actor.parse(job.actor);
    if(after!==null)z.string().regex(/^[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}$/).parse(after);
    try {
      const raw=z.object({scope:z.object({channel_ids:z.array(identity).min(1).max(100),from_ms:integer,to_ms:integer}).strict()}).passthrough()
        .parse(await this.json('/v1/model-migrations/artifacts',{action:'read',job_id:job.id,generation:job.generation,actor:job.actor,
          payload_fingerprint:searchModelMigrationFingerprint(payload),after,limit},32768));
      const value=searchMigrationArtifactPageSchema.parse({...raw,scope:{channel_ids:raw.scope.channel_ids,
        from:new Date(raw.scope.from_ms).toISOString(),to:new Date(raw.scope.to_ms).toISOString()}});
      if(value.payload_fingerprint!==searchModelMigrationFingerprint(payload)||JSON.stringify(value.source)!==JSON.stringify(payload.source)||
        JSON.stringify(value.target)!==JSON.stringify(payload.target)||!sameSearchScope(value.scope,payload.scope)||value.source_completed_through!==payload.source_high_watermark)
        throw new Error();
      return value;
    }catch(error){if(error instanceof SearchNativeError)throw error;throw new SearchNativeError('invalid_response');}
  }
  async scanMigration(sourceModel: string, scope: SearchScope, after: string | null, through: string, limit = 32): Promise<NativeMigrationScan> {
    searchMigrationModelSchema.shape.model_version.parse(sourceModel); searchMigrationOrdinalSchema.parse(through);
    if (after !== null) searchMigrationOrdinalSchema.parse(after);
    z.number().int().min(1).max(32).parse(limit);
    if (after !== null && BigInt(after) > BigInt(through)) throw new SearchNativeError('invalid_response');
    const { limit: _limit, ...range } = nativeScope(scope);
    try {
      const raw = z.object({ source_model: z.literal(sourceModel), through: z.literal(through),
        items: z.array(z.unknown()).max(limit), next_cursor: searchMigrationOrdinalSchema.nullable(), exhausted: z.boolean(),
      }).strict().parse(await this.json('/v1/samples/scan', { source_model: sourceModel, scope: range, after, through, limit }, 262144));
      const ids = new Set<string>(); let ordinal = BigInt(after ?? '0');
      const items = raw.items.map(row => {
        const extra = z.object({ ordinal: searchMigrationOrdinalSchema, jpeg_sha256: versionSchema }).passthrough().parse(row);
        const { ordinal: at, jpeg_sha256, ...metadata } = extra;
        const sample = nativeSampleSchema.parse(metadata);
        if (!sample.fingerprint || sample.model_version !== sourceModel || !scope.channel_ids.includes(sample.channel_id) ||
            sample.captured_ms < range.from_ms || sample.captured_ms >= range.to_ms || sample.expires_ms <= Date.now() ||
            ids.has(sample.id) || BigInt(at) <= ordinal || BigInt(at) > BigInt(through)) throw new Error();
        ids.add(sample.id); ordinal = BigInt(at); return { ...sample, fingerprint: sample.fingerprint, ordinal: at, jpeg_sha256 };
      });
      if ((raw.exhausted && raw.next_cursor !== null) || (!raw.exhausted && (raw.next_cursor === null ||
          BigInt(raw.next_cursor) <= BigInt(after ?? '0') || BigInt(raw.next_cursor) < ordinal || BigInt(raw.next_cursor) > BigInt(through)))) throw new Error();
      return { ...raw, items };
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async migrationImage(sample: NativeMigrationSample, scope: SearchScope): Promise<Buffer | null> {
    const { ordinal, jpeg_sha256, ...metadata } = sample;
    searchMigrationOrdinalSchema.parse(ordinal); versionSchema.parse(jpeg_sha256);
    nativeSampleSchema.parse(metadata); versionSchema.parse(sample.fingerprint);
    searchMigrationModelSchema.shape.model_version.parse(sample.model_version);
    const { limit: _limit, ...range } = nativeScope(scope);
    if (!scope.channel_ids.includes(sample.channel_id) || sample.captured_ms < range.from_ms || sample.captured_ms >= range.to_ms || sample.expires_ms <= Date.now())
      throw new SearchNativeError('invalid_response');
    const image = await this.jpeg('/v1/samples/reencode-image', { sample_id: sample.id, fingerprint: sample.fingerprint, source_model: sample.model_version, scope: range });
    if (image && createHash('sha256').update(image).digest('hex') !== jpeg_sha256) throw new SearchNativeError('invalid_response');
    return image;
  }
  /** Target writes use the fixed management connection; never retry here.
   * A timeout, 409 or damaged ACK is unknown to the caller and must be reconciled
   * using the exact source lineage. not_found is not a rejection authorization. */
  async migrationWriteTarget(proof:NativeMigrationWriteProof,source:NativeMigrationSample,target:SearchMigrationModelProfile,
    vector:readonly number[]):Promise<NativeMigrationTargetStored> {
    const frozen=this.migrationTargetRequest(proof,source,target);
    try {
      const profile=searchMigrationModelProfileSchema.parse(target);
      if(!profile.files_verified||!Array.isArray(vector)||vector.length!==profile.dimensions||vector.some(value=>!Number.isFinite(value)))throw new Error();
      const norm=vector.reduce((sum,value)=>sum+value*value,0);if(!Number.isFinite(norm)||Math.abs(norm-1)>0.001)throw new Error();
    }catch{throw new SearchNativeError('invalid_response');}
    try {
      const value=z.object({stored:z.literal(true),sample_id:identity,model_version:z.literal(target.model_version),fingerprint:versionSchema,
        ordinal:searchMigrationOrdinalSchema.refine(value=>BigInt(value)>0),jpeg_sha256:z.literal(source.jpeg_sha256)}).strict()
        .parse(await this.json('/v1/model-migrations/write-target',{...frozen,target:{...frozen.target,vector}},2048));
      return value;
    }catch(error){if(error instanceof SearchNativeError)throw error;throw new SearchNativeError('invalid_response');}
  }
  async migrationTargetReceipt(proof:NativeMigrationWriteProof,source:NativeMigrationSample,target:SearchMigrationModel):Promise<NativeMigrationTargetReceipt> {
    const frozen=this.migrationTargetRequest(proof,source,target);
    try {
      const value=z.discriminatedUnion('status',[
        z.object({status:z.literal('committed'),stored:z.literal(true),sample_id:identity,model_version:z.literal(target.model_version),fingerprint:versionSchema,
          ordinal:searchMigrationOrdinalSchema.refine(value=>BigInt(value)>0),jpeg_sha256:z.literal(source.jpeg_sha256)}).strict(),
        z.object({status:z.enum(['not_found','source_changed','replaced']),stored:z.literal(false),sample_id:z.null(),model_version:z.literal(target.model_version),
          fingerprint:z.null(),ordinal:z.null(),jpeg_sha256:z.null()}).strict(),
      ]).parse(await this.json('/v1/model-migrations/target-receipt',frozen,2048));
      return value;
    }catch(error){if(error instanceof SearchNativeError)throw error;throw new SearchNativeError('invalid_response');}
  }
  private migrationTargetRequest(proof:NativeMigrationWriteProof,source:NativeMigrationSample,target:SearchMigrationModel) {
    try {
      const authority=searchMigrationWriteProofSchema.parse(proof),selected=searchMigrationModelSchema.parse({package_id:target.package_id,package_sha256:target.package_sha256,model_version:target.model_version});
      if(selected.package_sha256!==selected.model_version.slice(10)||source.model_version===selected.model_version)throw new Error();
      const {ordinal,jpeg_sha256,...metadata}=source;nativeSampleSchema.parse(metadata);searchMigrationOrdinalSchema.refine(value=>BigInt(value)>0).parse(ordinal);
      versionSchema.parse(source.fingerprint);versionSchema.parse(jpeg_sha256);searchMigrationModelSchema.shape.model_version.parse(source.model_version);
      return {...authority,source:{sample_id:source.id,fingerprint:source.fingerprint,jpeg_sha256},target:selected};
    }catch{throw new SearchNativeError('invalid_response');}
  }
  async match(query: string, scope: SearchScope, expectedModel: string): Promise<NativeMatch> {
    model.parse(expectedModel); z.string().trim().min(1).max(256).parse(query);
    const input = nativeScope(scope);
    try {
      const raw = nativeMatchSchema.parse(await this.json('/v1/match', { query, scope: input }));
      if (raw.model_version !== expectedModel) throw new Error();
      const ids = new Set<string>();
      const items = raw.items.map(row => {
        const { similarity, evidence_refs: refs, ...value } = row; const sample = nativeSampleSchema.parse(value);
        const evidence_refs = refs === undefined ? undefined : evidenceRefsSchema.parse(refs);
        if (evidence_refs && (!sample.fingerprint || !evidence_refs.some(ref => ref.sample_id === sample.id && ref.fingerprint === sample.fingerprint) ||
          (sample.kind === 'scene' && (evidence_refs.length !== 1 || evidence_refs[0]!.sample_id !== sample.id)))) throw new Error();
        if (ids.has(sample.id) || !scope.channel_ids.includes(sample.channel_id) || sample.captured_ms < input.from_ms ||
          sample.captured_ms >= input.to_ms || sample.model_version !== expectedModel || sample.expires_ms <= Date.now()) throw new Error();
        ids.add(sample.id); return { ...sample, similarity, ...(evidence_refs ? { evidence_refs } : {}) };
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
    items: { sample_id: string; similarity: number; fingerprint?: string; evidence_refs?: z.infer<typeof evidenceRefsSchema> }[]): Promise<boolean> {
    identity.parse(id); actorSchema.parse(actor); versionSchema.parse(version);
    z.enum(['unknown', 'partial', 'sampled']).parse(coverage);
    z.array(z.object({ sample_id: identity, similarity: z.number().finite().min(-1.00001).max(1.00001), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), evidence_refs: evidenceRefsSchema.optional() }).strict()).max(60).parse(items);
    for(const item of items) if(item.evidence_refs && (!item.fingerprint || !item.evidence_refs.some(ref => ref.sample_id === item.sample_id && ref.fingerprint === item.fingerprint)))
      throw new SearchNativeError('invalid_response');
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
        const { similarity, feedback, verification, frames: rawFrames, started_ms: rawStart, ended_ms: rawEnd, ...rest } = row; const sample = nativeSampleSchema.parse(rest);
        const frames = rawFrames === undefined ? undefined : nativeFramesSchema.parse(rawFrames);
        const started_ms = rawStart === undefined ? undefined : integer.parse(rawStart), ended_ms = rawEnd === undefined ? undefined : integer.parse(rawEnd);
        if (frames ? started_ms === undefined || ended_ms === undefined || started_ms > sample.captured_ms || ended_ms < sample.captured_ms ||
          started_ms < value.scope.from_ms || ended_ms >= value.scope.to_ms || frames.some(frame => frame.captured_ms < started_ms || frame.captured_ms > ended_ms) ||
          !frames.some(frame => frame.role === 'match' && frame.id === sample.evidence.frame_id && frame.captured_ms === sample.captured_ms) ||
          (sample.kind === 'scene' && frames.length !== 1) : started_ms !== undefined || ended_ms !== undefined) throw new Error();
        if (verification && !sample.fingerprint) throw new Error();
        if (ids.has(sample.id) || !scope.channel_ids.includes(sample.channel_id) || sample.model_version !== value.model_version ||
          sample.captured_ms < value.scope.from_ms || sample.captured_ms >= value.scope.to_ms || sample.expires_ms <= Date.now()) throw new Error();
        ids.add(sample.id); return { ...sample, similarity, feedback, ...(verification ? { verification } : {}), ...(frames ? { frames, started_ms, ended_ms } : {}) };
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
  private async verificationMutation(body: unknown, binding: SearchVerificationBinding): Promise<SearchVerificationMutation> {
    try {
      const result = searchVerificationMutationSchema.parse(await this.json('/v1/searches/verification', body));
      if (result.verification && result.verification.profile_fp !== binding.profile_fp &&
          !(result.status === 'already_submitted' && result.submitted)) throw new Error();
      return result;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async scanVerification(profileFp: string, cursor: SearchVerificationCursor | null = null): Promise<SearchVerificationScan> {
    versionSchema.parse(profileFp); if (cursor) searchVerificationCursorSchema.parse(cursor);
    try {
      const value = searchVerificationScanSchema.parse(await this.json('/v1/searches/verification', { action: 'scan', profile_fp: profileFp, cursor }));
      if (cursor && value.next_cursor && (value.next_cursor.created_ms > cursor.created_ms ||
          (value.next_cursor.created_ms === cursor.created_ms && value.next_cursor.key >= cursor.key))) throw new Error();
      return value;
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async inspectVerification(target: SearchVerificationTarget, rawProfile: SearchVerificationProfile,
    questionScope: 'visible' | 'temporal' = 'visible'): Promise<SearchVerificationInspection> {
    searchVerificationTargetSchema.parse(target); const profile = validateSearchVerificationProfile(rawProfile);
    z.enum(['visible', 'temporal']).parse(questionScope);
    try {
      const value = searchVerificationInspectionSchema.parse(await this.json('/v1/searches/verification', {
        action: 'inspect', target, profile, question_scope: questionScope,
      }));
      if (!value.binding) return { ...value, scope: null };
      if (value.status === 'profile_superseded' || value.status === 'cancelled' || value.status === 'submitted') {
        if (value.binding.search_id !== target.search_id || value.binding.actor !== target.actor || value.binding.version !== target.version ||
            value.verification?.profile_fp !== value.binding.profile_fp || value.submitted?.request_id !== value.verification.request_id)
          throw new Error();
        if (value.status === 'submitted' && (value.binding.sample_id !== target.sample_id ||
            value.binding.profile_fp !== profile.profile_fp || value.binding.question_scope !== questionScope)) throw new Error();
        return { ...value, scope: null };
      }
      if (value.binding.search_id !== target.search_id || value.binding.actor !== target.actor || value.binding.version !== target.version ||
          value.binding.sample_id !== target.sample_id || value.binding.profile_fp !== profile.profile_fp || value.binding.question_scope !== questionScope ||
          value.binding.query_sha256 !== createHash('sha256').update(value.query!, 'utf8').digest('hex') ||
          (value.verification && value.verification.profile_fp !== profile.profile_fp)) throw new Error();
      const scope = searchRangeSchema.parse({ channel_ids: value.scope!.channel_ids,
        from: new Date(value.scope!.from_ms).toISOString(), to: new Date(value.scope!.to_ms).toISOString() });
      if (value.expires_ms! <= Date.now()) return { status: 'unavailable', binding: null, query: null, kind: null, scope: null, expires_ms: null,
        verification: null, submitted: value.submitted };
      return { ...value, scope };
    } catch (error) { if (error instanceof SearchNativeError) throw error; throw new SearchNativeError('invalid_response'); }
  }
  async queueVerification(binding: SearchVerificationBinding, jobId: string, generation: number,
    rawProfile: SearchVerificationProfile): Promise<SearchVerificationMutation> {
    searchVerificationBindingSchema.parse(binding); identity.parse(jobId); integer.parse(generation);
    const profile = validateSearchVerificationProfile(rawProfile);
    if (profile.profile_fp !== binding.profile_fp) throw new SearchNativeError('invalid_response');
    return this.verificationMutation({ action: 'queued', binding, job_id: jobId, generation, profile }, binding);
  }
  async beginVerification(binding: SearchVerificationBinding, jobId: string, generation: number, requestId: string): Promise<SearchVerificationMutation> {
    searchVerificationBindingSchema.parse(binding); identity.parse(jobId); integer.min(1).parse(generation);
    z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).parse(requestId);
    const value = await this.verificationMutation({ action: 'begin', binding, job_id: jobId, generation, request_id: requestId }, binding);
    if (value.status === 'submit' && (value.submitted?.job_id !== jobId || value.submitted.generation !== generation || value.submitted.request_id !== requestId))
      throw new SearchNativeError('invalid_response');
    return value;
  }
  async finishVerification(binding: SearchVerificationBinding, jobId: string, generation: number,
    requestId: string, result: SearchVerificationResult): Promise<SearchVerificationMutation> {
    searchVerificationBindingSchema.parse(binding); identity.parse(jobId); integer.min(1).parse(generation);
    z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).parse(requestId); searchVerificationResultSchema.parse(result);
    const fp = searchVerificationProfileFingerprint({ task_id: result.template, template_sha256: result.template_sha256,
      preprocessing_version: result.preprocessing_version, decision_policy: result.decision_policy,
      model_package_id: result.model.package_id, model_package_sha256: result.model.package_sha256 });
    if (fp !== binding.profile_fp || result.request_id !== requestId || result.frame_id !== binding.frame_id ||
        result.query_sha256 !== binding.query_sha256 || result.evidence_sha256 !== binding.jpeg_sha256 || result.question_scope !== binding.question_scope)
      throw new SearchNativeError('invalid_response');
    const value = await this.verificationMutation({ action: 'finish', binding, job_id: jobId, generation, request_id: requestId, result }, binding);
    if (value.stored && (value.status !== 'final' || value.verification?.request_id !== requestId || value.verification.cached))
      throw new SearchNativeError('invalid_response');
    return value;
  }
  async abortVerification(binding: SearchVerificationBinding, jobId: string, generation: number,
    requestId: string | null, reason: SearchVerificationAbortReason): Promise<SearchVerificationMutation> {
    searchVerificationBindingSchema.parse(binding); identity.parse(jobId); integer.parse(generation);
    if (requestId !== null) z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).parse(requestId);
    searchVerificationAbortReasonSchema.parse(reason);
    const value = await this.verificationMutation({ action: 'abort', binding, job_id: jobId, generation, request_id: requestId, reason }, binding);
    if (value.stored && (value.status !== 'final' || value.verification?.state !== 'unavailable' || value.verification.request_id !== requestId))
      throw new SearchNativeError('invalid_response');
    return value;
  }

}
