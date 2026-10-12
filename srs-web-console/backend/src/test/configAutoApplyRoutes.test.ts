import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { configRoutes } from '../routes/config.js';
async function setup(bound?: string) {
  const app = Fastify();
  if (bound) app.addHook('onRequest', async req => { (req as any).boundService = bound; });
  const queries: any[] = [];
  const client = { query: vi.fn(async (sql: string, args?: any[]) => {
    queries.push({ sql, args });
    return { rows: sql.startsWith('SELECT config') ? [{ updated_at: '2026-10-07T01:00:00.000Z', config: { channelSchedules: { keep: true }, files: { segmentSeconds: 60 } } }] : [] };
  }) };
  const store = { encryptSecret: vi.fn(async () => 'encrypted'), listServiceStates: async () => [{ serviceName: 'recorder', desiredVersion: 8, appliedVersion: 8, status: 'applied' }], getDocument: async () => null };
  const publish = vi.fn(async (_summary: string, _actor: string, options: any) => {
    await options.prepare(client);
    return { version: { version: 8 }, results: [{ ok: true }] };
  });
  await app.register(configRoutes, { pgStore: store as any, orchestrator: {
    publish, getAdapter: () => ({ validate: async () => ({ ok: true, errors: [] }) }),
  } as any });
  return { app, queries, publish, store };
}
describe('automatic save endpoint', () => {
  it.each([null, '2026-10-06T01:00:00.000Z'])('rejects stale document version %s before any write', async expectedUpdatedAt => {
    const { app, queries } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v1/config/apply', payload: {
      changes: [{ service: 'recorder', group: 'system', name: 'settings', expectedUpdatedAt, config: { files: { segmentSeconds: 90 } } }],
    } });
    await new Promise(resolve => setTimeout(resolve, 10));
    const status = await app.inject({ method: 'GET', url: `/v1/config/apply?id=${response.json().data.id}` });
    expect(status.json().data.status).toBe('failed');
    expect(status.json().data.stage).toContain('配置已被其他操作更新');
    expect(queries.some(q => q.sql.startsWith('INSERT'))).toBe(false);
    await app.close();
  });
  it('accepts the version the editor actually read', async () => {
    const { app, queries } = await setup();
    await app.inject({ method: 'POST', url: '/v1/config/apply', payload: {
      changes: [{ service: 'recorder', group: 'system', name: 'settings', expectedUpdatedAt: '2026-10-07T01:00:00.000Z', config: { files: { segmentSeconds: 90 } } }],
    } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queries.some(q => q.sql.startsWith('INSERT'))).toBe(true);
    await app.close();
  });
  it('encrypts both Mongo credentials in the same save transaction', async () => {
    const { app, store, queries } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v1/config/apply', payload: {
      changes: [{ service: 'ai-service', group: 'system', name: 'settings', config: { snapshot_store: { mongo_uri: 'mongodb://writer:test@host/db', mongo_readonly_password: 'readonly-test' } } }],
    } });
    expect(response.statusCode).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.encryptSecret).toHaveBeenCalledWith('mongodb://writer:test@host/db');
    expect(store.encryptSecret).toHaveBeenCalledWith('readonly-test');
    const written = JSON.parse(queries.find(q => q.sql.startsWith('INSERT INTO config_documents')).args[3]);
    expect(written.snapshot_store.mongo_uri).toBe('${secret:ai-service/snapshot_store.mongo_uri}');
    expect(written.snapshot_store.mongo_readonly_password).toBe('${secret:ai-service/snapshot_store.mongo_readonly_password}');
    await app.close();
  });
  it('forbids service credentials from starting or inspecting admin jobs', async () => {
    const { app, publish } = await setup('recorder');
    for (const method of ['GET', 'POST'] as const) {
      expect((await app.inject({ method, url: '/v1/config/apply' })).statusCode).toBe(403);
    }
    expect(publish).not.toHaveBeenCalled(); await app.close();
  });
  it('rejects malformed and password-hash changes without writes', async () => {
    const { app, publish } = await setup();
    for (const changes of [[], [{ service: 'backend', group: 'system', name: 'settings', config: { adminPasswordHash: 'bad' } }]]) {
      expect((await app.inject({ method: 'POST', url: '/v1/config/apply', payload: { changes } })).statusCode).toBe(400);
    }
    expect(publish).not.toHaveBeenCalled(); await app.close();
  });
  it('merges fresh document, scopes services, encrypts SMB password in the transaction', async () => {
    const { app, queries, publish, store } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v1/config/apply', payload: {
      changes: [{ service: 'recorder', group: 'system', name: 'settings', config: { storage: { kind: 'smb', smb: { password: 'test-only' } } } }],
    } });
    expect(response.statusCode).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(publish.mock.calls[0]?.[2].services).toEqual(['recorder']);
    expect(store.encryptSecret).toHaveBeenCalledWith('test-only');
    const written = JSON.parse(queries.find(q => q.sql.startsWith('INSERT INTO config_documents')).args[3]);
    expect(written.channelSchedules).toEqual({ keep: true });
    expect(written.storage.smb.password).toBe('${secret:recorder/storage.smb.password}');
    expect(response.body).not.toContain('test-only'); await app.close();
  });
});
