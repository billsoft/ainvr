/**
 * GET /v1/config/pg-info（2026-09-18）——"数据库配置"页 PG 只读展示区块。
 * 密码永远不在返回值里出现，这条测试专门锁死这一点。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { configRoutes } from '../routes/config.js';

function makeStubPgStore(queryImpl: () => Promise<unknown>) {
  return {
    pool: { query: queryImpl },
  };
}

describe('GET /v1/config/pg-info', () => {
  let app: FastifyInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CONFIG_PG_HOST = 'postgres';
    process.env.CONFIG_PG_PORT = '5432';
    process.env.CONFIG_PG_DATABASE = 'srs_console';
    process.env.CONFIG_PG_USER = 'console';
    process.env.CONFIG_PG_PASSWORD = 'super-secret-should-never-appear';
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it('返回 host/port/database/user，绝不带 password 字段', async () => {
    app = Fastify();
    await app.register(configRoutes, {
      pgStore: makeStubPgStore(async () => ({ rows: [] })) as any,
      orchestrator: {} as any,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/config/pg-info' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toEqual({
      host: 'postgres', port: '5432', database: 'srs_console', user: 'console', connected: true,
    });
    expect(JSON.stringify(data)).not.toContain('super-secret');
  });

  it('SELECT 1 探活失败时 connected:false，但整体请求仍然 200（只读展示，不是健康检查端点）', async () => {
    app = Fastify();
    await app.register(configRoutes, {
      pgStore: makeStubPgStore(async () => { throw new Error('connection lost'); }) as any,
      orchestrator: {} as any,
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/config/pg-info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.connected).toBe(false);
  });
});
