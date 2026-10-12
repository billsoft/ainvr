import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './buildTestApp.js';

describe('Phase 5: System API (summary / settings / import-export / password)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-test-'));
    process.env.NODE_ENV = 'test';
    app = await buildApp({
      dataDir: tmpDir,
      srsApiHost: '127.0.0.1:19859', // 不存在的端口，SRS 会降级
      corsOrigin: true,
    });
  });

  afterEach(async () => {
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.NODE_ENV;
  });

  // ---- Summary ----
  describe('GET /api/summary', () => {
    it('返回结构正确（SRS 离线场景）', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/summary' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.code).toBe(0);
      expect(body.data.srsOnline).toBe(false);
      expect(body.data.srsVersion).toBeDefined();
      // SRS 离线读不到实时版本：不能声称支持 H.265 WebRTC（前端据此不硬走 WebRTC，设计 §8.2）
      expect(body.data.srsVersionLive).toBe(false);
      expect(body.data.srsRtcHevc).toBe(false);
      expect(body.data.serverTime).toBeGreaterThan(0);
      expect(body.data.channels).toEqual({ total: 0, online: 0, offline: 0 });
      expect(body.data.streams).toMatchObject({
        total: 0,
        online: 0,
        totalClients: 0,
        totalBitrateKbps: 0,
      });
    });

    it('有通道后统计正确', async () => {
      // 创建 2 条通道
      await app.inject({
        method: 'POST', url: '/api/channels',
        payload: { name: 'c1', upstreamProtocol: 'rtmp', streamName: 's1', downstreamProtocols: ['flv'] },
      });
      await app.inject({
        method: 'POST', url: '/api/channels',
        payload: { name: 'c2', upstreamProtocol: 'srt', streamName: 's2', downstreamProtocols: ['hls'] },
      });

      const res = await app.inject({ method: 'GET', url: '/api/summary' });
      const body = res.json();
      expect(body.data.channels.total).toBe(2);
      expect(body.data.channels.online).toBe(0); // SRS 离线
      expect(body.data.channels.offline).toBe(2);
    });
  });

  // ---- Settings 安全 ----
  describe('GET /api/settings', () => {
    it('不返回 adminPasswordHash，返回 adminPasswordSet', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.code).toBe(0);
      expect(body.data.adminPasswordHash).toBeUndefined();
      expect(body.data.adminPasswordSet).toBe(false);
      expect(body.data.pollIntervalMs).toBeDefined();
      expect(body.data.srsApiHost).toBeDefined();
      expect(body.data.srsVersion).toBeDefined();
    });
  });

  // ---- 密码设置 ----
  describe('PUT /api/settings/password', () => {
    it('设置密码后 adminPasswordSet 变为 true，且鉴权立即生效（同一请求内新密码即可登录）', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/password',
        payload: { password: 'test123' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.adminPasswordSet).toBe(true);

      // 不带 token 的请求现在应该被拦截（鉴权已生效）
      const unauthedRes = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(unauthedRes.statusCode).toBe(401);

      // 用刚设置的新密码登录，验证 passwordCache.invalidate() 没有留窗口期
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'test123' },
      });
      expect(loginRes.statusCode).toBe(200);
      const token = loginRes.json().data.token as string;
      expect(token).toBeTruthy();

      // 带 token 的 GET 验证
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { 'x-console-token': token },
      });
      expect(getRes.json().data.adminPasswordSet).toBe(true);
      expect(getRes.json().data.adminPasswordHash).toBeUndefined();
    });

    it('空密码 = 关闭鉴权（默认不启用访问密码），返回 200 且 adminPasswordSet=false', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/password',
        payload: { password: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ adminPasswordSet: false });
    });
  });

  // ---- 导入导出 ----
  describe('Export / Import', () => {
    beforeEach(async () => {
      // 先建 2 条数据
      await app.inject({
        method: 'POST', url: '/api/channels',
        payload: { name: 'exp1', upstreamProtocol: 'rtmp', streamName: 'exp1', downstreamProtocols: ['flv'] },
      });
      await app.inject({
        method: 'POST', url: '/api/channels',
        payload: { name: 'exp2', upstreamProtocol: 'srt', streamName: 'exp2', downstreamProtocols: ['hls'] },
      });
    });

    it('导出包含 channels 和 settings，不含密码', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/export' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.version).toBe(1);
      expect(body.data.exportedAt).toBeDefined();
      expect(body.data.channels).toHaveLength(2);
      expect(body.data.settings).toBeDefined();
      expect(body.data.settings.adminPasswordHash).toBeUndefined();
      expect(body.data.settings.adminPassword).toBeUndefined();
      expect(body.data.settings.srsApiHost).toBeDefined();
      expect(body.data.settings.pollIntervalMs).toBeDefined();

      // 通道字段完整
      expect(body.data.channels[0].id).toBeDefined();
      expect(body.data.channels[0].name).toBe('exp1');
      expect(body.data.channels[0].streamName).toBe('exp1');
    });

    it('overwrite 导入覆盖现有数据', async () => {
      // 先导出
      const expRes = await app.inject({ method: 'GET', url: '/api/export' });
      const exportData = expRes.json().data;

      // 修改一条
      exportData.channels[0].name = 'imported_name';
      exportData.channels.push({
        id: '11111111-1111-1111-1111-111111111111',
        name: 'new_ch',
        upstreamProtocol: 'webrtc',
        streamName: 'newch',
        downstreamProtocols: ['flv', 'webrtc'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const impRes = await app.inject({
        method: 'POST', url: '/api/import',
        payload: { mode: 'overwrite', data: exportData },
      });
      expect(impRes.statusCode).toBe(200);
      expect(impRes.json().data.mode).toBe('overwrite');
      expect(impRes.json().data.channelCount).toBe(3);

      // 验证列表
      const listRes = await app.inject({ method: 'GET', url: '/api/channels' });
      expect(listRes.json().data).toHaveLength(3);
      expect(listRes.json().data[0].name).toBe('imported_name');
    });

    it('merge 导入按 id 合并不删除原有', async () => {
      // 导出 + 加一条新的
      const expRes = await app.inject({ method: 'GET', url: '/api/export' });
      const exportData = expRes.json().data;

      exportData.channels = [{
        id: '22222222-2222-2222-2222-222222222222',
        name: 'merged_ch',
        upstreamProtocol: 'rtsp',
        streamName: 'merged',
        downstreamProtocols: ['hls'],
        rtspUrl: 'rtsp://example.com/stream',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }];

      const impRes = await app.inject({
        method: 'POST', url: '/api/import',
        payload: { mode: 'merge', data: exportData },
      });
      expect(impRes.statusCode).toBe(200);
      expect(impRes.json().data.mode).toBe('merge');
      expect(impRes.json().data.channelCount).toBe(3); // 原有 2 + 新增 1

      const listRes = await app.inject({ method: 'GET', url: '/api/channels' });
      expect(listRes.json().data).toHaveLength(3);
    });

    it('导入格式错误返回 400', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/import',
        payload: { mode: 'overwrite', data: { channels: 'not_an_array' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('overwrite 模式导入内部有重复 streamName 时 400', async () => {
      const badData = {
        channels: [
          { id: 'a'.repeat(8) + '-' + '1111-1111-1111-' + '1'.repeat(12), name: 'a', upstreamProtocol: 'rtmp', streamName: 'dup', downstreamProtocols: ['flv'], createdAt: 1, updatedAt: 1 },
          { id: 'b'.repeat(8) + '-' + '1111-1111-1111-' + '1'.repeat(12), name: 'b', upstreamProtocol: 'rtmp', streamName: 'dup', downstreamProtocols: ['flv'], createdAt: 1, updatedAt: 1 },
        ],
      };
      const res = await app.inject({
        method: 'POST', url: '/api/import',
        payload: { mode: 'overwrite', data: badData },
      });
      expect(res.statusCode).toBe(400);
    });

    it('导入的设置白名单内字段生效，密码不导入', async () => {
      const data = {
        channels: [],
        settings: {
          pollIntervalMs: 3000,
          monitorSoftLimit: 4,
          srsApiHost: '10.0.0.1:1985',
          adminPasswordHash: 'should_not_be_imported',
        },
      };

      // 先设密码（会让后续请求需要带 token，鉴权中间件生效）
      await app.inject({ method: 'PUT', url: '/api/settings/password', payload: { password: 'before' } });
      const loginRes = await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { password: 'before' },
      });
      const token = loginRes.json().data.token as string;

      await app.inject({
        method: 'POST', url: '/api/import',
        headers: { 'x-console-token': token },
        payload: { mode: 'merge', data },
      });

      const res = await app.inject({
        method: 'GET', url: '/api/settings',
        headers: { 'x-console-token': token },
      });
      const s = res.json().data;
      // 白名单内
      expect(s.pollIntervalMs).toBe(3000);
      expect(s.monitorSoftLimit).toBe(4);
      expect(s.srsApiHost).toBe('10.0.0.1:1985');
      // 密码不被覆盖（仍为设置后的 true）
      expect(s.adminPasswordSet).toBe(true);
    });

    it('回归：merge 模式合并后跟库里现有通道 streamName 冲突时 400，不落盘', async () => {
      const createRes = await app.inject({
        method: 'POST', url: '/api/channels',
        payload: { name: '已存在', upstreamProtocol: 'rtmp', streamName: 'taken', downstreamProtocols: ['flv'] },
      });
      const existingId = createRes.json().data.id as string;
      const importedId = 'c'.repeat(8) + '-' + '1111-1111-1111-' + '1'.repeat(12);

      const res = await app.inject({
        method: 'POST', url: '/api/import',
        payload: {
          mode: 'merge',
          data: {
            channels: [{
              id: importedId,
              name: '导入的新通道', upstreamProtocol: 'rtmp', streamName: 'taken',
              downstreamProtocols: ['flv'], createdAt: 1, updatedAt: 1,
            }],
          },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('taken');

      // 拒绝必须是"整体不落盘"，不是"落了一半"——导入的这条不应该出现，
      // 原有那条也不应该被顶掉或改名（不断言绝对总数，避免跟其它用例
      // 共享测试环境时的通道计数耦合，只断言这次导入本身的效果）。
      const listRes = await app.inject({ method: 'GET', url: '/api/channels' });
      const ids = listRes.json().data.map((c: any) => c.id);
      expect(ids).not.toContain(importedId);
      expect(ids).toContain(existingId);
      expect(listRes.json().data.find((c: any) => c.id === existingId).streamName).toBe('taken');
    });

    it('回归：导入的 settings 字段类型不合法时 400，不静默写入（此前 settings 是 z.record(z.any()) 完全不校验）', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/import',
        payload: { mode: 'merge', data: { channels: [], settings: { srsApiHost: 12345 } } },
      });
      expect(res.statusCode).toBe(400);

      const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(settingsRes.json().data.srsApiHost).not.toBe(12345);
    });
  });

  // 2026-09-17：rtcCandidateIp 已从 PUT /api/settings 移除（唯一归属是
  // srs/system/settings 文档 + SrsConfigAdapter，见 store/srsAdapter.test.ts
  // 里对应的校验/写入测试）——这里原本的 describe 块整体删除，不留一个测的
  // 是已经不存在的行为。

  // ---- GET /api/health 分级 ----
  describe('GET /api/health', () => {
    it('未配置 AI 微服务时，只看 SRS 状态；未配置不计入整体降级判定', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.aiService.configured).toBe(false);
      expect(data.aiService.reachable).toBeNull();
      expect(data.srs).toEqual({ online: false }); // 测试用的是不存在的 SRS 端口
      // SRS 本就离线，这里符合预期是 degraded；关键是不因为"根本没配置"的 AI 服务被牵连出别的判定
      expect(data.status).toBe('degraded');
    });

    it('回归：配置了 AI 微服务但探测不可达时，整体状态降级为 degraded（此前无论下游死活都硬编码返回 ok）', async () => {
      await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { aiService: { baseUrl: 'http://127.0.0.1:19' } }, // 不存在的端口
      });
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      const data = res.json().data;
      expect(data.aiService.configured).toBe(true);
      expect(data.aiService.reachable).toBe(false);
      expect(data.status).toBe('degraded');
    });
  });
});
