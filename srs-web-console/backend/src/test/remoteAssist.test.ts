/**
 * /remote-assist/* 路由：转发到 os-helper；修改中转服务器需再次验证管理员密码，
 * 密码不正确或参数无效时不打到宿主机；宿主机的中文错误连同状态码透传。
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { FastifyInstance } from 'fastify';
import { registerRemoteAssistRoutes } from '../routes/remoteAssist.js';
import { hashPassword } from '../services/passwordHash.js';

interface Hit { method?: string; url?: string; body: any; auth?: string }

function startMockOsHelper(respond: (hit: Hit) => [number, unknown]) {
  const hits: Hit[] = [];
  return new Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const hit = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization };
        hits.push(hit);
        const [status, body] = respond(hit);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const STATUS = {
  installed: true, enabled: false, state: 'disabled', message: null,
  server: { host: 'relay.example.com', port: 443 }, credentials: true, sessions: 0, enabled_at: null,
};

describe('/remote-assist/*', () => {
  let app: FastifyInstance | null = null;
  let mock: Awaited<ReturnType<typeof startMockOsHelper>> | null = null;
  const originalEnv = { ...process.env };

  afterEach(async () => {
    await app?.close(); app = null;
    await mock?.close(); mock = null;
    process.env = { ...originalEnv };
  });

  async function build(password = 'correct-horse', respond: (hit: Hit) => [number, unknown] = () => [200, { ok: true }]) {
    mock = await startMockOsHelper(respond);
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    const hash = password ? await hashPassword(password) : '';
    app = Fastify();
    registerRemoteAssistRoutes(app, { passwordCache: { get: async () => hash, invalidate() {} } });
    await app.ready();
    return mock;
  }

  it('os-helper 未配置时所有接口一致 503', async () => {
    delete process.env.OS_HELPER_URL;
    delete process.env.OS_HELPER_TOKEN;
    app = Fastify();
    registerRemoteAssistRoutes(app, {});
    await app.ready();
    for (const [method, url] of [['GET', '/remote-assist'], ['GET', '/remote-assist/events'],
      ['POST', '/remote-assist/enable'], ['POST', '/remote-assist/disable'],
      ['POST', '/remote-assist/test'], ['PUT', '/remote-assist/server']] as const) {
      const res = await app.inject({ method, url, payload: method === 'PUT' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error).toBe('系统助手未配置，远程协助不可用');
    }
  });

  it('状态：转发并去掉内部 ok 字段', async () => {
    const m = await build('x', () => [200, { ok: true, ...STATUS }]);
    const res = await app!.inject({ method: 'GET', url: '/remote-assist' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0, data: STATUS });
    expect(m.hits[0]!.url).toBe('/remote-assist/status');
    expect(m.hits[0]!.auth).toBe('Bearer tok-abc');
  });

  it('宿主机不可达时状态接口 503 且是中文提示', async () => {
    process.env.OS_HELPER_URL = 'http://127.0.0.1:1';
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    registerRemoteAssistRoutes(app, {});
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/remote-assist' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('暂时无法读取远程协助状态，请稍后重试');
  });

  it('记录：转发 limit', async () => {
    const m = await build('x', () => [200, { ok: true, events: [{ ts: 1, type: 'enabled', actor: 'admin', detail: null }] }]);
    const res = await app!.inject({ method: 'GET', url: '/remote-assist/events?limit=20' });
    expect(res.json()).toEqual({ code: 0, data: [{ ts: 1, type: 'enabled', actor: 'admin', detail: null }] });
    expect(m.hits[0]!.url).toBe('/remote-assist/events?limit=20');
  });

  it('开启/关闭：带上操作人转发', async () => {
    const m = await build();
    expect((await app!.inject({ method: 'POST', url: '/remote-assist/enable' })).json()).toEqual({ code: 0 });
    expect((await app!.inject({ method: 'POST', url: '/remote-assist/disable' })).json()).toEqual({ code: 0 });
    expect(m.hits.map(h => [h.url, h.body])).toEqual([
      ['/remote-assist/enable', { actor: 'admin' }],
      ['/remote-assist/disable', { actor: 'admin' }],
    ]);
  });

  it('宿主机的中文错误连同状态码透传', async () => {
    await build('x', () => [409, { ok: false, error: '远程协助开启期间不能修改中转服务器，请先关闭远程协助' }]);
    const res = await app!.inject({ method: 'PUT', url: '/remote-assist/server', payload: { host: 'a.example.com', port: 443, password: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('远程协助开启期间不能修改中转服务器，请先关闭远程协助');
  });

  it('宿主机内部错误或连接失败不把英文原文透传给页面', async () => {
    await build('x', () => [500, { ok: false, error: 'internal error' }]);
    const res = await app!.inject({ method: 'POST', url: '/remote-assist/enable' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('远程协助开启失败，请稍后重试');
    await app!.close(); await mock!.close(); mock = null;

    process.env.OS_HELPER_URL = 'http://127.0.0.1:1';
    app = Fastify();
    registerRemoteAssistRoutes(app, {});
    await app.ready();
    const unreachable = await app.inject({ method: 'POST', url: '/remote-assist/test' });
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json().error).toBe('暂时无法检测连通性，请稍后重试');
  });

  it('修改中转服务器：密码不正确时 403，不转发', async () => {
    const m = await build();
    for (const payload of [{ host: 'a.example.com', port: 443 }, { host: 'a.example.com', port: 443, password: 'wrong' }]) {
      const res = await app!.inject({ method: 'PUT', url: '/remote-assist/server', payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('管理员密码不正确');
    }
    expect(m.hits).toHaveLength(0);
  });

  it('修改中转服务器：参数无效时 400，不转发', async () => {
    const m = await build();
    for (const payload of [
      { host: '', port: 443, password: 'correct-horse' },
      { host: 'a.example.com', port: 0, password: 'correct-horse' },
      { host: 'a.example.com', port: 70000, password: 'correct-horse' },
      { host: 'x'.repeat(254), port: 443, password: 'correct-horse' },
    ]) {
      const res = await app!.inject({ method: 'PUT', url: '/remote-assist/server', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(m.hits).toHaveLength(0);
  });

  it('修改中转服务器：密码正确时转发地址端口和操作人，不转发密码', async () => {
    const m = await build('correct-horse', () => [200, { ok: true, server: { host: 'a.example.com', port: 8443 } }]);
    const res = await app!.inject({ method: 'PUT', url: '/remote-assist/server', payload: { host: ' a.example.com ', port: 8443, password: 'correct-horse' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0, data: { host: 'a.example.com', port: 8443 } });
    expect(m.hits[0]!.method).toBe('PUT');
    expect(m.hits[0]!.body).toEqual({ host: 'a.example.com', port: 8443, actor: 'admin' });
  });

  it('未设置管理员密码的设备可直接修改', async () => {
    const m = await build('', () => [200, { ok: true, server: { host: 'a.example.com', port: 443 } }]);
    const res = await app!.inject({ method: 'PUT', url: '/remote-assist/server', payload: { host: 'a.example.com', port: 443 } });
    expect(res.statusCode).toBe(200);
    expect(m.hits).toHaveLength(1);
  });

  it('连通性检测：转发结果', async () => {
    await build('x', () => [200, { ok: true, latency_ms: 35, message: '中转服务器可以连接' }]);
    const res = await app!.inject({ method: 'POST', url: '/remote-assist/test' });
    expect(res.json()).toEqual({ code: 0, data: { ok: true, latency_ms: 35, message: '中转服务器可以连接' } });
  });
});
