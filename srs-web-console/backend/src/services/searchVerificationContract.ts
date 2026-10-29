import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SearchScope } from './searchContract.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const actor = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const request = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const safeText = z.string().min(1).max(128).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const searchVerificationProfileSchema = z.object({
  task_id: z.literal('search-verify-zh-v1'), template_sha256: hash, preprocessing_version: safeText,
  decision_policy: z.literal('abc-visible-v1'), model_package_id: safeText, model_package_sha256: hash, profile_fp: hash,
}).strict();
export type SearchVerificationProfile = z.infer<typeof searchVerificationProfileSchema>;
export function searchVerificationProfileFingerprint(profile: Omit<SearchVerificationProfile, 'profile_fp'>): string {
  return createHash('sha256').update(JSON.stringify([profile.task_id, profile.template_sha256,
    profile.preprocessing_version, profile.decision_policy, profile.model_package_id, profile.model_package_sha256]), 'utf8').digest('hex');
}
export function validateSearchVerificationProfile(value: unknown): SearchVerificationProfile {
  const profile = searchVerificationProfileSchema.parse(value);
  if (profile.profile_fp !== searchVerificationProfileFingerprint(profile)) throw new Error('invalid_verification_profile');
  return profile;
}
export const searchVerificationTargetSchema = z.object({ search_id: uuid, actor, version: hash, sample_id: uuid }).strict();
export type SearchVerificationTarget = z.infer<typeof searchVerificationTargetSchema>;
export const searchVerificationBindingSchema = searchVerificationTargetSchema.extend({
  frame_id: uuid, fingerprint: hash, query_sha256: hash, jpeg_sha256: hash, profile_fp: hash,
  question_scope: z.enum(['visible', 'temporal']),
}).strict();
export type SearchVerificationBinding = z.infer<typeof searchVerificationBindingSchema>;
export const searchVerificationViewSchema = z.object({
  state: z.enum(['queued', 'running', 'match', 'mismatch', 'uncertain', 'unavailable']),
  profile_fp: hash, request_id: request.nullable(), cached: z.boolean(), reason: safeText.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === 'queued' && (value.request_id !== null || value.cached)) ||
      (value.state === 'running' && (!value.request_id || value.cached)) ||
      (value.cached && (!value.request_id || ['queued', 'running', 'unavailable'].includes(value.state))))
    ctx.addIssue({ code: 'custom', message: 'invalid_verification_state' });
});
export type SearchVerificationView = z.infer<typeof searchVerificationViewSchema>;
const attemptSchema = z.object({ job_id: uuid, generation: integer.min(1), request_id: request }).strict();
export type SearchVerificationAttempt = z.infer<typeof attemptSchema>;
export const searchVerificationCursorSchema = z.object({ created_ms: integer, key: hash }).strict();
export type SearchVerificationCursor = z.infer<typeof searchVerificationCursorSchema>;
export const searchVerificationScanSchema = z.object({
  refs: z.array(searchVerificationTargetSchema).max(5), cleanup_refs: z.array(searchVerificationTargetSchema).max(5), next_cursor: searchVerificationCursorSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const refs = [...value.refs, ...value.cleanup_refs], first = refs[0];
  if ((value.refs.length > 0 && value.cleanup_refs.length > 0) || new Set(refs.map(ref => ref.sample_id)).size !== refs.length ||
      refs.some(ref => ref.search_id !== first?.search_id || ref.actor !== first?.actor || ref.version !== first?.version))
    ctx.addIssue({ code: 'custom', message: 'invalid_verification_scan' });
});
export type SearchVerificationScan = z.infer<typeof searchVerificationScanSchema>;
const nativeScope = z.object({ channel_ids: z.array(uuid).min(1).max(100), from_ms: integer, to_ms: integer }).strict();
export const searchVerificationInspectionSchema = z.object({
  status: z.enum(['pending', 'cached', 'final', 'unavailable', 'profile_superseded', 'cancelled', 'submitted']), binding: searchVerificationBindingSchema.nullable(),
  query: z.string().min(1).max(1024).nullable(), kind: z.enum(['object', 'scene']).nullable(),
  scope: nativeScope.nullable(), expires_ms: integer.nullable(), verification: searchVerificationViewSchema.nullable(),
  submitted: attemptSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const hasBinding = value.binding !== null;
  if (value.status === 'cancelled') {
    if ([value.query, value.kind, value.scope, value.expires_ms].some(part => part !== null) ||
        (hasBinding ? !value.submitted || value.verification?.state !== 'running' : value.submitted !== null || value.verification !== null))
      ctx.addIssue({ code: 'custom', message: 'invalid_verification_cancellation' });
    return;
  }
  if (value.status === 'profile_superseded' || value.status === 'submitted') {
    if (!hasBinding || !value.submitted || value.verification?.state !== 'running' ||
        [value.query, value.kind, value.scope, value.expires_ms].some(part => part !== null))
      ctx.addIssue({ code: 'custom', message: 'invalid_verification_supersession' });
    return;
  }
  if ((!hasBinding && value.status !== 'unavailable') ||
      [value.query, value.kind, value.scope, value.expires_ms].some(part => (part !== null) !== hasBinding) ||
      (value.status === 'cached' && !value.verification?.cached) ||
      (['cached', 'final'].includes(value.status) && (!value.verification || ['queued', 'running'].includes(value.verification.state))))
    ctx.addIssue({ code: 'custom', message: 'invalid_verification_inspection' });
});
export type SearchVerificationInspection = Omit<z.infer<typeof searchVerificationInspectionSchema>, 'scope'> & { scope: SearchScope | null };
export const searchVerificationMutationSchema = z.object({
  stored: z.boolean(), status: z.enum(['queued', 'submit', 'already_submitted', 'final', 'stale']),
  verification: searchVerificationViewSchema.nullable(), submitted: attemptSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.stored && ['stale', 'already_submitted'].includes(value.status)) ||
      (value.status === 'submit' && (!value.stored || value.verification?.state !== 'running' || !value.submitted)) ||
      (value.status === 'queued' && (!value.stored || value.verification?.state !== 'queued')) ||
      (value.status === 'already_submitted' && !value.submitted) ||
      (value.status === 'final' && (!value.verification || ['queued', 'running'].includes(value.verification.state))))
    ctx.addIssue({ code: 'custom', message: 'invalid_verification_mutation' });
});
export type SearchVerificationMutation = z.infer<typeof searchVerificationMutationSchema>;
const triple = z.object({ A: z.number().finite(), B: z.number().finite(), C: z.number().finite() }).strict();
export const searchVerificationResultSchema = z.object({
  schema: z.literal('ainvr.search_verification.v1'), request_id: request, frame_id: uuid,
  evidence_sha256: hash, query_sha256: hash, input_sha256: hash, question_scope: z.enum(['visible', 'temporal']), kind: z.enum(['object', 'scene']),
  template: z.literal('search-verify-zh-v1'), template_sha256: hash, preprocessing_version: safeText,
  model: z.object({ package_id: safeText, package_sha256: hash }).strict(), validated: z.literal(false),
  decision_policy: z.literal('abc-visible-v1'), score_kind: z.literal('three_way_softmax_uncalibrated'),
  decision: z.enum(['match', 'mismatch', 'uncertain']),
  reason: z.enum(['visible_evidence', 'ambiguous_evidence', 'insufficient_evidence', 'temporal_evidence_required']),
  logits: triple.nullable(), reference_scores: triple.nullable(),
  timing_ms: z.object({ queue: z.number().finite().min(0).max(10000000), preprocess: z.number().finite().min(0).max(10000000), total: z.number().finite().min(0).max(10000000) }).strict(),
}).strict().superRefine((value, ctx) => {
  if ((value.decision !== 'uncertain' && value.reason !== 'visible_evidence') ||
      (value.question_scope === 'temporal' && (value.decision !== 'uncertain' || value.reason !== 'temporal_evidence_required' || value.logits !== null || value.reference_scores !== null)) ||
      (value.question_scope === 'visible' && (!value.logits || !value.reference_scores ||
        Object.values(value.logits).some(n => Math.abs(n) > 1e9) || Object.values(value.reference_scores).some(n => n < 0 || n > 1) ||
        Math.abs(Object.values(value.reference_scores).reduce((sum, n) => sum + n, 0) - 1) > 1e-6)))
    ctx.addIssue({ code: 'custom', message: 'invalid_verification_result' });
});
export type SearchVerificationResult = z.infer<typeof searchVerificationResultSchema>;
export const searchVerificationAbortReasonSchema = z.enum(['cancelled', 'request_timeout', 'model_unavailable', 'evidence_unavailable',
  'profile_changed', 'already_submitted', 'job_expired', 'scope_denied', 'input_too_long', 'inference_failed', 'search_busy', 'invalid_result', 'task_unavailable']);
export type SearchVerificationAbortReason = z.infer<typeof searchVerificationAbortReasonSchema>;
