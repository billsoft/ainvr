import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readAppliedSearchConfiguration, readEffectiveSearchConfiguration, SearchConfigurationError, type SearchRuntimeDependencies } from '../services/searchConnection.js';
import { SearchModelPinError, type SearchRuntimeStore } from '../store/searchRuntimeStore.js';
import { searchMigrationModelSchema } from '../services/searchModelMigrationContract.js';
import { endpoint, limitedJson, type InternalServiceConnection } from '../services/internalServiceHttp.js';
import type { SearchSettings } from '../store/searchConfigAdapter.js';
import type { SearchSource } from '../services/searchSourceCatalog.js';

const safeCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const stateSchema = z.object({ desired_version: z.number().int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['applied', 'failed']), error_code: safeCode.optional(),
  active_model: searchMigrationModelSchema.nullable().optional(),
}).strict().refine(state => state.status === 'failed' || state.error_code === undefined);
export const searchModelsSchema = z.object({ items: z.array(z.object({
  package_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), display_name: z.string().min(1).max(256),
  ready: z.boolean(), reason: safeCode.nullable(), model_version: z.string().min(1).max(128).nullable(),
  dimensions: z.number().int().positive().max(65536).nullable(),
}).strict()).max(128), service_ready: z.boolean(), reason: z.literal('service_unavailable').nullable() }).strict();
export type SearchModels = z.infer<typeof searchModelsSchema>;
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const searchCapacitySchema = z.object({ samples: safeCount, bytes: safeCount, max_samples: safeCount, max_bytes: safeCount,
  retention_days: safeCount, coverage: safeCount, max_coverage: safeCount,
  // Rolling retention (optional so an older search service still parses).
  evicted_samples: safeCount.optional(), evicted_bytes: safeCount.optional(), eviction_runs: safeCount.optional(),
  rolling_min_age_ms: safeCount.optional(), oldest_retained_captured_ms: safeCount.nullable().optional() }).strict();

export interface SearchProducerConfiguration {
  enabled: boolean; reason: 'disabled' | 'config_pending' | null;
  endpoint: string | null; api_token: string | null; revision: string | null;
  model: { package_id: string | null; expected_model_version?: string; expected_package_sha256?: string }; sampling: SearchSettings['sampling'] | null; sources: SearchSource[];
  valid_for_ms: 0 | 30000;
  limits: Pick<SearchSettings['limits'], 'producer_queue' | 'producer_bytes' | 'image_max_bytes' | 'retention_days'> | null;
}
interface Options {
  internalPrincipal: (request: FastifyRequest) => Promise<boolean>;
  producerPrincipal: (request: FastifyRequest) => Promise<boolean>;
  principal: (request: FastifyRequest) => Promise<string | null>;
  dependencies: SearchRuntimeDependencies | null;
  runtime: Pick<SearchRuntimeStore, 'acknowledge' | 'read'> | null;
  managementConnection: () => Promise<InternalServiceConnection | null>;
  fetchImpl?: typeof fetch;
}

export async function searchRuntimeRoutes(app: FastifyInstance, options: Options) {
  // Device-wide usage belongs to the existing configuration namespace. A
  // search-user identity or a producer/service token is never sufficient.
  app.get('/v1/config/search-capacity', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const administrator = async () => ['console-administrator', 'console-local'].includes(await options.principal(request) ?? '');
    if (!await administrator()) return reply.code(403).send({ error: { code: 'forbidden', message: '需要系统配置管理权限' } });
    try {
      const config = await options.managementConnection();
      if (!config) throw Error('unavailable');
      const response = await (options.fetchImpl ?? fetch)(endpoint(config, '/v1/capacity'), { redirect: 'error',
        signal: AbortSignal.timeout(Math.min(3000, config.timeoutMs)), headers: { 'x-service-token': config.apiToken } });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); throw Error('unavailable');
      }
      const data = searchCapacitySchema.parse(await limitedJson(response));
      if (!await administrator()) return reply.code(403).send({ error: { code: 'forbidden', message: '系统配置管理权限已变化' } });
      return data;
    } catch { return reply.code(503).send({ error: { code: 'search_capacity_unavailable', message: '容量状态暂不可用' } }); }
  });

  app.get('/internal/search/producer-config', async (request, reply): Promise<SearchProducerConfiguration | unknown> => {
    reply.header('cache-control', 'no-store');
    if (!await options.producerPrincipal(request)) return reply.code(403).send({ error: 'forbidden' });
    const inactive = (reason: 'disabled' | 'config_pending'): SearchProducerConfiguration => ({ enabled: false, reason,
      endpoint: null, api_token: null, revision: null, model: { package_id: null }, sampling: null, sources: [],
      valid_for_ms: 0, limits: null });
    if (!options.dependencies || !options.runtime) return inactive('config_pending');
    try {
      const effective = await readAppliedSearchConfiguration(options.dependencies, options.runtime);
      if (!effective) return inactive('config_pending');
      if (!effective.settings.enabled) return inactive('disabled');
      if(effective.ingestion_gate?.paused)return inactive('config_pending');
      // The desired target must not start producing until its real Ready ACK
      // advances the pin. Optional fields preserve old wire/test compatibility.
      if(Object.hasOwn(effective,'active_model_pin') && (!effective.active_model_pin || effective.approved_model_transition ||
        effective.active_model_pin.package_id!==effective.settings.model.package_id)) return inactive('config_pending');
      const caller = effective.settings.callers.find(value => value.name === 'producer' && value.scope === 'producer');
      if (!caller) return inactive('config_pending');
      return { enabled: true, reason: null, endpoint: `http://127.0.0.1:${effective.settings.listen.port}`,
        api_token: caller.key, revision: effective.revision, model: { package_id: effective.settings.model.package_id,
          ...(effective.active_model_pin ? {expected_model_version:effective.active_model_pin.model_version,
            expected_package_sha256:effective.active_model_pin.package_sha256}: {}) },
        sampling: effective.settings.sampling, sources: effective.sources, valid_for_ms: 30000,
        limits: { producer_queue: effective.settings.limits.producer_queue, producer_bytes: effective.settings.limits.producer_bytes,
          image_max_bytes: effective.settings.limits.image_max_bytes, retention_days: effective.settings.limits.retention_days } };
    } catch { return inactive('config_pending'); }
  });
  app.get('/internal/search/runtime-config', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: 'forbidden' });
    if (!options.dependencies) return reply.code(503).send({ error: 'config_pending' });
    try { return await readEffectiveSearchConfiguration(options.dependencies); }
    catch (error) { return reply.code(503).send({ error: error instanceof SearchConfigurationError ? error.code : 'config_pending' }); }
  });
  app.post('/internal/search/runtime-state', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!await options.internalPrincipal(request)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = stateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_runtime_state' });
    if (!options.dependencies || !options.runtime) return reply.code(503).send({ error: 'config_pending' });
    try {
      const effective = await readEffectiveSearchConfiguration(options.dependencies), state = parsed.data;
      if (state.desired_version !== effective.desired_version || state.revision !== effective.revision ||
        (state.status === 'applied' && effective.settings.enabled && effective.dependency_status))
        return reply.code(409).send({ error: 'runtime_revision_changed' });
      // Null is an explicit verified "no transition", not permission to adopt
      // a later claim's authority after this revision check raced its locks.
      if (!await options.runtime.acknowledge({ ...state, error_code: state.error_code ?? null },
        {expected_transition:effective.approved_model_transition??null}))
        return reply.code(409).send({ error: 'runtime_revision_changed' });
      return { ok: true };
    } catch(error) { return error instanceof SearchModelPinError ? reply.code(409).send({error:'model_migration_required'}) : reply.code(503).send({ error: 'config_pending' }); }
  });
  // Metadata only. The configuration token cannot query, ingest or delete data.
  app.get('/search/models', async (request, reply): Promise<SearchModels | unknown> => {
    reply.header('cache-control', 'no-store');
    if (!await options.principal(request)) return reply.code(401).send({ error: 'unauthorized' });
    const unavailable: SearchModels = { items: [], service_ready: false, reason: 'service_unavailable' };
    try {
      const config = await options.managementConnection();
      if (!config) return unavailable;
      const response = await (options.fetchImpl ?? fetch)(endpoint(config, '/v1/models'), { redirect: 'error',
        signal: AbortSignal.timeout(Math.min(3000, config.timeoutMs)), headers: { 'x-service-token': config.apiToken } });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return unavailable;
      }
      const result = searchModelsSchema.safeParse(await limitedJson(response));
      if (!result.success || new Set(result.data.items.map(item => item.package_id)).size !== result.data.items.length) return unavailable;
      return result.data;
    } catch { return unavailable; }
  });
}
