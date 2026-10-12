/**
 * /network/* 路由（2026-09-22）——转发到 os-helper 的 BFF 层。
 * 覆盖：未配置时全路由一致 503（不是部分 404）、zod 校验、正常转发、os-helper 报错透传。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { FastifyInstance } from 'fastify';
import { networkRoutes } from '../routes/network.js';

function startMockOsHelper(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('/network/* 未配置 os-helper 时', () => {
  let app: FastifyInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OS_HELPER_URL;
    delete process.env.OS_HELPER_TOKEN;
  });

  afterEach(async () => {
    await app?.close();
    process.env = { ...originalEnv };
  });

  it.each([
    ['GET', '/network/interfaces'],
    ['GET', '/network/pending'],
    ['GET', '/network/fallback'],
    ['GET', '/network/interfaces/eth0/test'],
    ['GET', '/network/wifi/wlan0/scan'],
    ['POST', '/network/confirm'],
    ['POST', '/network/revert'],
    ['POST', '/network/wifi/wlan0/connect'],
    ['POST', '/network/wifi/wlan0/disconnect'],
  ])('%s %s 返回一致的 503（不是 404）', async (method, url) => {
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('系统助手未配置，网络管理不可用');
  });

  it('PUT /network/interfaces/eth0/config 也是一致的 503', async () => {
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();
    const res = await app.inject({ method: 'PUT', url: '/network/interfaces/eth0/config', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('系统助手未配置，网络管理不可用');
  });
});

describe('/network/* 已配置 os-helper 时', () => {
  let app: FastifyInstance;
  let mock: { url: string; close: () => Promise<void> } | null = null;
  const originalEnv = { ...process.env };

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    process.env = { ...originalEnv };
  });

  it('GET /network/interfaces 转发并原样返回列表', async () => {
    mock = await startMockOsHelper((req, res) => {
      expect(req.url).toBe('/network/interfaces?all=false');
      expect(req.headers.authorization).toBe('Bearer tok-abc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, interfaces: [{ name: 'eth0', kind: 'ethernet' }] }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/network/interfaces' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0, data: [{ name: 'eth0', kind: 'ethernet' }] });
  });

  it('GET /network/fallback 转发并原样返回', async () => {
    mock = await startMockOsHelper((req, res) => {
      expect(req.url).toBe('/network/fallback');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, fallback: { interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: false },
      }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/network/fallback' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code: 0, data: { interface: 'enP8p1s0', address: '10.250.100.1', prefix: 24, reachable: false },
    });
  });

  it('GET /network/fallback 没走 provisioning 的设备返回 data: null', async () => {
    mock = await startMockOsHelper((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fallback: null }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/network/fallback' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0, data: null });
  });

  it('os-helper 不可达时 GET 路由返回 503 并带错误信息', async () => {
    process.env.OS_HELPER_URL = 'http://127.0.0.1:1'; // 必然连不上的端口
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/network/interfaces' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBeTruthy();
  });

  it('PUT 配置：请求体不合法时 400，问题细节透传，不打到 os-helper', async () => {
    let hit = false;
    mock = await startMockOsHelper((_req, res) => { hit = true; res.writeHead(200); res.end('{}'); });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'PUT', url: '/network/interfaces/eth0/config',
      payload: { ipv4: { method: 'not-a-real-method' }, ipv6: { method: 'auto' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('参数无效');
    expect(hit).toBe(false);
  });

  it('PUT 配置：合法请求转发到 os-helper，返回 202 与回滚秒数', async () => {
    mock = await startMockOsHelper((req, res) => {
      expect(req.method).toBe('PUT');
      expect(req.url).toBe('/network/interfaces/eth0/config');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rollback_seconds: 30 }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'PUT', url: '/network/interfaces/eth0/config',
      payload: { ipv4: { method: 'auto' }, ipv6: { method: 'auto' } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ code: 0, data: { ok: true, rollback_seconds: 30 } });
  });

  it('os-helper 报出"已有待确认的变更"时原样透传给前端', async () => {
    mock = await startMockOsHelper((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '已有待确认的变更，请先确认或回滚' }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'PUT', url: '/network/interfaces/eth0/config',
      payload: { ipv4: { method: 'auto' }, ipv6: { method: 'auto' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('已有待确认的变更，请先确认或回滚');
  });

  it('WiFi 连接：ssid 超长时 400，不转发', async () => {
    let hit = false;
    mock = await startMockOsHelper((_req, res) => { hit = true; res.writeHead(200); res.end('{}'); });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/network/wifi/wlan0/connect',
      payload: { ssid: 'x'.repeat(33) },
    });
    expect(res.statusCode).toBe(400);
    expect(hit).toBe(false);
  });

  it('WiFi 断开：转发并返回 code:0', async () => {
    mock = await startMockOsHelper((req, res) => {
      expect(req.url).toBe('/network/wifi/wlan0/disconnect');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/network/wifi/wlan0/disconnect' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0 });
  });
});

describe('POST /network/confirm 带变更 ID', () => {
  let app: FastifyInstance;
  let mock: { url: string; close: () => Promise<void> } | null = null;
  const originalEnv = { ...process.env };
  let forwarded: string[] = [];

  async function boot() {
    forwarded = [];
    mock = await startMockOsHelper((req, res, body) => {
      expect(req.url).toBe('/network/confirm');
      forwarded.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok-abc';
    app = Fastify();
    await app.register(networkRoutes);
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    process.env = { ...originalEnv };
  });

  it('把前端看到的变更 ID 原样转给 os-helper', async () => {
    await boot();
    const res = await app.inject({ method: 'POST', url: '/network/confirm', payload: { id: 'abc123' } });
    expect(res.statusCode).toBe(200);
    expect(forwarded.map((b) => JSON.parse(b))).toEqual([{ id: 'abc123' }]);
  });

  it('不带 ID（旧页面）照旧转发，不带请求体', async () => {
    await boot();
    const res = await app.inject({ method: 'POST', url: '/network/confirm' });
    expect(res.statusCode).toBe(200);
    expect(forwarded).toEqual(['']);
  });

  it('ID 不合法时 400，不转发', async () => {
    await boot();
    const res = await app.inject({ method: 'POST', url: '/network/confirm', payload: { id: 'x'.repeat(65) } });
    expect(res.statusCode).toBe(400);
    expect(forwarded).toEqual([]);
  });
});
