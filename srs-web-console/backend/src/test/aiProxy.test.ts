import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

/** 起一个最小的假 ai-service，记录收到的请求，供断言转发是否正确 */
function startMockAiService(
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

describe('AI 微服务反向代理（具名路由）', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let mock: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-aiproxy-'));
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('GET /api/ai/health 转发到 ai-service 无前缀的 /health（专门的豁免鉴权探活端点）', async () => {
    mock = await startMockAiService((req, res) => {
      expect(req.url).toBe('/health');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('POST /api/ai/channels 转发到 ai-service 真实的 /api/v1/channels，透传 body/query', async () => {
    let received: { method?: string; url?: string; body?: string } = {};
    mock = await startMockAiService((req, res, body) => {
      received = { method: req.method, url: req.url, body };
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cam99' }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/channels?dry_run=1',
      payload: { id: 'cam99', stream: { url: 'rtmp://x/live/y' } },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'cam99' });
    expect(received.method).toBe('POST');
    // 这条路由曾经是通配 fastify.all('/ai/*') 靠拼字符串猜路径，会把
    // 干净路径 /api/ai/channels 转发成不存在的 /api/channels——具名路由
    // 直接声明真实目标，不再靠猜。
    expect(received.url).toBe('/api/v1/channels?dry_run=1');
    expect(JSON.parse(received.body!)).toEqual({
      id: 'cam99', stream: { url: 'rtmp://x/live/y' },
    });
  });

  it('GET /api/ai/channels/:id 转发到 /api/v1/channels/{id}', async () => {
    let receivedUrl: string | undefined;
    mock = await startMockAiService((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cam01' }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    const res = await app.inject({ method: 'GET', url: '/api/ai/channels/cam01' });
    expect(res.statusCode).toBe(200);
    expect(receivedUrl).toBe('/api/v1/channels/cam01');
  });

  it('PUT /api/ai/channels/:id/config 转发到 /api/v1/channels/{id}/config，超时放宽到 15s', async () => {
    mock = await startMockAiService((req, res, body) => {
      expect(req.url).toBe('/api/v1/channels/cam01/config');
      expect(JSON.parse(body)).toEqual({ inference_fps: 8 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ applied: true }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/ai/channels/cam01/config',
      payload: { inference_fps: 8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true });
  });

  it('PUT config 在 8s~15s 之间回应也算成功（默认路由用的是放宽后的 15s，不是通用的 8s）', async () => {
    mock = await startMockAiService((req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ applied: true }));
        } catch { /* 已断开忽略 */ }
      }, 200); // 测试用短延迟代表"比通用 8s 超时更久才回应"的场景，不真的等 9s
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url, aiProxyTimeoutMs: 100 });
    // 上面把"通用超时"故意设成 100ms（比 200ms 延迟短）；如果 PUT config
    // 路由没有走独立的 15s 超时、而是复用了这个被调小的通用超时，这个用例会失败。

    const res = await app.inject({
      method: 'PUT',
      url: '/api/ai/channels/cam01/config',
      payload: { inference_fps: 8 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('自定义请求头（如 X-API-Key）会被转发给 ai-service', async () => {
    let receivedKey: string | undefined;
    mock = await startMockAiService((req, res) => {
      receivedKey = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    await app.inject({
      method: 'POST',
      url: '/api/ai/channels/cam01/start',
      headers: { 'x-api-key': 'secret-123' },
    });
    expect(receivedKey).toBe('secret-123');
  });

  it('DELETE 请求（无 body）正常透传', async () => {
    mock = await startMockAiService((req, res) => {
      expect(req.method).toBe('DELETE');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    const res = await app.inject({ method: 'DELETE', url: '/api/ai/channels/cam01' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });

  it('ai-service 不可达时返回 502，不是让请求挂起或 500', async () => {
    // 故意指向一个没有监听的端口
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: 'http://127.0.0.1:1' });

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('不可达');
  });

  it('settings.aiService.baseUrl 一经保存立即覆盖 fallback，不需要重启进程', async () => {
    let hit: { url?: string } = {};
    mock = await startMockAiService((req, res) => {
      hit = { url: req.url };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    // buildApp 时故意指向一个打不通的地址，模拟"进程启动时还没配置"
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: 'http://127.0.0.1:1' });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { aiService: { baseUrl: mock.url } },
    });
    expect(put.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(200);
    expect(hit.url).toBe('/health');
  });

  it('settings.aiService.apiKey 已配置且调用方未带 X-API-Key 时自动注入', async () => {
    let receivedKey: string | undefined;
    mock = await startMockAiService((req, res) => {
      receivedKey = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { aiService: { apiKey: 'console-stored-key' } },
    });

    await app.inject({ method: 'POST', url: '/api/ai/channels/cam01/start' }); // 不带 x-api-key
    expect(receivedKey).toBe('console-stored-key');
  });

  it('调用方自带 X-API-Key 时优先于 console 保存的那把（不覆盖）', async () => {
    let receivedKey: string | undefined;
    mock = await startMockAiService((req, res) => {
      receivedKey = req.headers['x-api-key'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { aiService: { apiKey: 'console-stored-key' } },
    });

    await app.inject({
      method: 'POST',
      url: '/api/ai/channels/cam01/start',
      headers: { 'x-api-key': 'caller-own-key' },
    });
    expect(receivedKey).toBe('caller-own-key');
  });

  it('ai-service 响应超时时返回 502 且明确提示超时（不是"不可达"文案）', async () => {
    mock = await startMockAiService((_req, res) => {
      // 故意不回应，让它超过下面配置的极短超时；测试结束时 mock.close()
      // 会强制断开，未完成的这个 setTimeout 不会拖住进程退出。
      setTimeout(() => {
        try { res.end('{}'); } catch { /* 连接可能已经被客户端放弃 */ }
      }, 1000);
    });
    app = await buildApp({
      dataDir: tmpDir,
      aiServiceBaseUrl: mock.url,
      aiProxyTimeoutMs: 100,
    });

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('超时');
  });

  it('GET /api/ai/streams 不转发到 ai-service，SRS 不可达时优雅降级为空列表', async () => {
    app = await buildApp({ dataDir: tmpDir, srsApiHost: '127.0.0.1:1' });

    const res = await app.inject({ method: 'GET', url: '/api/ai/streams' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ streams: [] });
  });

  it('GET /api/ai/streams 聚合真实 SRS 数据，H.264 不触发 h265', async () => {
    const fakeSrs = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        streams: [{
          name: 'cam1', app: 'live', publish: { active: true }, clients: 3,
          kbps: { recv_30s: 2048 },
          video: { codec: 'H264', level: '4', width: 1920, height: 1080 },
        }],
      }));
    });
    await new Promise<void>((resolve) => fakeSrs.listen(0, '127.0.0.1', resolve));
    const { port } = fakeSrs.address() as AddressInfo;

    app = await buildApp({ dataDir: tmpDir, srsApiHost: `127.0.0.1:${port}` });
    const res = await app.inject({ method: 'GET', url: '/api/ai/streams' });
    expect(res.json()).toEqual({
      streams: [{
        app: 'live', name: 'cam1', clients: 3, bitrateKbps: 2048, videoCodec: 'H264',
        videoLevel: '4', videoWidth: 1920, videoHeight: 1080, h265: false,
      }],
    });

    await new Promise<void>((resolve) => fakeSrs.close(() => resolve()));
  });

  it('GET /api/ai/streams 源为 H.265 时 h265=true（不区分大小写匹配 HEVC/H265）', async () => {
    const fakeSrs = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        streams: [{
          name: 'cam2', app: 'live', publish: { active: true }, clients: 0,
          video: { codec: 'HEVC' },
        }],
      }));
    });
    await new Promise<void>((resolve) => fakeSrs.listen(0, '127.0.0.1', resolve));
    const { port } = fakeSrs.address() as AddressInfo;

    app = await buildApp({ dataDir: tmpDir, srsApiHost: `127.0.0.1:${port}` });
    const res = await app.inject({ method: 'GET', url: '/api/ai/streams' });
    expect(res.json().streams[0].h265).toBe(true);

    await new Promise<void>((resolve) => fakeSrs.close(() => resolve()));
  });

  it('forwards analytics event history including the query limit', async () => {
    let receivedUrl: string | undefined;
    mock = await startMockAiService((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ channel_id: 'cam01', events: [] }));
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });
    const res = await app.inject({ method: 'GET', url: '/api/ai/channels/cam01/analytics/events?limit=100' });
    expect(res.statusCode).toBe(200);
    expect(receivedUrl).toBe('/api/v1/channels/cam01/analytics/events?limit=100');
    expect(res.json().events).toEqual([]);
  });

  describe('识别快照归档（"识别历史"页面）转发', () => {
    it('GET /api/ai/channels/:id/snapshots/overview 转发到 .../snapshots/overview', async () => {
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: true, count: 3 }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({ method: 'GET', url: '/api/ai/channels/cam01/snapshots/overview' });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots/overview');
      expect(res.json()).toEqual({ enabled: true, count: 3 });
    });

    it('GET /api/ai/channels/:id/snapshots 透传 cursor/limit 查询参数', async () => {
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], next_cursor: null }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/channels/cam01/snapshots?cursor=abc123&limit=20',
      });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots?cursor=abc123&limit=20');
    });

    it('GET /api/ai/channels/:id/snapshots/:imageId/image 原样透传二进制 JPEG（不是 JSON 解析）', async () => {
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // 最小合法 JPEG 头尾标记
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(jpegBytes);
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/channels/cam01/snapshots/img-1/image',
      });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots/img-1/image');
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.rawPayload).toEqual(jpegBytes);
    });

    it('GET 图片 404 时干净透传 404（不是包装成 502）', async () => {
      mock = await startMockAiService((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found', message: '图片不存在' } }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/channels/cam01/snapshots/img-gone/image',
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/ai/channels/:id/snapshots/:imageId 转发到单条删除路径', async () => {
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ image_id: 'img-1', deleted: true }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ai/channels/cam01/snapshots/img-1',
      });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots/img-1');
    });

    it('DELETE /api/ai/channels/:id/snapshots 透传 from_ts/to_ts（范围删除）', async () => {
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted_count: 5 }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/ai/channels/cam01/snapshots?from_ts=100&to_ts=200',
      });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots?from_ts=100&to_ts=200');
      expect(res.json()).toEqual({ deleted_count: 5 });
    });

    it('DELETE /api/ai/channels/:id/snapshots 不带参数时转发为清空全部', async () => {
      let receivedUrl: string | undefined;
      mock = await startMockAiService((req, res) => {
        receivedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted_count: 100 }));
      });
      app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: mock.url });

      const res = await app.inject({ method: 'DELETE', url: '/api/ai/channels/cam01/snapshots' });
      expect(res.statusCode).toBe(200);
      expect(receivedUrl).toBe('/api/v1/channels/cam01/snapshots');
    });
  });
});
