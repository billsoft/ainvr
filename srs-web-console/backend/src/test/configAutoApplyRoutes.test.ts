import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { DEFAULT_SETTINGS } from '../types/channel.js';
import { BackendConfigAdapter } from '../store/backendAdapter.js';
import { configRoutes } from '../routes/config.js';
async function setup(bound?: string, runtime?: typeof DEFAULT_SETTINGS, aiServiceBaseUrl?: string) {
  const app = Fastify();
  if (bound) app.addHook('onRequest', async req => { (req as any).boundService = bound; });
  const queries: any[] = [];
  const client = { query: vi.fn(async (sql: string, args?: any[]) => {
    queries.push({ sql, args });
    return { rows: sql.startsWith('SELECT config') && !runtime ? [{ updated_at: '2026-10-07T01:00:00.000Z', config: { channelSchedules: { keep: true }, files: { segmentSeconds: 60 } } }] : [] };
  }) };
  const store = { encryptSecret: vi.fn(async () => 'encrypted'), listServiceStates: async () => [{ serviceName: 'recorder', desiredVersion: 8, appliedVersion: 8, status: 'applied' }], getDocument: async () => null };
  const publish = vi.fn(async (_summary: string, _actor: string, options: any) => {
    await options.prepare(client);
    return { version: { version: 8 }, results: [{ ok: true }] };
  });
  await app.register(configRoutes, { pgStore: store as any, aiServiceBaseUrl, readBackendSettings: runtime ? async () => runtime : undefined, orchestrator: {
    publish, getAdapter: (service: string) => service === 'backend' ? new BackendConfigAdapter() : ({ validate: async () => ({ ok: true, errors: [] }) }),
  } as any });
  return { app, queries, publish, store, client };
}

const llmSettings = () => ({ enabled: false, listen: { host: '127.0.0.1', port: 8300 }, admin_key: '${secret:llm-service/admin/v1}',
  api_keys: [{ name: 'alarm-review', scope: 'inference', key: '${secret:llm-service/alarm/v1}' }],
  model: { package_id: 'qwen3vl-4b-review-v3', load_policy: 'resident', ion_reserve_mb: 512 },
  tasks: { 'alarm-review-zh-v1': { calibration_temperature: 1, aspect_policy: 'reject' } },
  scheduling: { queue_size: 8, queue_timeout_s: 30, exec_timeout_s: 10, submit_time_share_cap_percent: 40, prefill_profile: 's256' }, logging: { record_requests: false } });
it('saving LLM configuration never provisions a search caller: the model is reserved for alarm review', async () => {
  const f = await setup(), config = llmSettings();
  f.store.listServiceStates = async () => [{ serviceName: 'llm-service', desiredVersion: 8, appliedVersion: 8, status: 'applied' }];
  f.client.query.mockImplementation(async (sql: string, args?: any[]) => {
    f.queries.push({ sql, args }); return { rows: sql.startsWith('SELECT config') ? [{ config, updated_at: '2026-10-07T01:00:00.000Z' }] : [] };
  });
  try {
    const response = await f.app.inject({ method: 'POST', url: '/v1/config/apply', payload: { changes: [{ service: 'llm-service', group: 'system', name: 'settings', config }] } });
    expect(response.statusCode).toBe(202); await new Promise(resolve => setTimeout(resolve, 20));
    const persisted = f.queries.find(q => q.sql.startsWith('INSERT INTO config_documents'));
    expect(persisted).toBeDefined(); const saved = JSON.parse(persisted.args[3]);
    expect(saved.enabled).toBe(false); expect(saved.admin_key).toBe(config.admin_key); expect(saved.model).toEqual(config.model);
    expect(saved.scheduling).toEqual(config.scheduling);
    expect(saved.api_keys).toEqual(config.api_keys);
    expect(saved.api_keys.some((k: { name: string }) => k.name === 'search-verify')).toBe(false);
    expect(f.store.encryptSecret).not.toHaveBeenCalled();
    expect(f.publish.mock.calls[0]![2].services).toEqual(['llm-service']);
  } finally { await f.app.close(); }
});
it('first partial backend save preserves deployed values and migrates only the legacy credential', async () => {
  const runtime = { ...DEFAULT_SETTINGS, srsApiHost: '127.0.0.1:21985', adminPasswordHash: 'private-password-hash',
    aiService: { baseUrl: 'http://127.0.0.1:8000', pollIntervalMs: 6000, apiKey: 'private-legacy-key' } };
  const { app, queries, store } = await setup(undefined, runtime);
  const response = await app.inject({ method: 'POST', url: '/v1/config/apply', payload: {
    changes: [{ service: 'backend', group: 'system', name: 'settings', expectedUpdatedAt: null,
      config: { monitorSoftLimit: 4, aiService: { pollIntervalMs: 7000 } } }],
  } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const write = queries.find(q => q.sql.startsWith('INSERT INTO config_documents'));
  expect(write).toBeDefined();
  const config = JSON.parse(write.args[3]);
  expect(config.srsApiHost).toBe(runtime.srsApiHost);
  expect(config.monitorSoftLimit).toBe(4);
  expect(config.monitorHardLimit).toBe(9);
  expect(config.aiService).toEqual({baseUrl: runtime.aiService.baseUrl, pollIntervalMs: 7000, apiKey: ''});
  expect(config).not.toHaveProperty('adminPasswordHash');
  expect(JSON.stringify(config)).not.toContain('private-');
  expect(response.body).not.toContain('private-');
  expect(store.encryptSecret).toHaveBeenCalledWith('private-legacy-key');
  expect(queries.find(q => q.sql.startsWith('INSERT INTO config_secrets')).sql).toContain('DO NOTHING');
  expect(runtime.aiService.apiKey).toBe('private-legacy-key');
  await app.close();
});

it.each(['runtime', 'deployment'])('checks AI readiness using the same %s address as the proxy', async source => {
  const url = 'http://127.0.0.1:28000';
  const runtime = { ...DEFAULT_SETTINGS, aiService: { ...DEFAULT_SETTINGS.aiService, baseUrl: source === 'runtime' ? url : '' } };
  const { app, store } = await setup(undefined, runtime, source === 'deployment' ? url : undefined);
  store.listServiceStates = async () => [{ serviceName: 'ai-service', desiredVersion: 8, appliedVersion: 8, status: 'applied' }];
  const fetchMock = vi.fn(async () => new Response('{}', {status: 200}));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const response = await app.inject({method: 'POST', url: '/v1/config/apply', payload: {changes: [
      {service: 'ai-service', group: 'system', name: 'settings', config: {server: {port: 28000}}},
    ]}});
    await vi.waitFor(async () => {
      const status = await app.inject({method: 'GET', url: `/v1/config/apply?id=${response.json().data.id}`});
      expect(status.json().data.status).toBe('succeeded');
    });
    expect(fetchMock).toHaveBeenCalledWith(`${url}/health`, expect.anything());
  } finally { vi.unstubAllGlobals(); await app.close(); }
});
