import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PullModeAdapter, type ValidateResult } from './adapter.js';
import type { ConfigDocument } from './pgStore.js';

const key = z.string().refine(value => /^\$\{secret:search-service\/[a-zA-Z0-9_.\/-]+\}$/.test(value) ||
  (value.length >= 32 && value.length <= 512 && !value.startsWith('${secret:') && !/[\r\n]/.test(value)), '需要搜索服务专用密钥');
const relativePath = z.string().min(1).max(512).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value) &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '目录必须位于选定外置磁盘内');

export const searchSettingsSchema = z.object({
  schema_version: z.literal('1.0'),
  enabled: z.boolean(),
  listen: z.object({ host: z.literal('127.0.0.1'), port: z.literal(8400) }).strict(),
  callers: z.array(z.object({ name: z.enum(['console', 'producer']), scope: z.enum(['console', 'producer']), key }).strict()).max(2),
  history: z.object({ source: z.literal('ai-history') }).strict(),
  index_storage: z.object({ volume_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).nullable(), relative_path: relativePath }).strict(),
  model: z.object({ package_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).nullable() }).strict(),
  sampling: z.object({
    mode: z.enum(['all', 'selected']), channel_ids: z.array(z.string().uuid()).max(100),
    object: z.boolean(), scene: z.boolean(),
    object_interval_ms: z.number().int().min(250).max(60000),
    scene_active_interval_ms: z.number().int().min(1000).max(300000),
    scene_static_interval_ms: z.number().int().min(1000).max(3600000),
    scene_change_min_interval_ms: z.number().int().min(1000).max(300000),
    track_slots: z.literal(8),
  }).strict(),
  limits: z.object({
    query_concurrency: z.number().int().min(1).max(8),
    http_workers: z.number().int().min(1).max(8), http_queue: z.number().int().min(1).max(32),
    producer_queue: z.number().int().min(1).max(4), producer_bytes: z.number().int().min(8388608).max(268435456),
    max_samples: z.number().int().min(100).max(1000000), max_bytes: z.number().int().min(134217728).max(1099511627776),
    retention_days: z.number().int().min(1).max(365), max_coverage: z.number().int().min(100).max(1000000),
    max_searches: z.number().int().min(1).max(10000), search_ttl_s: z.number().int().min(60).max(86400),
    image_max_bytes: z.number().int().min(65536).max(8388608),
  }).strict(),
}).strict().superRefine((settings, ctx) => {
  if (settings.callers.length && (settings.callers.length !== 2 ||
    new Set(settings.callers.map(caller => caller.name)).size !== 2 ||
    settings.callers.some(caller => caller.name !== caller.scope) ||
    settings.callers[0]?.key === settings.callers[1]?.key))
    ctx.addIssue({ code: 'custom', message: '控制台和采集端必须使用不同的专用密钥与权限' });
  const ids = settings.sampling.channel_ids;
  if (new Set(ids).size !== ids.length || (settings.sampling.mode === 'selected' ? !ids.length : !!ids.length))
    ctx.addIssue({ code: 'custom', message: '指定通道不得为空或重复；全部通道模式不保存通道列表' });
  if (!settings.sampling.object && !settings.sampling.scene)
    ctx.addIssue({ code: 'custom', message: '至少选择对象或场景采集' });
  if (settings.sampling.scene_static_interval_ms < settings.sampling.scene_active_interval_ms ||
      settings.sampling.scene_change_min_interval_ms > settings.sampling.scene_active_interval_ms)
    ctx.addIssue({ code: 'custom', message: '场景采样间隔不一致' });
  if (settings.enabled && (!settings.callers.length || !settings.model.package_id || !settings.index_storage.volume_id))
    ctx.addIssue({ code: 'custom', message: '启用前请选择模型包、外置存储并配置独立调用身份' });
});
export type SearchSettings = z.infer<typeof searchSettingsSchema>;
export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  schema_version: '1.0', enabled: false, listen: { host: '127.0.0.1', port: 8400 }, callers: [],
  history: { source: 'ai-history' }, index_storage: { volume_id: null, relative_path: 'ainvr/search-index' },
  model: { package_id: 'siglip2-base-full-int8' }, sampling: { mode: 'all', channel_ids: [], object: true, scene: true,
    object_interval_ms: 1000, scene_active_interval_ms: 10000, scene_static_interval_ms: 60000,
    scene_change_min_interval_ms: 3000, track_slots: 8 },
  limits: { query_concurrency: 2, http_workers: 4, http_queue: 4, producer_queue: 1, producer_bytes: 134217728,
    max_samples: 100000, max_bytes: 1073741824, retention_days: 30, max_coverage: 100000,
    max_searches: 1000, search_ttl_s: 3600, image_max_bytes: 8388608 },
};

/** Browser forms never provision caller credentials. Repeated saves retain the
 * original references; only the first explicit save generates two unique keys. */
export function prepareSearchSettings(config: Record<string, unknown>, previous?: Record<string, unknown>): SearchSettings {
  const old = searchSettingsSchema.safeParse(previous);
  const callers = old.success && old.data.callers.length === 2 ? old.data.callers :
    (['console', 'producer'] as const).map(name => ({ name, scope: name, key: randomBytes(32).toString('hex') }));
  return searchSettingsSchema.parse({ ...config, callers });
}

export class SearchConfigAdapter extends PullModeAdapter {
  constructor() { super('search-service'); }
  override async validate(docs: ConfigDocument[]): Promise<ValidateResult> {
    const doc = docs.length === 1 && docs[0]?.group === 'system' && docs[0]?.name === 'settings' ? docs[0] : null;
    return doc && searchSettingsSchema.safeParse(doc.config).success ? { ok: true, errors: [] } :
      { ok: false, errors: ['搜索服务配置无效：检查模型、外置存储、通道、调用权限和资源限制'] };
  }
}
