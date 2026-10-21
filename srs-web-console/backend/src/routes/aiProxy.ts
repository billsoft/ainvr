// AI 微服务反向代理 —— console 具名路由转发到 ai-service（C++ HTTP，默认 :8000）
//
// backend 跑在 Docker 容器里，ai-service 目前是跑在宿主机上的裸进程
// （不在 docker-compose 里）——容器内的 127.0.0.1 指向容器自己，够不着
// 宿主机，必须用 host.docker.internal（docker-compose.yml 里给 backend
// 服务配了 extra_hosts: host-gateway，Linux Docker 20.10+ 原生支持，
// 不是只有 Docker Desktop 才有）。
//
// ⚠️ 这里曾经是一条通配 `fastify.all('/ai/*', ...)` 透传，靠拼接
// `api/${wildcard}` 猜目标路径——`/api/ai/channels`（不带 v1，架构文档
// §11.3.1 路由表写的形态）会被拼成 `{baseUrl}/api/channels`，但 ai-service
// 真实路由全部在 `/api/v1/...` 下，这个路径根本不存在，请求 100% 404。
// 现在改成具名路由：每条路由自己声明真实目标路径，不再靠猜。这也把
// ai-service 的可访问面从"整个 API 无差别透传"收窄成"确实会被前端用到
// 的那几条"，虽然这是单机内部运维工具、不是对外网站，安全面不是主因，
// 但具名路由本身就是更诚实的契约，和文档路由表一一对应，不需要读代码
// 才能知道浏览器到底能打到 ai-service 的哪些端点。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { JsonStore } from '../store/jsonStore.js';
import { AppSettings } from '../types/channel.js';
import { SrsClient } from '../services/srsClient.js';
import type { PgConfigStore } from '../store/pgStore.js';

export interface AiProxyOptions {
  /** settings.aiService.baseUrl 未配置（空字符串）时的兜底地址，通常来自 env AI_SERVICE_BASE_URL */
  fallbackBaseUrl: string;
  /** 每次请求都现读——改了 baseUrl/apiKey 立即对下一次代理生效，不需要重启进程 */
  settingsStore: JsonStore<AppSettings>;
  /** /api/ai/streams 用它聚合源流下拉数据，不经 ai-service 转发 */
  srsClient: SrsClient;
  timeoutMs?: number;
  /** PG 配置中心可用时：转发 key 优先读 secret ai-service/server.api_key
   *  （与 AI 服务自身 server.api_key 同一 secret 源，配置中心发布后 10s 内
   *  两侧同步生效），settings.aiService.apiKey 退化为 PG 不可用时的回退 */
  pgStore?: PgConfigStore | null;
}

/** 与 AI 服务共享的 API Key：PG secret ai-service/server.api_key 优先（10s 缓存），
 *  PG 不可用/未设置时回退 settings.aiService.apiKey。避免「配置中心改了 AI 的 key，
 *  但 BFF 代理还拿旧 key 转发」的两侧不一致（2026-09-15 A2 评审确认的闭环缺口）。 */
let aiKeyCache: { value: string | null; at: number } | null = null;
export function invalidateAiKeyCache(): void { aiKeyCache = null; }
export async function resolveAiApiKey(settings: AppSettings, pgStore?: PgConfigStore | null): Promise<string> {
  if (pgStore) {
    const now = Date.now();
    if (!aiKeyCache || now - aiKeyCache.at > 10_000) {
      try {
        const v = await pgStore.getSecret('ai-service/server.api_key');
        aiKeyCache = { value: v, at: now };
      } catch {
        // PG 抖动：沿用旧缓存，下面取不到再回退 settings
      }
    }
    if (aiKeyCache?.value) return aiKeyCache.value;
  }
  return settings.aiService.apiKey || '';
}

// 逐跳（hop-by-hop）头部不能透传：Content-Length 由 fetch 按新 body 重新
// 计算，Host 必须是目标地址而非原始请求的，Connection/Transfer-Encoding
// 这类连接管理头透传会跟 undici 自己的连接管理冲突。
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function filterHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

interface ForwardOptions {
  settingsStore: JsonStore<AppSettings>;
  fallbackBaseUrl: string;
  /** ai-service 上的真实路径（不带前导斜杠），如 "api/v1/channels" 或 "health" */
  targetPath: string;
  timeoutMs: number;
  pgStore?: PgConfigStore | null;
}

/** 具名路由共用的转发逻辑：现读 settings 取 baseUrl/apiKey、过滤 hop-by-hop
 * 头、超时用 AbortController、失败统一包成 502。每条路由只需要声明
 * `targetPath` 是什么，不重复这一整套机制。 */
async function forwardToAiService(req: FastifyRequest, reply: FastifyReply, opts: ForwardOptions) {
  const settings = await opts.settingsStore.read();
  const baseUrl = (settings.aiService.baseUrl || opts.fallbackBaseUrl).replace(/\/+$/, '');
  const rawUrl = req.raw.url ?? '';
  const queryIndex = rawUrl.indexOf('?');
  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
  const targetUrl = `${baseUrl}/${opts.targetPath}${query}`;

  const headers = filterHeaders(
    Object.entries(req.headers).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
  // ai-service 凭据由 console 集中持有（架构 §11.3.1）——浏览器/前端
  // 不会也不该知道真实 API Key，所以正常情况下这里永远是"补上"而不是
  // "覆盖"：只有调用方完全没带 x-api-key 时才注入 console 保存的那把。
  if (!headers['x-api-key']) {
    const key = await resolveAiApiKey(settings, opts.pgStore);
    if (key) headers['x-api-key'] = key;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });

    const respHeaders = filterHeaders(upstream.headers.entries());
    for (const [key, value] of Object.entries(respHeaders)) {
      reply.header(key, value);
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    reply.status(upstream.status).send(buf);
  } catch (e) {
    const timedOut = (e as Error).name === 'AbortError';
    req.log.error(`[ai-proxy] ${req.method} ${targetUrl} 失败: ${(e as Error).message}`);
    reply.status(502).send({
      code: 502,
      error: timedOut ? 'AI 服务响应超时' : 'AI 服务不可达',
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function aiProxyRoutes(fastify: FastifyInstance, opts: AiProxyOptions) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  // These operations may finish remotely even after a proxy deadline. Allow
  // model initialization / archive draining more time than ordinary queries.
  // A timeout is not cancellation; callers must refresh channel state.
  const configTimeoutMs = 15000;
  const stopTimeoutMs = 15000;
  const startTimeoutMs = 35000;

  const fwd = (targetPath: string, timeout = timeoutMs) =>
    (req: FastifyRequest, reply: FastifyReply) =>
      forwardToAiService(req, reply, {
        settingsStore: opts.settingsStore,
        fallbackBaseUrl: opts.fallbackBaseUrl,
        targetPath,
        timeoutMs: timeout,
        pgStore: opts.pgStore,
      });

  const fwdWithId = (suffix: string, timeout = timeoutMs) =>
    (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      return forwardToAiService(req, reply, {
        settingsStore: opts.settingsStore,
        fallbackBaseUrl: opts.fallbackBaseUrl,
        targetPath: `api/v1/channels/${id}${suffix}`,
        timeoutMs: timeout,
        pgStore: opts.pgStore,
      });
    };

  // /health 是 ai-service 专门设计成豁免鉴权的轻量探活端点，没有 /api 前缀
  fastify.get('/ai/health', fwd('health'));

  fastify.get('/ai/channels', fwd('api/v1/channels'));
  fastify.post('/ai/channels', fwd('api/v1/channels'));

  fastify.get('/ai/channels/:id', fwdWithId(''));
  // Stop inference + join the archive writer + acknowledged Mongo drop.
  // If this deadline is exceeded the durable pending entry remains retryable.
  fastify.delete('/ai/channels/:id', fwdWithId('', 25000));

  fastify.put('/ai/channels/:id/config', fwdWithId('/config', configTimeoutMs));

  fastify.post('/ai/channels/:id/start', fwdWithId('/start', startTimeoutMs));
  fastify.post('/ai/channels/:id/stop', fwdWithId('/stop', stopTimeoutMs));

  fastify.get('/ai/channels/:id/analytics/events', fwdWithId('/analytics/events'));
  fastify.get('/ai/channels/:id/results/latest', fwdWithId('/results/latest'));
  // 历史结果（供浏览器端检测框叠加层按时间戳对齐画面用，见 AiDetectionOverlay）；
  // ?limit= 查询参数由 forwardToAiService 从 req.raw.url 原样透传，不用在这里
  // 单独处理。
  fastify.get('/ai/channels/:id/results', fwdWithId('/results'));

  // ---- 识别快照归档（"识别历史"页面，阶段一存储子系统） ----
  // overview/list/清空这三条只需要 :id，直接复用 fwdWithId；?cursor=/
  // ?limit=/?from_ts=/?to_ts= 都由 forwardToAiService 原样透传查询串。
  fastify.get('/ai/channels/:id/snapshots/overview', fwdWithId('/snapshots/overview'));
  fastify.get('/ai/channels/:id/snapshots', fwdWithId('/snapshots'));
  fastify.delete('/ai/channels/:id/snapshots', fwdWithId('/snapshots'));

  // 识别事件时间热图（回放页时间轴红条数据源）：按 bucket_s 秒分桶聚合
  // 「有识别发生」的时段，?from_ts=/?to_ts=/?bucket_s= 原样透传查询串。
  // 必须注册在 /snapshots 的具名路由之后无碍——Fastify 按注册顺序精确匹配，
  // 这条是独立两段路径，不会和 /snapshots/:imageId 类路由互相吞并。
  fastify.get('/ai/channels/:id/snapshots/heatmap', fwdWithId('/snapshots/heatmap'));

  // 单条详情/图片/删除需要 :id 和 :imageId 两个参数，fwdWithId 只处理
  // 一个路径参数，这两条单独写。
  fastify.get(
    '/ai/channels/:id/snapshots/:imageId/image',
    (req: FastifyRequest, reply: FastifyReply) => {
      const { id, imageId } = req.params as { id: string; imageId: string };
      return forwardToAiService(req, reply, {
        settingsStore: opts.settingsStore,
        fallbackBaseUrl: opts.fallbackBaseUrl,
        targetPath: `api/v1/channels/${id}/snapshots/${imageId}/image`,
        timeoutMs,
        pgStore: opts.pgStore,
      });
    },
  );
  fastify.delete(
    '/ai/channels/:id/snapshots/:imageId',
    (req: FastifyRequest, reply: FastifyReply) => {
      const { id, imageId } = req.params as { id: string; imageId: string };
      return forwardToAiService(req, reply, {
        settingsStore: opts.settingsStore,
        fallbackBaseUrl: opts.fallbackBaseUrl,
        targetPath: `api/v1/channels/${id}/snapshots/${imageId}`,
        timeoutMs,
        pgStore: opts.pgStore,
      });
    },
  );

  // 不转发——本地聚合 srsClient.listStreams()，给创建向导的"源流选择"下拉
  // 用。SRS 7.0.162 实测 H.265 报 "HEVC"；仍用不区分大小写的宽松匹配。
  // 源是 H.265 时向导按 ai-service /health 的 capabilities 决定提示（能力徽标或警告）。
  fastify.get('/ai/streams', async (req: FastifyRequest, reply: FastifyReply) => {
    const streams = await opts.srsClient.listStreams();
    reply.send({
      streams: streams.map((s) => ({
        app: s.app,
        name: s.name,
        clients: s.clients,
        bitrateKbps: s.kbps?.recv_30s,
        videoCodec: s.video?.codec,
        videoLevel: s.video?.level === undefined ? undefined : String(s.video.level),
        videoWidth: s.video?.width,
        videoHeight: s.video?.height,
        h265: !!s.video?.codec && /hevc|h\.?265/i.test(s.video.codec),
      })),
    });
  });
}
