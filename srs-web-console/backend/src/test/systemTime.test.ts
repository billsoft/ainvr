/**
 * /system-time 路由——转发到 os-helper。离线现场靠它手动校时与设置局域网对时服务器。
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { FastifyInstance } from 'fastify';
import { systemTimeRoutes } from '../routes/systemTime.js';

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
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const time = { epoch_ms: 1791525000000, timezone: 'Asia/Shanghai', ntp_enabled: true,
  ntp_synchronized: false, manually_set: false, valid: true, min_valid_epoch_ms: 1767225600000, ntp_servers: [] };

describe('/system-time', () => {
  let app: FastifyInstance;
  let mock: { url: string; close: () => Promise<void> } | null = null;
  const originalEnv = { ...process.env };
  let calls: { method: string; url: string; body: string }[] = [];

  async function boot(reply: (url: string) => [number, unknown] = () => [200, { ok: true, time }]) {
    calls = [];
    mock = await startMockOsHelper((req, res, body) => {
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      const [status, payload] = reply(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    process.env.OS_HELPER_URL = mock.url;
    process.env.OS_HELPER_TOKEN = 'tok';
    app = Fastify();
    await app.register(systemTimeRoutes);
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    mock = null;
    process.env = { ...originalEnv };
  });

  it('未配置系统助手时 503', async () => {
    delete process.env.OS_HELPER_URL;
    app = Fastify();
    await app.register(systemTimeRoutes);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/system-time' });
    expect(res.statusCode).toBe(503);
  });

  it('GET 返回设备时间状态', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/system-time' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 0, data: time });
  });

  it('PUT 校时：转发 epoch_ms，返回重启了哪些服务', async () => {
    await boot(() => [200, { ok: true, time, restarted: ['录像服务', 'AI 识别服务'] }]);
    const res = await app.inject({ method: 'PUT', url: '/system-time', payload: { epochMs: 1791600000000 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.restarted).toEqual(['录像服务', 'AI 识别服务']);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/system/time' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ epoch_ms: 1791600000000 });
  });

  it.each([[{}], [{ epochMs: 'x' }], [{ epochMs: 1.5 }], [{ epochMs: 1791600000000, extra: 1 }]])(
    'PUT 校时参数不合法 400 且不转发 %j', async (payload) => {
      await boot();
      const res = await app.inject({ method: 'PUT', url: '/system-time', payload });
      expect(res.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });

  it('系统助手拒绝（超出范围）时 400 并透传原因', async () => {
    await boot(() => [400, { ok: false, error: '时间必须在 2026-01-01 到 2100-01-01 之间' }]);
    const res = await app.inject({ method: 'PUT', url: '/system-time', payload: { epochMs: 1767225600000 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('2026-01-01');
  });

  it('系统助手内部错误时 503，且不把内部组件名透给页面', async () => {
    await boot(() => [500, {}]);
    const res = await app.inject({ method: 'PUT', url: '/system-time', payload: { epochMs: 1791600000000 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).not.toMatch(/os-helper/i);
  });

  it('系统助手不可达时 503（不是参数错误）', async () => {
    await boot();
    await mock!.close();
    mock = null;
    for (const [method, url, payload] of [['PUT', '/system-time', { epochMs: 1791600000000 }],
      ['PUT', '/system-time/ntp-servers', { servers: [] }], ['GET', '/system-time', undefined]] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).not.toMatch(/os-helper|fetch failed|ECONNREFUSED/i);
    }
  });

  it('PUT 对时服务器：转发 servers', async () => {
    await boot();
    const res = await app.inject({ method: 'PUT', url: '/system-time/ntp-servers', payload: { servers: ['192.168.0.1'] } });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/system/ntp' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ servers: ['192.168.0.1'] });
  });

  it('对时服务器参数类型不对 400 且不转发', async () => {
    await boot();
    const res = await app.inject({ method: 'PUT', url: '/system-time/ntp-servers', payload: { servers: 'a' } });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
