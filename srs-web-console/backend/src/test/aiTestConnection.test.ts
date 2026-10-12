import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

/** 起一个最小假 ai-service，只关心 /health 端点的行为 */
function startMockHealth(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('POST /api/ai-test-connection', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let mock: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-aitest-'));
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    await app?.close();
    await mock?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('连通且鉴权通过：ok=true 并带上 health 内容', async () => {
    mock = await startMockHealth((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.1.0' }));
    });
    app = await buildApp({ dataDir: tmpDir });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-test-connection',
      payload: { baseUrl: mock.url },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.ok).toBe(true);
    expect(body.data.health.status).toBe('ok');
  });

  it('body 未传时测的是已保存的 settings.aiService，不是要求每次都传', async () => {
    mock = await startMockHealth((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    app = await buildApp({ dataDir: tmpDir });
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { aiService: { baseUrl: mock.url } },
    });

    const res = await app.inject({ method: 'POST', url: '/api/ai-test-connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
  });

  it('401：如实报告 unauthorized，不混同"不可达"', async () => {
    mock = await startMockHealth((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    app = await buildApp({ dataDir: tmpDir });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-test-connection',
      payload: { baseUrl: mock.url, apiKey: 'wrong' },
    });
    expect(res.statusCode).toBe(200); // 探测本身成功，结论装在 body 里
    expect(res.json().data).toEqual({ ok: false, reason: 'unauthorized', message: 'API Key 无效' });
  });

  it('目标不可达：如实报告 unreachable', async () => {
    app = await buildApp({ dataDir: tmpDir });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-test-connection',
      payload: { baseUrl: 'http://127.0.0.1:1' },
    });
    expect(res.json().data.reason).toBe('unreachable');
  });

  it('body 传的候选值优先于已保存的 settings——"先测后存"向导场景', async () => {
    mock = await startMockHealth((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    app = await buildApp({ dataDir: tmpDir, aiServiceBaseUrl: 'http://127.0.0.1:1' });
    // 不保存，直接传候选值——不应该被进程默认的不可达地址污染
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-test-connection',
      payload: { baseUrl: mock.url },
    });
    expect(res.json().data.ok).toBe(true);
  });
});
