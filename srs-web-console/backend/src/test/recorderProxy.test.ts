import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

function startMockRecorder(
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

describe('录像微服务反向代理 recorderProxy', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let mock: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-recproxy-'));
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('GET /api/v1/recorder/health forwards a verified random session', async () => {
    let seenToken = '';
    mock = await startMockRecorder((req, res) => {
      expect(req.url).toBe('/v1/recorder/health');
      seenToken = req.headers['x-console-token'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '1.0.0' }));
    });
    // 预置口令哈希（JsonStore 读磁盘，passwordCache 据此注入 + 鉴权）
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      version: 1,
      data: {
        srsApiHost: '127.0.0.1:1985', srsRtmpHost: '', srsHttpHost: '', srsRtcHost: '',
        srsSrtHost: '', monitorSoftLimit: 6, monitorHardLimit: 9, pollIntervalMs: 5000,
        adminPasswordHash: crypto.createHash('sha256').update('test-password').digest('hex'), srsVersion: '6.0.191',
        aiService: { baseUrl: '', apiKey: '', pollIntervalMs: 5000 },
      },
    }));
    app = await buildApp({ dataDir: tmpDir, recorderServiceBaseUrl: mock.url });
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'test-password'}});
    const token=login.json().data.token;

    const res = await app.inject({
      method: 'GET', url: '/api/v1/recorder/health',
      headers: { 'x-console-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(seenToken).toBe(token);
  });

  it('PUT config 转发 JSON body；segments 透传 query', async () => {
    let received: { method?: string; url?: string; body?: string } = {};
    mock = await startMockRecorder((req, res, body) => {
      received = { method: req.method, url: req.url, body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if ((req.url ?? '').startsWith('/v1/recordings/segments')) {
        res.end(JSON.stringify([{ id: 's1' }]));
      } else {
        res.end(JSON.stringify({ applied: { files: 'restart' } }));
      }
    });
    app = await buildApp({ dataDir: tmpDir, recorderServiceBaseUrl: mock.url });

    const put = await app.inject({
      method: 'PUT', url: '/api/v1/recorder/config',
      payload: { files: { segmentSeconds: 300 } },
    });
    expect(put.statusCode).toBe(410);
    expect(received.method).toBeUndefined();

    const seg = await app.inject({
      method: 'GET',
      url: '/api/v1/recordings/segments?channel=c1&from=1&to=2',
    });
    expect(seg.statusCode).toBe(200);
    expect(seg.json()).toEqual([{ id: 's1' }]);
    expect(received.url).toBe('/v1/recordings/segments?channel=c1&from=1&to=2');
  });

  it('drops（写入不足丢弃区间）透传 query', async () => {
    let received: { url?: string } = {};
    mock = await startMockRecorder((req, res) => {
      received = { url: req.url };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ startTs: 1, endTs: 2, droppedMs: 1, reason: 'backlog' }]));
    });
    app = await buildApp({ dataDir: tmpDir, recorderServiceBaseUrl: mock.url });
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings/drops?channel=c1&from=1&to=2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].reason).toBe('backlog');
    expect(received.url).toBe('/v1/recordings/drops?channel=c1&from=1&to=2');
  });

  it('媒体 play/download 不经 BFF（无此路由 → 404，不打上游）', async () => {
    let upstreamHits = 0;
    mock = await startMockRecorder((req, res) => {
      upstreamHits += 1;
      res.writeHead(200);
      res.end('{}');
    });
    app = await buildApp({ dataDir: tmpDir, recorderServiceBaseUrl: mock.url });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/recordings/seg1/play?token=x',
    });
    expect(res.statusCode).toBe(404);
    expect(upstreamHits).toBe(0);
  });

  it('录像服务不可达 → 502 信封', async () => {
    app = await buildApp({
      dataDir: tmpDir,
      recorderServiceBaseUrl: 'http://127.0.0.1:9',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/recorder/stats' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 502 });
  });
});
