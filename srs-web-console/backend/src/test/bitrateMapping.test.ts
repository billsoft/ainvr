import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

// 回归测试：SRS 真实 /api/v1/streams/ 返回的是嵌套 kbps.{recv_30s,send_30s}，
// 不是曾经错写的扁平 kb_ps —— 这个字段名 bug 此前没有任何测试覆盖，导致码率
// 全线失效（通道列表/详情/仪表盘总码率+趋势图）在生产环境跑了很久都没被测出来。
// 这里起一个最小的假 SRS HTTP 服务器，喂真实响应形状，验证映射链路。
describe('码率字段映射（回归：kb_ps → kbps.recv_30s）', () => {
  let fakeSrs: http.Server;
  let srsApiHost: string;
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    fakeSrs = http.createServer((req, res) => {
      if (req.url === '/api/v1/streams/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          server: 'test',
          service: 'test',
          pid: '1',
          streams: [
            {
              name: 'cam1',
              app: 'live',
              publish: { active: true },
              clients: 2,
              // 真实 SRS 6.0.191 的形状：嵌套对象，不是扁平数字
              kbps: { recv_30s: 4321, send_30s: 99 },
              // 已实测确认真实 SRS 响应带这个字段（curl 验证过 codec="H264"）
              video: { codec: 'H264', profile: 'High', level: '4', width: 1920, height: 960 },
            },
          ],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => fakeSrs.listen(0, '127.0.0.1', resolve));
    const { port } = fakeSrs.address() as AddressInfo;
    srsApiHost = `127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => fakeSrs.close(() => resolve()));
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-bitrate-'));
    process.env.NODE_ENV = 'test';
    app = await buildApp({ dataDir: tmpDir, srsApiHost, corsOrigin: true });
  });

  afterEach(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  it('单通道 bitrate 取 recv_30s（入向推流码率），不是 send_30s', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: {
        name: '摄像头1',
        upstreamProtocol: 'rtmp',
        streamName: 'cam1',
        downstreamProtocols: ['flv'],
      },
    });
    expect(createRes.json().data.status.online).toBe(true);
    expect(createRes.json().data.status.bitrate).toBe(4321);

    const listRes = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(listRes.json().data[0].status.bitrate).toBe(4321);
  });

  it('/api/summary 的 totalBitrateKbps 按 recv_30s 求和，口径与单通道一致', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: {
        name: '摄像头1',
        upstreamProtocol: 'rtmp',
        streamName: 'cam1',
        downstreamProtocols: ['flv'],
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/summary' });
    expect(res.json().data.streams.totalBitrateKbps).toBe(4321);
  });

  it('per-channel 自定义 app 也能正确匹配 SRS 流（mergeStatus 按 channel.app 而非固定 defaultApp 匹配）', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: {
        name: '自定义应用名摄像头',
        upstreamProtocol: 'rtmp',
        streamName: 'cam1',
        app: 'live', // 与假 SRS 流的 app 一致；显式传递验证 per-channel app 生效
        downstreamProtocols: ['flv'],
      },
    });
    expect(createRes.json().data.app).toBe('live');
    expect(createRes.json().data.status.online).toBe(true);
    expect(createRes.json().data.status.bitrate).toBe(4321);
  });

  it('videoCodec 从 SRS 的 video.codec 透传进 ChannelStatus（此前完全没有透传，AI 通道源流选择要用）', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: {
        name: '摄像头1',
        upstreamProtocol: 'rtmp',
        streamName: 'cam1',
        downstreamProtocols: ['flv'],
      },
    });
    expect(createRes.json().data.status.videoCodec).toBe('H264');
  });

  it('level（SRS 实测是字符串 "5.1"）与分辨率一并透传——前端按码流真实参数判定能否播放 H.265', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/channels',
      payload: { name: '摄像头2', upstreamProtocol: 'rtmp', streamName: 'cam1', downstreamProtocols: ['flv'] },
    });
    const status = createRes.json().data.status;
    expect(status.videoLevel).toBe('4');
    expect(status.videoWidth).toBe(1920);
    expect(status.videoHeight).toBe(960);
  });
});
