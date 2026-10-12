// 录像微服务反向代理 —— console 具名控制路由转发到 ainvr-recorder
// （Python FastAPI，默认 host.docker.internal:8100，仅监听 127.0.0.1:8100）。
//
// 只代理控制面（小 JSON）：health/stats/channels/config/storage test/segments。
// 媒体（play/download，支持 Range 的大文件）不经过 Node——Node 侧 fetch 会把
// body 整个 arrayBuffer 缓冲，不适合视频——由 nginx 直通到 8100，见 frontend/nginx.conf。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { JsonStore } from '../store/jsonStore.js';
import { AppSettings } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';

export interface RecorderProxyOptions {
  fallbackBaseUrl: string;
  settingsStore: JsonStore<AppSettings>;
  timeoutMs?: number;
  /** 保留旧注册调用形状；不再通过代理写入配置草稿。 */
  pgStore?: PgConfigStore | null;
}

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

async function forward(req: FastifyRequest, reply: FastifyReply, opts: {
  settingsStore: JsonStore<AppSettings>;
  fallbackBaseUrl: string;
  targetPath: string;
  timeoutMs: number;
}) {
  const settings = await opts.settingsStore.read();
  const baseUrl = (
    settings.recorderService?.baseUrl || opts.fallbackBaseUrl
  ).replace(/\/+$/, '');
  const rawUrl = req.raw.url ?? '';
  const qi = rawUrl.indexOf('?');
  const query = qi >= 0 ? rawUrl.slice(qi) : '';
  const targetUrl = `${baseUrl}/${opts.targetPath}${query}`;

  const headers = filterHeaders(
    Object.entries(req.headers).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
  // Preserve the already authenticated session; never send password verifiers.

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
    req.log.error(`[recorder-proxy] ${req.method} ${targetUrl} 失败: ${(e as Error).message}`);
    reply.status(502).send({
      code: 502,
      error: timedOut ? '录像服务响应超时' : '录像服务不可达',
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function recorderProxyRoutes(
  fastify: FastifyInstance,
  opts: RecorderProxyOptions,
) {
  const defaultTimeout = opts.timeoutMs ?? 8000;
  const fwd = (targetPath: string, timeoutMs = defaultTimeout) =>
    (req: FastifyRequest, reply: FastifyReply) =>
      forward(req, reply, {
        settingsStore: opts.settingsStore,
        fallbackBaseUrl: opts.fallbackBaseUrl,
        targetPath,
        timeoutMs,
      });

  fastify.get('/v1/recorder/health', fwd('v1/recorder/health'));
  fastify.get('/v1/recorder/stats', fwd('v1/recorder/stats'));
  fastify.get('/v1/recorder/channels', fwd('v1/recorder/channels'));
  fastify.get('/v1/recorder/config', fwd('v1/recorder/config'));

  // Retired draft writer: both configuration and channel schedules use /config/apply.
  fastify.put('/v1/recorder/config', async (_req, reply) => {
    reply.status(410);
    return { code: 410, error: '旧录像设置入口已停用，请通过配置页面保存并自动应用' };
  });
  // storage/test 要挂载 + 16MB 写测速，给 30s
  fastify.post('/v1/recorder/storage/test', fwd('v1/recorder/storage/test', 30000));
  fastify.get('/v1/recordings/segments', fwd('v1/recordings/segments'));
  // 存储写入不足时按完整 GOP 丢弃的区间（回放时间轴琥珀色块）
  fastify.get('/v1/recordings/drops', fwd('v1/recordings/drops'));
  // 注意：/v1/recordings/:id/play|download 不在这里——nginx 直通 8100。
}
