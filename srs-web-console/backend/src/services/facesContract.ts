import { z } from 'zod';
import { searchRangeSchema } from './searchContract.js';

export const facesId = z.string().uuid();
export const facesModel = z.enum(['mbf', 'r50']);
export const facesPin = z.string().regex(/^[a-f0-9]{64}$/);
export const facesQuality = z.object({ state: z.enum(['qualified', 'rejected', 'unknown']), reason: z.string().max(200).nullable() }).strict();
export const facesDiagnostic = z.object({ task: z.enum(['maintenance', 'reconcile', 'producer']), state: z.enum(['unknown', 'ok', 'degraded']), reason: z.string().max(80).nullable(), last_success_at: z.string().nullable() }).strict();
export type FacesDiagnostic = z.infer<typeof facesDiagnostic>;
export const facesStatusSchema = z.object({
  ready: z.boolean(), reason: z.string().max(200).nullable(), accuracy_verified: z.boolean(),
  active_model: facesModel.nullable().optional(), desired_model: facesModel.nullable().optional(),
  diagnostics: z.array(facesDiagnostic).max(3).optional(),
  spaces: z.array(z.object({ model: facesModel, space_id: facesPin, active: z.boolean(), dimensions: z.number().int().min(1).max(4096), alignment_version: z.string().min(1).max(128), metric: z.literal('cosine') }).strict()).max(20000),
}).strict();
export const facesTemplateSchema = z.object({
  template_id: facesId, photo_ref: facesId, actor: z.string().min(1).max(128),
  library_id: facesId, member_id: facesId, request_id: facesId,
  model: facesModel, space_id: facesPin, quality: facesQuality,
  jpeg_sha256: facesPin, expires_at: z.string().datetime({ offset: true }),
}).strict();
export const facesMemberInput = z.object({ id: facesId, name: z.string().trim().min(1).max(80), note: z.string().trim().max(240).default(''), template_id: facesId.nullable().default(null) }).strict();
export const facesDocumentSchema = z.object({
  name: z.string().trim().min(1).max(80), model: facesModel.default('mbf'),
  channel_ids: z.array(facesId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate channels'),
  valid_until: z.string().datetime({ offset: true }), retention_days: z.number().int().min(1).max(90),
  match_requested: z.boolean().default(false), match_threshold: z.number().finite().min(-1).max(1).nullable().default(null),
  access: z.literal('console-management'), members: z.array(facesMemberInput).max(500).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate members'),
}).strict().refine(value => !value.match_requested || value.match_threshold !== null, 'Candidate matching requires an explicit threshold');
export const facesSaveSchema = z.object({ expected_version: z.number().int().min(0).max(2147483646), document: facesDocumentSchema }).strict();
export const facesDeleteSchema = z.object({ expected_version: z.number().int().min(1).max(2147483646) }).strict();
export const facesUploadSchema = z.object({ request_id: facesId, expected_version: z.number().int().min(1).max(2147483646), model: facesModel.default('mbf'), jpeg_base64: z.string().min(4).max(6 * 1024 * 1024) }).strict();
export const facesHistoryQuerySchema = z.object({ scope: searchRangeSchema, model: facesModel.default('mbf'), space_id: facesPin.optional(), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(512).optional() }).strict();
export const facesSearchQuerySchema = z.object({ request_id: facesId, scope: searchRangeSchema, model: facesModel.default('mbf'), limit: z.number().int().min(1).max(50).default(20), jpeg_base64: z.string().min(4).max(6 * 1024 * 1024) }).strict();
export const facesRecordSchema = z.object({
  id: facesId, channel_id: facesId, processor_id: z.string().min(1).max(128), session_id: z.string().min(1).max(128), track_id: z.string().max(128),
  captured_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
  model: facesModel, space_id: facesPin, quality: facesQuality, photo_ref: facesId.nullable(),
  match: z.object({ state: z.enum(['candidate', 'unmatched', 'unavailable']), reason: z.string().max(200).nullable(), library_id: facesId.optional(), library_version: z.number().int().positive().optional(), member_id: facesId.optional(), similarity: z.number().min(-1).max(1).optional(), threshold: z.number().min(-1).max(1).optional(), accuracy_verified: z.literal(false).optional() }).strict(),
  similarity: z.number().finite().min(-1).max(1).optional(),
  recording_channel_id: facesId.nullable(),
}).strict();
export const facesPageSchema = z.object({ scope: searchRangeSchema, model: facesModel, space_id: facesPin.nullable(), items: z.array(facesRecordSchema).max(50), next_cursor: z.string().min(1).max(512).nullable(), coverage: z.enum(['unknown', 'partial', 'sampled']) }).strict();
export const facesSearchPageSchema = facesPageSchema.extend({ space_id: facesPin, query_id: facesId, quality: facesQuality }).strict();
export const facesVersion = z.number().int().min(1).max(2147483647);
export const facesReferenceQuerySchema = z.object({ record_id: facesId }).strict();
export const facesReferenceSchema = z.object({
  library_id: facesId, library_version: facesVersion, member_id: facesId,
  library_name: z.string(), member_name: z.string(), template_id: facesId, photo_ref: facesId,
  model: facesModel, space_id: facesPin, expires_at: z.string().datetime({ offset: true }),
  record_id: facesId, event_id: facesPin, occurred_at: z.string().datetime({ offset: true }),
}).strict();
export type FacesReference = z.infer<typeof facesReferenceSchema>;

export type FacesModel = z.infer<typeof facesModel>;
export type FacesDocument = z.infer<typeof facesDocumentSchema>;
export type FacesTemplate = z.infer<typeof facesTemplateSchema>;
export type FacesStatus = z.infer<typeof facesStatusSchema>;
export type FacesRecord = z.infer<typeof facesRecordSchema>;
export type FacesPage = z.infer<typeof facesPageSchema>;
export type FacesSearchPage = z.infer<typeof facesSearchPageSchema>;
export interface FacesLibrary { id: string; version: number; document: FacesDocument; templates: Record<string, FacesTemplate>; updated_at: string; deleted?: boolean }

export class FacesError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422, readonly current?: unknown) { super(message); }
}
export const facesUnavailable = () => new FacesError('faces_native_unavailable', '人脸提取与历史检索服务尚未就绪；配置和输入已保留。', 503);

/** Ownership contract:
 * Node FacesStore: PG configuration/CAS/idempotency, <=16 libraries/500 members.
 * Node FacesMongo/FacesRuntime: Mongo face-only binary vectors/captures, bounded
 * cosine ranking and expiring search references. Existing text space untouched.
 * Node FacesPhotos: selected SSD, immutable hash-checked photo refs; no eMMC.
 * Native ONLY GET /v1/faces/extractor/status, POST /v1/faces/extract:
 * raw image/jpeg <=4MiB at BFF, x-service-token, x-ainvr-face JSON
 * {request_id,model_space_hash,detector_sha256,jpeg_sha256,expires_ms<=30s}.
 * No client-supplied landmarks/model paths/vectors. Native returns internal
 * ainvr.face-extraction.v1; only extracted has 512 L2 embedding. Native quality
 * is geometry_only, not blur/occlusion/liveness/accuracy validation.
 * FacesNativeClient checks identity/digests/pin/norm. Embedding stays in Node/Mongo.
 * Public DTOs above never include vectors/JPEG blobs or absolute SSD paths.
 * Structured errors: 409 CAS/space, 410 expired, 422 quality, 429 capacity,
 * 503 extractor/storage unavailable. Unknown/expired != unmatched != stranger.
 */
