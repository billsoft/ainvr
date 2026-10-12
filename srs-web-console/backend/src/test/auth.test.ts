import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

describe('最小鉴权（局域网口令）', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-auth-'));
    process.env.NODE_ENV = 'test';
    app = await buildApp({ dataDir: tmpDir, srsApiHost: '127.0.0.1:19859', corsOrigin: true });
  });

  afterEach(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('未设置密码时：GET /api/auth/status 显示 required=false，且所有接口不带 token 也放行', async () => {
    const statusRes = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(statusRes.json().data.required).toBe(false);

    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(200);
  });

  it('设置密码后：不带 token 的请求返回 401，/api/auth/status 与 /api/auth/login 仍然豁免', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'secret123' } });

    const blocked = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(blocked.statusCode).toBe(401);

    // 豁免路径不受影响
    const statusRes = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().data.required).toBe(true);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });

  it('密码错误时登录返回 401，不泄露具体原因', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'secret123' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('用正确密码登录拿到 token 后，带 token 的请求正常放行', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'secret123' } });
    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret123' } });
    expect(loginRes.statusCode).toBe(200);
    const token = loginRes.json().data.token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { 'x-console-token': token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('伪造/错误的 token 依然 401', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'secret123' } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { 'x-console-token': '0000000000000000000000000000000000000000000000000000000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });
});
