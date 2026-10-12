/**
 * POST /v1/config/restart/:service 测试（2026-09-18）——配置发布后
 * "自动重启+进度"功能的触发端点。不测真实 systemctl/HTTP，
 * restartHelperClient 整体 mock（它自己的 fetch 行为已在
 * restartHelperClient.test.ts 里单独覆盖）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { configRoutes } from '../routes/config.js';

const triggerRestartMock = vi.fn();
const restartHelperConfigFromEnvMock = vi.fn();

vi.mock('../services/restartHelperClient.js', () => ({
  isRestartableService: (name: unknown) => name === 'ai-service' || name === 'recorder',
  restartHelperConfigFromEnv: (...args: unknown[]) => restartHelperConfigFromEnvMock(...args),
  triggerRestart: (...args: unknown[]) => triggerRestartMock(...args),
}));

function makeStubPgStore() {
  const calls = {
    updateServiceState: [] as any[],
    addAuditLog: [] as any[],
  };
  const state: Record<string, any> = {
    'ai-service': { serviceName: 'ai-service', appliedAt: new Date('2026-09-18T09:00:00Z'), status: 'applied' },
  };
  const pgStore = {
    getServiceState: async (service: string) => state[service] ?? null,
    updateServiceState: async (s: any) => {
      calls.updateServiceState.push(s);
      return { ...s };
    },
    addAuditLog: async (entry: any) => {
      calls.addAuditLog.push(entry);
    },
  };
  return { pgStore, calls };
}

describe('legacy mutation endpoints', () => {
  it.each(['/v1/config/restart/recorder', '/v1/config/publish'])('rejects %s without side effects', async url => {
    const app = Fastify(); const stub = makeStubPgStore();
    await app.register(configRoutes, { pgStore: stub.pgStore as any, orchestrator: {} as any });
    const response = await app.inject({ method: 'POST', url });
    expect(response.statusCode).toBe(410);
    expect(stub.calls.updateServiceState).toHaveLength(0);
    expect(triggerRestartMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /v1/config/service-states/:service（自报）— appliedAt 补丁', () => {
  let app: FastifyInstance;
  let calls: ReturnType<typeof makeStubPgStore>['calls'];

  beforeEach(async () => {
    app = Fastify();
    const stub = makeStubPgStore();
    calls = stub.calls;
    await app.register(configRoutes, { pgStore: stub.pgStore as any, orchestrator: {} as any });
    await app.ready();
  });

  it('status=applied 时服务器打上 appliedAt（拉模式客户端自己不传时间戳）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/config/service-states/ai-service',
      payload: { appliedVersion: 12, status: 'applied', restartRequired: false },
    });
    expect(res.statusCode).toBe(200);
    const call = calls.updateServiceState[0];
    expect(call.status).toBe('applied');
    expect(call.appliedAt).toBeInstanceOf(Date);
  });

  it('status=failed 时不写 appliedAt——没有真的应用成功，不能假装有生效时刻', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/config/service-states/ai-service',
      payload: { status: 'failed', errorMessage: '校验失败' },
    });
    expect(res.statusCode).toBe(200);
    const call = calls.updateServiceState[0];
    expect(call.status).toBe('failed');
    expect(call.appliedAt).toBeUndefined();
  });
});
