import { z } from 'zod';

export const searchRangeSchema = z.object({
  channel_ids: z.array(z.string().uuid()).min(1).max(100),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  if (duration <= 0 || duration > 31 * 86400000)
    ctx.addIssue({ code: 'custom', message: '请选择不超过 31 天的有效时间范围' });
  if (new Set(value.channel_ids).size !== value.channel_ids.length)
    ctx.addIssue({ code: 'custom', message: '通道不能重复' });
});
export const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(256).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v), '描述包含无效字符'),
  scope: searchRangeSchema,
  verify: z.boolean().default(false),
  request_id: z.string().uuid(),
}).strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchScope = z.infer<typeof searchRangeSchema>;
export function sameSearchScope(left: SearchScope, right: SearchScope): boolean {
  return Date.parse(left.from) === Date.parse(right.from) && Date.parse(left.to) === Date.parse(right.to) &&
    [...left.channel_ids].sort().join() === [...right.channel_ids].sort().join();
}
export interface SearchStatus {
  ready: boolean;
  reason: 'disabled' | 'config_pending' | 'model_pending' | 'service_unavailable' | 'storage_unavailable' | null;
  model_version: string | null;
}
export const searchCoverageSchema = z.object({
  state: z.enum(['unknown', 'partial', 'sampled']), scope: searchRangeSchema,
  ranges: z.array(z.object({
    channel_id: z.string().uuid(), from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
    kind: z.enum(['object', 'scene']), state: z.enum(['sampled', 'pending', 'gap']),
  }).strict()).max(10000),
}).strict().superRefine((value, ctx) => {
  const from = Date.parse(value.scope.from), to = Date.parse(value.scope.to);
  if (value.ranges.some(r => !value.scope.channel_ids.includes(r.channel_id) || Date.parse(r.from) < from || Date.parse(r.to) > to || Date.parse(r.to) <= Date.parse(r.from)) ||
    (value.state === 'sampled' && !value.ranges.length))
    ctx.addIssue({ code: 'custom', message: 'invalid_search_coverage' });
});
export type SearchCoverage = z.infer<typeof searchCoverageSchema>;
const timestamp = z.string().datetime({ offset: true });
export const searchBoundingBoxSchema = z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().positive().max(1), z.number().finite().positive().max(1)])
  .refine(([x, y, w, h]) => x + w <= 1.000001 && y + h <= 1.000001, 'invalid_search_bbox');
export const searchFrameSchema = z.object({
  id: z.string().uuid(),
  captured_at: timestamp,
  role: z.enum(['match', 'before', 'after', 'context']),
  bbox: searchBoundingBoxSchema.optional(),
}).strict();
export const searchResultSchema = z.object({
  id: z.string().uuid(), channel_id: z.string().uuid(), channel_name: z.string().min(1).max(256),
  source_input_id: z.string().uuid(), processor_id: z.string().min(1).max(128).nullable(),
  output_channel_id: z.string().uuid().nullable(),
  kind: z.enum(['object', 'scene']),
  started_at: timestamp, ended_at: timestamp,
  frames: z.array(searchFrameSchema).min(1).max(3),
  recording: z.object({ channel_id: z.string().uuid().nullable(), state: z.enum(['available', 'missing', 'pending']) }).strict(),
  verification: z.object({ state: z.enum(['candidate', 'queued', 'running', 'match', 'mismatch', 'uncertain', 'unavailable']),
    validated: z.literal(false).optional(), cached: z.boolean().optional(), reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().optional() }).strict(),
  feedback: z.enum(['relevant', 'irrelevant']).nullable(),
}).strict().superRefine((result, ctx) => {
  const from = Date.parse(result.started_at), to = Date.parse(result.ended_at);
  if (to < from || result.frames.some(f => Date.parse(f.captured_at) < from || Date.parse(f.captured_at) > to)
    || new Set(result.frames.map(f => f.id)).size !== result.frames.length)
    ctx.addIssue({ code: 'custom', message: 'invalid_result_evidence' });
  if (!result.frames.some(f => f.role === 'match')) ctx.addIssue({ code: 'custom', message: 'missing_match_frame' });
  if (result.recording.state === 'available' && !result.recording.channel_id)
    ctx.addIssue({ code: 'custom', message: 'missing_recording_identity' });
});
export type SearchResult = z.infer<typeof searchResultSchema>;
export const searchPageSchema = z.object({
  search_id: z.string().uuid(), scope: searchRangeSchema,
  model_version: z.string().min(1).max(128),
  coverage: z.enum(['unknown', 'partial', 'sampled']),
  items: z.array(searchResultSchema).max(60),
  next_cursor: z.string().min(1).max(512).nullable(),
}).strict();
export type SearchPage = z.infer<typeof searchPageSchema>;
export const searchDetailSchema = z.object({ search_id: z.string().uuid(), scope: searchRangeSchema, item: searchResultSchema }).strict();
// This port has no in-memory production implementation. A worker must supply
// real model readiness, persisted coverage and results before search is enabled.
export interface SearchWorker {
  status(): Promise<SearchStatus>;
  coverage(scope: SearchScope, actor: string): Promise<SearchCoverage>;
  query(input: SearchQuery, actor: string): Promise<SearchPage>;
  page(id: string, cursor: string | undefined, actor: string): Promise<SearchPage | null>;
  result(id: string, resultId: string, actor: string): Promise<z.infer<typeof searchDetailSchema> | null>;
  image(id: string, resultId: string, frameId: string, actor: string): Promise<Buffer | null>;
  feedback(id: string, resultId: string, relevant: boolean, actor: string): Promise<void>;
  cancel(id: string, actor: string): Promise<void>;
}
