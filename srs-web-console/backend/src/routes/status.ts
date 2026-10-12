import { z } from 'zod';
import { FastifyInstance } from 'fastify';
import { supportsRtcHevc } from '../services/srsClient.js';
import { JsonStore } from '../store/jsonStore.js';
import { StatusRoutesOptions, AppSettingsSchema, readSettingsFromPgOrFallback } from './settingsShared.js';
export { AppSettingsSchema, readSettingsFromPgOrFallback } from './settingsShared.js';
export type { StatusRoutesOptions } from './settingsShared.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { registerSettingsTransferRoutes } from './settingsTransferRoutes.js';
import { registerRemoteAssistRoutes } from './remoteAssist.js';

export async function statusRoutes(fastify: FastifyInstance, opts: StatusRoutesOptions) {
  const { srsClient, settingsStore, channelService, channelStore, passwordCache, aiServiceFallbackBaseUrl } = opts;
  fastify.get('/summary', async (req, reply) => {
    const [streams, channels, settings, liveVersion] = await Promise.all([
      srsClient.listStreams(),
      channelService.listChannels(),
      settingsStore.read(),
      srsClient.getVersion(),
    ]);

    const srsOnline = await srsClient.isOnline();
    const onlineStreams = streams.filter(s => s.publish?.active);
    const totalClients = streams.reduce((sum, s) => sum + (s.clients || 0), 0);
    // recv_30s：各流入向推流码率求和，口径与 channelService.mergeStatus() 的 per-channel bitrate 一致
    const totalBitrate = streams.reduce((sum, s) => sum + (s.kbps?.recv_30s || 0), 0);

    const onlineChannels = channels.filter(c => c.status.online).length;

    reply.send({
      code: 0,
      data: {
        srsOnline,
        // 优先 SRS 实时版本；读不到才退回设置里的展示值（并标明不是实时的）
        srsVersion: liveVersion ?? (settings.srsVersion || '6.0.191'),
        srsVersionLive: liveVersion !== null,
        // 服务端能否把 RTMP 的 H.265 转成 WebRTC（SRS ≥ 7.0.33）：前端 H.265 播放判定的服务端条件
        srsRtcHevc: supportsRtcHevc(liveVersion),
        serverTime: Date.now(),
        streams: {
          total: streams.length,
          online: onlineStreams.length,
          totalClients,
          totalBitrateKbps: Math.round(totalBitrate),
        },
        channels: {
          total: channels.length,
          online: onlineChannels,
          offline: channels.length - onlineChannels,
        },
      },
    });
  });

  // ============================================================
  // GET /api/status — 详细状态（保留兼容）
  // ============================================================
  fastify.get('/status', async (req, reply) => {
    const streams = await srsClient.listStreams();
    const srsOnline = await srsClient.isOnline();
    const onlineCount = streams.filter(s => s.publish?.active).length;
    const totalClients = streams.reduce((sum, s) => sum + (s.clients || 0), 0);

    reply.send({
      code: 0,
      data: {
        srsOnline,
        streamCount: streams.length,
        onlineStreamCount: onlineCount,
        totalClients,
        srsStreams: streams,
      },
    });
  });

  // ============================================================
  // GET /api/settings — 读取设置（不含密码哈希，返回是否已设置）
  // ============================================================
  // 兼容代理：pgStore 存在时走 PG，否则走 JsonStore（旧路径）
  registerSettingsRoutes(fastify, opts);
  registerSettingsTransferRoutes(fastify, opts);
  // 远程协助的中转服务器修改要复用同一份管理员密码缓存再次验证。
  registerRemoteAssistRoutes(fastify, { passwordCache });
  const TestConnectionSchema = z.object({
    baseUrl: z.string().max(200).optional(),
    apiKey: z.string().max(200).optional(),
  });
  fastify.post('/ai-test-connection', async (req, reply) => {
    const parse = TestConnectionSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      reply.status(400).send({ code: 400, error: '参数错误' });
      return;
    }

    const settings = await settingsStore.read();
    const baseUrl = (parse.data.baseUrl || settings.aiService.baseUrl || aiServiceFallbackBaseUrl)
      .replace(/\/+$/, '');
    const apiKey = parse.data.apiKey !== undefined ? parse.data.apiKey : settings.aiService.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['x-api-key'] = apiKey;
      const resp = await fetch(`${baseUrl}/health`, { headers, signal: controller.signal });

      if (resp.status === 401) {
        reply.send({ code: 0, data: { ok: false, reason: 'unauthorized', message: 'API Key 无效' } });
        return;
      }
      if (!resp.ok) {
        reply.send({
          code: 0,
          data: { ok: false, reason: 'error', message: `ai-service 返回状态码 ${resp.status}` },
        });
        return;
      }
      const health = await resp.json().catch(() => null);
      reply.send({ code: 0, data: { ok: true, health } });
    } catch (e) {
      const timedOut = (e as Error).name === 'AbortError';
      reply.send({
        code: 0,
        data: {
          ok: false,
          reason: timedOut ? 'timeout' : 'unreachable',
          message: timedOut ? 'AI 服务响应超时' : 'AI 服务不可达',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // ============================================================
  // GET /api/health — 健康检查
  // ============================================================
  // 分级返回：此前这个端点只回一个写死的 { status: 'ok' }，完全不检查任何
  // 下游依赖（审计发现）——SRS 和 ai-service 全挂了照样答复 ok。
  // ai-service 只有在管理员显式配置了 baseUrl 时才纳入整体状态判定：
  // 没配置 AI 功能的部署不应该因为一个从没打算用的可选依赖被判定为 degraded。
  fastify.get('/health', async (req, reply) => {
    const settings = await settingsStore.read();
    const srsOnline = await srsClient.isOnline();

    const aiService: { configured: boolean; reachable: boolean | null } = {
      configured: !!settings.aiService.baseUrl,
      reachable: null,
    };
    if (aiService.configured) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const headers: Record<string, string> = {};
        if (settings.aiService.apiKey) headers['x-api-key'] = settings.aiService.apiKey;
        const resp = await fetch(`${settings.aiService.baseUrl.replace(/\/+$/, '')}/health`, {
          headers, signal: controller.signal,
        });
        aiService.reachable = resp.ok;
      } catch {
        aiService.reachable = false;
      } finally {
        clearTimeout(timer);
      }
    }

    const status = srsOnline && aiService.reachable !== false ? 'ok' : 'degraded';
    reply.send({ code: 0, data: { status, time: Date.now(), srs: { online: srsOnline }, aiService } });
  });
}
