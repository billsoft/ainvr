// 2026-09-16 安全回归测试：backend/adminPasswordHash 不能通过通用配置中心
// 接口读写/删除。不依赖真实 PG（RUN_PG_TESTS 之外）——configRoutes 是纯
// (fastify, opts) 函数，这里传一个手写的 pgStore 桩，只实现被本文件路由
// 实际调用到的方法，并用调用计数断言"守卫生效时压根没碰到 pgStore"。
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { configRoutes } from '../routes/config.js';
import { ADMIN_PASSWORD_SECRET_KEY } from '../services/adminPasswordMigration.js';

function makeStubPgStore() {
  const calls = {
    upsertDocument: [] as any[],
    setSecret: [] as any[],
    deleteSecret: [] as any[],
    poolQueries: [] as string[],
  };
  const pgStore = {
    upsertDocument: async (doc: any) => {
      calls.upsertDocument.push(doc);
      return { ...doc, id: 1, createdAt: '', updatedAt: '' };
    },
    setSecret: async (key: string, value: string, actor?: string) => {
      calls.setSecret.push({ key, value, actor });
    },
    deleteSecret: async (key: string) => {
      calls.deleteSecret.push(key);
      return true;
    },
    hasSecret: async () => false,
    encryptSecret: async (v: string) => `cipher:${v}`,
    getVersionSnapshot: async (_v: number) => [] as any[],
    getServiceState: async (service: string) => ({ serviceName: service, desiredVersion: null, appliedVersion: null }),
    listDocuments: async (_service?: string, _group?: string) => [] as any[],
    listVersions: async (_limit?: number) => [] as any[],
    listServiceStates: async () => [] as any[],
    pool: {
      connect: async () => ({
        query: async (sql: string) => {
          calls.poolQueries.push(sql.trim().split('\n')[0]!.trim());
          return { rows: [] };
        },
        release: () => {},
      }),
    },
  };
  return { pgStore, calls };
}

describe('config.ts — backend/adminPasswordHash 保留字段守卫', () => {
  let app: FastifyInstance;
  let calls: ReturnType<typeof makeStubPgStore>['calls'];

  beforeEach(async () => {
    app = Fastify();
    const stub = makeStubPgStore();
    calls = stub.calls;
    await app.register(configRoutes, { pgStore: stub.pgStore as any, orchestrator: {} as any });
    await app.ready();
  });

  it('POST /v1/config/documents 写 backend/system/settings 带 adminPasswordHash → 403，且不落库', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/documents',
      payload: {
        service: 'backend', group: 'system', name: 'settings',
        config: { adminPasswordHash: 'attacker-chosen-hash', srsApiHost: 'x' },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.upsertDocument).toHaveLength(0);
  });

  it('POST /v1/config/documents 写 backend/system/settings 不带 adminPasswordHash → 正常落库', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/documents',
      payload: {
        service: 'backend', group: 'system', name: 'settings',
        config: { srsApiHost: 'x' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.upsertDocument).toHaveLength(1);
  });

  it('PUT /v1/config/secrets/backend/adminPasswordHash → 403，且不写 secret', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/config/secrets/${ADMIN_PASSWORD_SECRET_KEY}`,
      payload: { value: 'attacker-chosen-hash' },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.setSecret).toHaveLength(0);
  });

  it('DELETE /v1/config/secrets/backend/adminPasswordHash → 403，且不删 secret', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/config/secrets/${ADMIN_PASSWORD_SECRET_KEY}`,
    });
    expect(res.statusCode).toBe(403);
    expect(calls.deleteSecret).toHaveLength(0);
  });

  it('PUT /v1/config/secrets/recorder/storage.smb.password（非保留 key）→ 正常写入，未被误伤', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/config/secrets/recorder/storage.smb.password',
      payload: { value: 'some-smb-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.setSecret).toHaveLength(1);
    expect(calls.setSecret[0].key).toBe('recorder/storage.smb.password');
  });

  it('POST /v1/config/import 导入含 adminPasswordHash 明文的 backend/system/settings → 403，整笔 ROLLBACK', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/import',
      payload: {
        mode: 'merge',
        data: {
          documents: [
            {
              service: 'backend', group: 'system', name: 'settings',
              config: { adminPasswordHash: 'attacker-chosen-hash', srsApiHost: 'x' },
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.poolQueries).toContain('ROLLBACK');
    expect(calls.poolQueries).not.toContain('COMMIT');
  });

  it('POST /v1/config/import 含白名单外服务名 → 400 + ROLLBACK，且不落任何文档', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/import',
      payload: {
        mode: 'merge',
        data: {
          documents: [
            { service: 'testsvc', group: 'system', name: 'x', config: { a: 1 } },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('未知服务');
    expect(calls.poolQueries).toContain('ROLLBACK');
    expect(calls.poolQueries).not.toContain('COMMIT');
    expect(calls.poolQueries.some((q) => q.startsWith('INSERT INTO config_documents'))).toBe(false);
    expect(calls.setSecret).toHaveLength(0);
  });

  it('DELETE /v1/config/documents 白名单外服务名 → 400，不调 deleteDocument', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/config/documents/testsvc/system/x',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('未知服务');
  });

  it('POST /v1/config/import 合法服务名 → 走到落库（merge，COMMIT）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/import',
      payload: {
        mode: 'merge',
        data: {
          documents: [
            { service: 'recorder', group: 'system', name: 'settings', config: { files: { segmentSeconds: 60 } } },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.poolQueries.some((q) => q.startsWith('INSERT INTO config_documents'))).toBe(true);
    expect(calls.poolQueries).toContain('COMMIT');
  });
});

// 2026-09-16 安全回归：服务 token 只能碰归属它自己的资源，不是配置中心的
// 管理员权限。真实鉴权在 app.ts 的 onRequest 钩子里把 resolveServiceByToken()
// 的结果挂到 req.boundService 上（见 serviceScopeError 的调用约定）——这里
// 不重新验证 app.ts 的 token→服务名解析逻辑（那部分是 serviceTokens.ts 的
// 职责，见其自己的单测），只用一个最小 onRequest 钩子模拟"已经解析出绑定
// 服务"这个前提，聚焦测试 config.ts 里每条路由是否正确按资源归属收窄。
describe('config.ts — 服务 token 权限范围收窄（2026-09-16）', () => {
  let app: FastifyInstance;
  let calls: ReturnType<typeof makeStubPgStore>['calls'];

  beforeEach(async () => {
    app = Fastify();
    // 模拟 app.ts onRequest 钩子已经解析出的绑定服务身份
    app.addHook('onRequest', async (req) => {
      const bound = req.headers['x-test-bound-service'];
      if (typeof bound === 'string') (req as any).boundService = bound;
    });
    const stub = makeStubPgStore();
    calls = stub.calls;
    // GET .../versions/:version/snapshot 和 POST .../service-states/:service
    // 这两条路由不走 req.boundService（它们是拉配置客户端实际在用的两条，
    // 各自原本就有内联的 resolveServiceByToken(serviceTokens, x-service-token)
    // 逻辑，本次改动只是给 snapshot 那条补了"必须带匹配的 ?service="），
    // 这里配一个真实 serviceTokens map 让下面 snapshot 测试能走到这条真实
    // 鉴权路径，而不是走本文件其余测试用的 x-test-bound-service 模拟钩子。
    await app.register(configRoutes, {
      pgStore: stub.pgStore as any,
      orchestrator: {} as any,
      serviceTokens: new Map([['recorder-svc-token', 'recorder']]),
    });
    await app.ready();
  });

  it('GET /v1/config/documents?service=recorder 带 recorder token → 200（自己的资源）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/documents?service=recorder',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /v1/config/documents?service=ai-service 带 recorder token → 403（跨服务）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/documents?service=ai-service',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/config/documents（不带 ?service=）带 recorder token → 403（不能拉全量列表）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/documents',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /v1/config/documents 写 ai-service 的文档，带 recorder token → 403，不落库', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/documents',
      headers: { 'x-test-bound-service': 'recorder' },
      payload: { service: 'ai-service', group: 'system', name: 'settings', config: { x: 1 } },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.upsertDocument).toHaveLength(0);
  });

  it('POST /v1/config/publish 带任一服务 token → 403（全局操作，服务 token 一律拒绝）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/config/publish',
      headers: { 'x-test-bound-service': 'recorder' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  // 2026-09-16：POST /v1/config/versions/:version/rollback 已随"版本历史/
  // 回滚"UI 一起下线删除，原来这里的"服务 token → 403"用例随路由一起移除
  // （路由不存在了，命中的是 404 而不是本文件的 scope 守卫）。

  it('GET /v1/config/export 带服务 token → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/export',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/config/audit-logs 带服务 token → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/audit-logs',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /v1/config/secrets/recorder/storage.smb.password 带 recorder 自己的 token → 403（服务侧没有密钥写入口，即便是自己的）', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/config/secrets/recorder/storage.smb.password',
      headers: { 'x-test-bound-service': 'recorder' },
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.setSecret).toHaveLength(0);
  });

  it('DELETE /v1/config/secrets/ai-service/server.api_key 带 recorder token → 403（跨服务且服务侧本就不该有写入口）', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/config/secrets/ai-service/server.api_key',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
    expect(calls.deleteSecret).toHaveLength(0);
  });

  it('GET /v1/config/service-states/recorder 带 recorder token → 200（拉配置客户端依赖这条查自己的 desiredVersion，必须继续可用）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/service-states/recorder',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /v1/config/service-states/ai-service 带 recorder token → 403（不能查别的服务状态）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/service-states/ai-service',
      headers: { 'x-test-bound-service': 'recorder' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/config/versions/1/snapshot 带真实 recorder 服务 token 但不带 ?service= → 403（不能拉全量多服务快照）', async () => {
    // 这条路由用的是真实 x-service-token 鉴权（resolveServiceByToken），
    // 不是本文件其余测试用的 x-test-bound-service 模拟钩子，见 beforeEach 注释
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/versions/1/snapshot',
      headers: { 'x-service-token': 'recorder-svc-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/config/versions/1/snapshot 带真实 recorder 服务 token 且 ?service=recorder → 200（拉配置客户端的正常用例，必须继续可用）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config/versions/1/snapshot?service=recorder',
      headers: { 'x-service-token': 'recorder-svc-token' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('不带 x-test-bound-service（模拟 console token/开放模式）→ 上面这些全局操作恢复完整权限', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/config/export' });
    expect(res.statusCode).toBe(200);
  });
});
