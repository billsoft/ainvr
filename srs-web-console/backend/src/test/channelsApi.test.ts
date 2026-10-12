import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

// 用 mock SRS 客户端（替换真实 HTTP 调用）
// 方案：先不用 mock，用 fastify.inject 测 CRUD 流程，SRS 状态部分会返回 srsOnline=false（因为测试环境 SRS 不一定在）
// 但我们可以测通道 CRUD 的完整流程

describe('Channels API (集成测试)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-'));
    process.env.NODE_ENV = 'test';
    app = await buildApp({
      dataDir: tmpDir,
      srsApiHost: '127.0.0.1:19859', // 用一个不存在的端口，SRS 会降级
      corsOrigin: true,
    });
  });

  afterEach(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('rejects RTSP while the pull worker and encrypted credential store are unavailable', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/channels', payload: {
      name: 'camera', upstreamProtocol: 'rtsp', rtspUrl: 'rtsp://camera/live', downstreamProtocols: ['webrtc'],
    } });
    expect(response.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/channels' })).json().data).toHaveLength(0);
  });

  // ---- 基础 CRUD ----

  it('GET /api/channels 初始返回空数组', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it('POST /api/channels 创建通道（必填字段）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '测试通道1',
        upstreamProtocol: 'rtmp',
        downstreamProtocols: ['flv', 'hls'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.name).toBe('测试通道1');
    expect(body.data.upstreamProtocol).toBe('rtmp');
    expect(body.data.downstreamProtocols).toEqual(['flv', 'hls']);
    expect(body.data.id).toBeDefined();
    // 从名称派生，格式为 <name_simplified>_<hex_suffix>
    expect(body.data.streamName).toMatch(/_[a-f0-9]{6}$/);
    expect(body.data.createdAt).toBeGreaterThan(0);
    expect(body.data.status).toBeDefined();
    expect(body.data.status.srsOnline).toBe(false); // SRS 不在
    expect(body.data.urls).toBeDefined();
    expect(body.data.urls.play.flv).toContain('.flv');
    expect(body.data.urls.push.rtmp).toContain('rtmp://');
  });

  it('POST /api/channels 空名称返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '',
        upstreamProtocol: 'rtmp',
        downstreamProtocols: ['flv'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(400);
  });

  it('POST /api/channels 缺失协议返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: { name: 'test', upstreamProtocol: 'rtmp' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/channels streamName 重复返回 409', async () => {
    // 第一个用指定 streamName
    await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '通道1',
        upstreamProtocol: 'rtmp',
        streamName: 'dup_stream',
        downstreamProtocols: ['flv'],
      },
    });

    // 第二个用相同 streamName
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '通道2',
        upstreamProtocol: 'rtmp',
        streamName: 'dup_stream',
        downstreamProtocols: ['flv'],
      },
    });

    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe(409);
  });

  it('GET /api/channels/:id 详情', async () => {
    // 先创建
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '详情测试',
        upstreamProtocol: 'rtmp',
        downstreamProtocols: ['flv', 'webrtc'],
      },
    });
    const id = createRes.json().data.id;

    // 再查详情
    const res = await app.inject({ method: 'GET', url: `/api/channels/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.name).toBe('详情测试');
    expect(body.data.urls.play.flv).toBeTruthy();
    expect(body.data.urls.play.webrtc).toBeTruthy();
  });

  it('GET /api/channels/:id 不存在返回 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/channels/:id 更新名称和协议', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '旧名称',
        upstreamProtocol: 'rtmp',
        downstreamProtocols: ['flv'],
      },
    });
    const id = createRes.json().data.id;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${id}`,
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '新名称',
        downstreamProtocols: ['flv', 'hls', 'webrtc'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.name).toBe('新名称');
    expect(body.data.downstreamProtocols).toHaveLength(3);
    expect(body.data.updatedAt).toBeGreaterThan(body.data.createdAt);
  });

  it('DELETE /api/channels/:id 删除', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '要删的',
        upstreamProtocol: 'rtmp',
        downstreamProtocols: ['flv'],
      },
    });
    const id = createRes.json().data.id;

    const delRes = await app.inject({ method: 'DELETE', url: `/api/channels/${id}` });
    expect(delRes.statusCode).toBe(204);

    const getRes = await app.inject({ method: 'GET', url: `/api/channels/${id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('DELETE /api/channels/:id 不存在返回 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/channels/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('创建多个通道后列表有多个', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/channels',
        headers: { 'Content-Type': 'application/json' },
        payload: {
          name: `通道${i}`,
          upstreamProtocol: 'rtmp',
          downstreamProtocols: ['flv'],
        },
      });
    }

    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(3);
  });

  // ---- 数据持久化验证 ----

  it('重启后数据仍然存在（JSON 文件持久化）', async () => {
    // 创建
    await app.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        name: '持久化测试',
        upstreamProtocol: 'srt',
        downstreamProtocols: ['flv', 'hls'],
      },
    });

    // 关闭应用
    await app.close();

    // 重新启动（同一个 dataDir）
    const app2 = await buildApp({
      dataDir: tmpDir,
      srsApiHost: '127.0.0.1:19859',
      corsOrigin: true,
    });

    try {
      const res = await app2.inject({ method: 'GET', url: '/api/channels' });
      expect(res.json().data).toHaveLength(1);
      expect(res.json().data[0].name).toBe('持久化测试');
    } finally {
      await app2.close();
    }
  });
});
