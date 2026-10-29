import { createHash } from 'node:crypto';
import { z } from 'zod';
import { searchRangeSchema } from './searchContract.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const generation = count.refine(value => value > 0);
const actor = z.string().min(1).max(64).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
// Mongo ordinals and PG BIGINT never pass through JS Number. Canonical decimal
// strings also give independently implemented workers one stable wire form.
export const searchMigrationOrdinalSchema = z.string().refine(value =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const searchMigrationModelSchema = z.object({
  package_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  package_sha256: hash,
  model_version: z.string().regex(/^search-v1-[a-f0-9]{64}$/),
}).strict();
export type SearchMigrationModel = z.infer<typeof searchMigrationModelSchema>;
/** Aggregate verified model-contract identity, not a tar/archive file hash.
 * Metadata verification does not load HBM or prove runtime/quality readiness. */
export const searchMigrationModelProfileSchema = searchMigrationModelSchema.extend({
  dimensions: z.number().int().min(1).max(4096),
  input_spec_version: z.string().min(1).max(512).regex(/^[\x20-\x7e]+$/),
  files_verified: z.boolean(), production_approval_declared: z.boolean(),
  pruned: z.boolean(), runtime_ready: z.literal(false),
}).strict().refine(value => value.package_sha256 === value.model_version.slice('search-v1-'.length),
  'migration_model_contract_identity');
export type SearchMigrationModelProfile = z.infer<typeof searchMigrationModelProfileSchema>;

/** Immutable search_jobs payload. The human actor remains the row owner;
 * purpose-specific internal workers do not become that human principal.
 * Preparing this payload does not modify desired/applied model configuration. */
export const searchModelMigrationPayloadSchema = z.object({
  schema_version: z.literal('search-reencode-v1'), purpose: z.literal('reencode'),
  source: searchMigrationModelSchema, target: searchMigrationModelSchema,
  scope: searchRangeSchema, config_revision: hash, storage_generation: hash,
  source_high_watermark: searchMigrationOrdinalSchema,
  source_after_watermark:searchMigrationOrdinalSchema.optional(),
  plan_switch_generation:generation.optional(),plan_id:uuid.optional(),plan_round:z.union([z.literal(0),z.literal(1)]).optional(),partition_index:z.number().int().min(0).max(131).optional(),
  batch_size: z.number().int().min(1).max(32),
  acceptance_criteria_sha256: hash,
}).strict().superRefine((value, ctx) => {
  if (value.source.model_version === value.target.model_version)
    ctx.addIssue({ code: 'custom', message: 'migration_requires_new_feature_space' });
  const low=searchMigrationOrdinalSchema.safeParse(value.source_after_watermark??'0'),high=searchMigrationOrdinalSchema.safeParse(value.source_high_watermark);
  if((value.plan_switch_generation!==undefined&&(value.plan_round!==1||!value.plan_id))||(value.plan_id!==undefined)!==(value.plan_round!==undefined)||(value.plan_id!==undefined)!==(value.partition_index!==undefined)||
    (low.success&&high.success&&BigInt(low.data)>BigInt(high.data)))
    ctx.addIssue({code:'custom',message:'invalid_migration_plan_child'});
});
export type SearchModelMigrationPayload = z.infer<typeof searchModelMigrationPayloadSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const modelParts = (model: SearchMigrationModel) => [model.package_id, model.package_sha256, model.model_version];
export function searchModelMigrationFingerprint(input: SearchModelMigrationPayload): string {
  const value = searchModelMigrationPayloadSchema.parse(input);
  return digest(['ainvr-search-model-migration-v1', modelParts(value.source), modelParts(value.target),
    [...value.scope.channel_ids].sort(), Date.parse(value.scope.from), Date.parse(value.scope.to),
    value.config_revision, value.storage_generation, value.source_high_watermark, value.batch_size,
    value.acceptance_criteria_sha256,...(value.source_after_watermark!==undefined||value.plan_id!==undefined?
      [value.source_after_watermark??'0',value.plan_id??null,value.plan_round??null,value.partition_index??null]:[]),...(value.plan_switch_generation!==undefined?[value.plan_switch_generation]:[])]);
}

/** PG stores only bounded progress and artifact digests; no JPEG/vector, URL,
 * credentials, filesystem paths or inference payload enter the parameter DB. */
export const searchModelMigrationProgressSchema = z.object({
  schema_version: z.literal('search-reencode-progress-v1'), payload_fingerprint: hash,
  phase: z.enum(['encoding', 'building_index', 'awaiting_acceptance', 'ready', 'activated']),
  cursor: z.object({ ordinal: searchMigrationOrdinalSchema, sample_id: uuid }).strict().nullable(),
  scanned: count, encoded: count, unavailable: count,
  source_completed_through: searchMigrationOrdinalSchema.nullable(),
  target_checkpoint: searchMigrationOrdinalSchema.nullable(),
  coverage_snapshot:z.object({required:count,matched:count,unavailable:count}).strict().optional(),
  coverage_sha256: hash.nullable(), index_manifest_sha256: hash.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.encoded > value.scanned || value.unavailable !== value.scanned - value.encoded)
    ctx.addIssue({ code: 'custom', message: 'migration_progress_inconsistent' });
  if(value.coverage_snapshot&&value.coverage_snapshot.required-value.coverage_snapshot.matched!==value.coverage_snapshot.unavailable)
    ctx.addIssue({code:'custom',message:'migration_live_coverage_inconsistent'});
  if (['awaiting_acceptance', 'ready', 'activated'].includes(value.phase) &&
      (!value.coverage_sha256 || !value.index_manifest_sha256 || value.source_completed_through === null || value.target_checkpoint === null))
    ctx.addIssue({ code: 'custom', message: 'migration_artifacts_incomplete' });
});
export type SearchModelMigrationProgress = z.infer<typeof searchModelMigrationProgressSchema>;

/** This is an explicit administrator acceptance of a frozen report and criteria,
 * not a claim that model scores are calibrated. The server supplies accepted_by
 * from the authenticated principal and persists this proof plus its audit entry
 * in one PG transaction. It must never accept an actor copied from the browser. */
export const searchModelMigrationAcceptanceSchema = z.object({
  schema_version: z.literal('search-reencode-acceptance-v1'),
  mode: z.literal('administrator_report_acceptance'),
  job_id: uuid, generation, payload_fingerprint: hash,
  criteria_sha256: hash, report_sha256: hash,
  source_completed_through: searchMigrationOrdinalSchema, target_checkpoint: searchMigrationOrdinalSchema,
  coverage_sha256: hash, index_manifest_sha256: hash,
  accepted_by: actor, accepted_at: z.string().datetime({ offset: true }),
}).strict();
export type SearchModelMigrationAcceptance = z.infer<typeof searchModelMigrationAcceptanceSchema>;

export const searchModelMigrationLeaseSchema = z.object({
  job_id: uuid, worker: uuid, generation,
  expires_at: z.string().datetime({ offset: true }),
  payload: searchModelMigrationPayloadSchema,
  payload_fingerprint: hash,
}).strict().superRefine((value, ctx) => {
  const payload = searchModelMigrationPayloadSchema.safeParse(value.payload);
  if (payload.success && searchModelMigrationFingerprint(payload.data) !== value.payload_fingerprint)
    ctx.addIssue({ code: 'custom', message: 'migration_lease_identity_mismatch' });
});
export type SearchModelMigrationLease = z.infer<typeof searchModelMigrationLeaseSchema>;
export const searchMigrationWriteProofSchema=z.object({job_id:uuid,worker:uuid,generation,actor,payload_fingerprint:hash}).strict();
export type SearchMigrationWriteProof=z.infer<typeof searchMigrationWriteProofSchema>;
export const searchMigrationWriteSourceSchema = z.object({sample_id:uuid,fingerprint:hash,channel_id:uuid,
  captured_ms:count,ordinal:searchMigrationOrdinalSchema.refine(value=>BigInt(value)>0),jpeg_sha256:hash}).strict();
export type SearchMigrationWriteSource = z.infer<typeof searchMigrationWriteSourceSchema>;
export interface SearchMigrationWriteGrant {job_id:string;worker:string;generation:number;payload_fingerprint:string;
  source:SearchMigrationModel;target:SearchMigrationModel;scope:{channel_ids:string[];from_ms:number;to_ms:number};
  source_high_watermark:string;lease_until_ms:number;job_expires_ms:number;target_checkpoint:string}
export interface SearchMigrationReportReadGrant {mode:'report_read';job_id:string;generation:number;actor:string;payload_fingerprint:string;
  source:SearchMigrationModel;target:SearchMigrationModel;scope:{channel_ids:string[];from_ms:number;to_ms:number};source_high_watermark:string;job_expires_ms:number;target_checkpoint:string}

/** Validate a checkpoint before the SQL lease/generation CAS. The checkpoint is
 * an entire acknowledged batch, never an optimistic pre-write cursor. */
export function validateSearchMigrationCheckpoint(payload: SearchModelMigrationPayload,
  previous: SearchModelMigrationProgress, next: SearchModelMigrationProgress): SearchModelMigrationProgress {
  const spec = searchModelMigrationPayloadSchema.parse(payload);
  const before = searchModelMigrationProgressSchema.parse(previous), after = searchModelMigrationProgressSchema.parse(next);
  const fingerprint = searchModelMigrationFingerprint(spec);
  if (before.payload_fingerprint !== fingerprint || after.payload_fingerprint !== fingerprint)
    throw new Error('migration_progress_identity_mismatch');
  const phases = ['encoding', 'building_index', 'awaiting_acceptance', 'ready', 'activated'];
  if (phases.indexOf(after.phase) < phases.indexOf(before.phase) ||
      after.scanned < before.scanned || after.encoded < before.encoded || after.unavailable < before.unavailable ||
      after.scanned - before.scanned > spec.batch_size)
    throw new Error('migration_progress_not_monotonic');
  if (after.cursor && BigInt(after.cursor.ordinal) > BigInt(spec.source_high_watermark))
    throw new Error('migration_cursor_out_of_scope');
  if(after.cursor&&BigInt(after.cursor.ordinal)<=BigInt(spec.source_after_watermark??'0'))throw new Error('migration_cursor_out_of_scope');
  if (before.cursor && (!after.cursor || BigInt(after.cursor.ordinal) < BigInt(before.cursor.ordinal) ||
      (after.cursor.ordinal === before.cursor.ordinal && after.cursor.sample_id < before.cursor.sample_id)))
    throw new Error('migration_cursor_not_monotonic');
  if ((after.scanned > before.scanned && !after.cursor) ||
      (before.cursor && after.scanned > before.scanned && after.cursor?.ordinal === before.cursor.ordinal &&
        after.cursor.sample_id === before.cursor.sample_id) ||
      (after.scanned === before.scanned && JSON.stringify(after.cursor) !== JSON.stringify(before.cursor)))
    throw new Error('migration_cursor_not_advanced');
  if (['ready', 'activated'].includes(before.phase) &&
      (after.coverage_sha256 !== before.coverage_sha256 || after.index_manifest_sha256 !== before.index_manifest_sha256 ||
        JSON.stringify(after.coverage_snapshot)!==JSON.stringify(before.coverage_snapshot)||
        after.source_completed_through !== before.source_completed_through || after.target_checkpoint !== before.target_checkpoint ||
        after.scanned !== before.scanned || after.encoded !== before.encoded || after.unavailable !== before.unavailable))
    throw new Error('migration_accepted_artifacts_changed');
  if (after.source_completed_through !== null && after.source_completed_through !== spec.source_high_watermark)
    throw new Error('migration_watermark_incomplete');
  if ((before.source_completed_through !== null && after.source_completed_through !== before.source_completed_through) ||
      (before.target_checkpoint !== null && (after.target_checkpoint === null || BigInt(after.target_checkpoint) < BigInt(before.target_checkpoint))))
    throw new Error('migration_watermark_not_monotonic');
  return after;
}

/** Pure preflight only: activation still requires authoritative PG job/shard
 * rows and current config to be locked/rechecked in the publication transaction.
 * A client's status response is never sufficient authority to switch models. */
export function assertSearchMigrationActivation(input: {
  job_id: string; generation: number; state: string; payload: SearchModelMigrationPayload;
  progress: SearchModelMigrationProgress; acceptance: SearchModelMigrationAcceptance;
  current: { config_revision: string; storage_generation: string; source: SearchMigrationModel };
}): void {
  uuid.parse(input.job_id); generation.parse(input.generation);
  const payload = searchModelMigrationPayloadSchema.parse(input.payload);
  const progress = searchModelMigrationProgressSchema.parse(input.progress);
  const proof = searchModelMigrationAcceptanceSchema.parse(input.acceptance);
  const current = z.object({ config_revision: hash, storage_generation: hash, source: searchMigrationModelSchema }).strict().parse(input.current);
  const fingerprint = searchModelMigrationFingerprint(payload);
  if (input.state !== 'succeeded' || progress.phase !== 'ready' ||
      progress.payload_fingerprint !== fingerprint || proof.job_id !== input.job_id || proof.generation !== input.generation ||
      proof.payload_fingerprint !== fingerprint || proof.criteria_sha256 !== payload.acceptance_criteria_sha256 ||
      proof.source_completed_through !== payload.source_high_watermark || proof.source_completed_through !== progress.source_completed_through ||
      proof.target_checkpoint !== progress.target_checkpoint ||
      proof.coverage_sha256 !== progress.coverage_sha256 || proof.index_manifest_sha256 !== progress.index_manifest_sha256)
    throw new Error('migration_not_accepted');
  if (current.config_revision !== payload.config_revision || current.storage_generation !== payload.storage_generation ||
      JSON.stringify(modelParts(current.source)) !== JSON.stringify(modelParts(payload.source)))
    throw new Error('migration_source_changed');
}
