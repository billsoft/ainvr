// Fastify 应用构建（可复用，测试用 fastify.inject 不启端口）
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store/jsonStore.js';
import { SrsClient } from './services/srsClient.js';
import { ChannelService, ChannelStoreData } from './services/channelService.js';
import { createPasswordCache } from './services/passwordCache.js';
import { migrateAdminPasswordToSecret } from './services/adminPasswordMigration.js';
import { loadServiceTokens, resolveServiceByToken } from './services/serviceTokens.js';
import { channelRoutes } from './routes/channels.js';
import { ingestRoutes } from './routes/ingest.js';
import { WhipSessions } from './services/whipSessions.js';
import { statusRoutes, readSettingsFromPgOrFallback } from './routes/status.js';
import { authRoutes } from './routes/auth.js';
import { brandingRoutes } from './routes/branding.js';
import { createBrandingLoader } from './services/branding.js';
import { aiProxyRoutes } from './routes/aiProxy.js';
import { recorderProxyRoutes } from './routes/recorderProxy.js';
import { diagOverlayRoutes } from './routes/diagOverlay.js';
import { AppSettings, DEFAULT_SETTINGS } from './types/channel.js';
import { PgConfigStore } from './store/pgStore.js';
import { initPgStoreWithRetry } from './store/pgStartup.js';
import { configRoutes } from './routes/config.js';
import { PublishOrchestrator } from './store/publishOrchestrator.js';
import { BackendConfigAdapter } from './store/backendAdapter.js';
import { PullModeAdapter } from './store/adapter.js';
import { SrsConfigAdapter, reapplyPublishedSrsSettings } from './store/srsAdapter.js';
import { observabilityRoutes } from './routes/observability.js';
import { networkRoutes } from './routes/network.js';
import { systemTimeRoutes } from './routes/systemTime.js';
import { operationalLog } from './services/operationalLog.js';
import { licenseRoutes } from './routes/license.js';
import { LicenseClient } from './license/licenseClient.js';
import { LicenseGate } from './license/licenseGate.js';
import { ConsoleSessions } from './services/consoleSessions.js';
import { createProxyIdentity, clientIdentity } from './services/proxyIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  /** Capability injection for isolated API tests. Runtime uses live components. */
  ingestReady?: (protocol: import('./types/channel.js').UpstreamProtocol) => Promise<boolean>;
  trustedProxyLookup?: () => Promise<string[]>;
  /** Explicit test injection; production always requires initial password setup. */
  requireInitialPassword?: boolean;
  dataDir?: string;
  srsApiHost?: string;
  corsOrigin?: boolean | string | string[];
  aiServiceBaseUrl?: string;
  aiProxyTimeoutMs?: number;
  recorderServiceBaseUrl?: string;
  /** 测试依赖注入；生产默认强制授权，没有环境变量关闭开关。 */
  licenseClient?: LicenseClient;
  licenseGate?: LicenseGate;
  /** OEM 品牌配置文件；默认取环境变量 BRANDING_FILE，再默认 /app/branding/branding.yaml */
  brandingFile?: string;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const sessions=new ConsoleSessions();
  const requireInitialPassword=opts.requireInitialPassword ?? true;
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? path.resolve(__dirname, '..', 'data');
  // 仅作为「settings.json 全新时」的 bootstrap 种子值——一旦文件已存在（含用户改过的值），
  // JsonStore.readFromDisk() 会直接返回磁盘内容，这个种子被完全忽略，见下方 settingsStore.read()。
  const seedApiHost = opts.srsApiHost ?? process.env.SRS_API_HOST ?? DEFAULT_SETTINGS.srsApiHost;

  const fastify = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024, // 1MB
  });
  const identifyProxy = createProxyIdentity(opts.trustedProxyLookup);
  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route.includes('/diag/') || route.includes('/observability/browser-error')) return;
    const mutation = !['GET','HEAD','OPTIONS'].includes(req.method);
    if (mutation || reply.statusCode >= 400) {
      operationalLog(reply.statusCode >= 500 ? 'ERROR' : reply.statusCode >= 400 ? 'WARN' : 'INFO',
        'http', `${req.method} ${route} → ${reply.statusCode}`, mutation ? 'audit' : 'runtime',
        { requestId: req.id, durationMs: Math.round(reply.elapsedTime), actor: 'console' });
    }
  });
  fastify.addHook('onError', async (req, _reply, error) => {
    // Keep stack frames in the redacted, bounded, rate-limited message field.
    // Never log raw URLs, request headers or bodies; stacks stay server-side.
    const summary = `${error.name}: ${error.message}`.slice(0, 512);
    const frames = error.stack?.split('\n').slice(1, 13).join('\n') ?? '';
    operationalLog('ERROR', 'http',
      `${req.method} ${req.routeOptions.url ?? 'unmatched'}: ${summary}${frames ? `\n${frames}` : ''}`,
      'runtime', { requestId: req.id });
  });

  // CORS（Phase 6 直连 IP 场景需要；dev 用 vite 代理走同源）
  await fastify.register(cors, {
    origin: opts.corsOrigin ?? false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // 存储
  const channelStore = new JsonStore<ChannelStoreData>({
    filePath: path.join(dataDir, 'channels.json'),
    defaultData: { channels: [] },
    version: 1,
  });

  const settingsStore = new JsonStore<AppSettings>({
    filePath: path.join(dataDir, 'settings.json'),
    defaultData: { ...structuredClone(DEFAULT_SETTINGS), srsApiHost: seedApiHost },
    version: 1,
  });

  // ⚠️ 必须先读一次 settingsStore 再构造 SrsClient：settings.json 已存在时（不管是默认值
  // 还是用户改过的值）读到的是持久化值，seedApiHost 完全不生效——这样容器重启后 SrsClient
  // 用的地址才会和 Settings 页面显示的值保持一致，不会静默回退到 env 默认值。
  const settings = await settingsStore.read();

  // SRS 客户端
  const srsClient = new SrsClient({
    apiHost: settings.srsApiHost,
    cacheTtlMs: 1500,
    timeoutMs: 3000,
  });

  const whipSessions = new WhipSessions(() => pgStore, `http://${settings.srsApiHost}`);
  // 通道服务
  const channelService = new ChannelService({
    store: channelStore,
    srsClient,
    settingsStore,
    secrets: () => pgStore,
    stopPublisher: id => whipSessions.terminate(id),
    withPublisherLock: (id, action) => whipSessions.exclusive(id, action),
  });

  // 最小可用鉴权（局域网口令）：密码未设置 = 完全放行；设置了 = 校验
  // X-Console-Token header（值 = 密码 sha256）。豁免登录相关的两个公开接口。
  // ⚠️ header 名必须用连字符不能用下划线——nginx 默认 underscores_in_headers off，
  // 套上 nginx 反代后带下划线的请求头会被直接丢弃，本地直连测试正常、上线后全 401。
  // 服务间调用（微服务拉配置/上报状态）走 X-Service-Token，与控制台密码解耦：
  // 即使启用了控制台密码，服务也不需要知道密码。
  // B4：哈希读 pgStore secrets（延迟取——pgStore 在下方才初始化），PG 不可用
  // 且 JSON 已迁移时 fail-closed，见 passwordCache.ts 头注
  const passwordCache = createPasswordCache(settingsStore, 2000, () => pgStore);
  // 服务间令牌（每服务独立，token→服务身份绑定，见 services/serviceTokens.ts）
  const serviceTokens = loadServiceTokens();
  const AUTH_EXEMPT_PATHS = ['/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/auth/media-check', '/api/health', '/api/branding'];
  fastify.addHook('onRequest', async (req, reply) => {
    await identifyProxy(req);
    // Host is preserved by nginx. Browser Origin is not a credential; reject
    // foreign origins even before bootstrap, including simple POST requests.
    const origin=req.headers.origin;
    if(origin) {
      let same=false;
      try {
        const parsed=new URL(origin);
        const scheme=clientIdentity(req).protocol;
        same=parsed.host===req.headers.host && parsed.protocol===`${scheme}:`;
      } catch {}
      if(!same)return reply.status(403).send({error:'不允许跨站访问管理接口'});
    }
    if (req.method === 'OPTIONS') return;
    const url = req.raw.url ?? '';
    const pathname = url.split('?')[0];
    if (!url.startsWith('/api/') || AUTH_EXEMPT_PATHS.includes(pathname)) return;

    // 有效服务 token：放行到 /api/v1/config/* 路由内部，但把绑定的服务名
    // 挂到请求对象上——2026-09-16 收口之前这里放行的是"整个前缀"，任一
    // 微服务的 token 都能改写/删除别的服务的密钥、触发全局发布/回滚，
    // 服务 token 机制形同虚设。现在只在这里解析身份，真正的"只能碰自己
    // 那份"限制交给 config.ts 的 enforceServiceScope() 按每个路由的资源
    // 归属逐一收窄（GET .../versions/:v/snapshot、POST .../service-states/:service
    // 这两个正在被 recorder/ai-service 拉配置客户端实际使用的路由，各自
    // 已有内联的按服务比对逻辑，不受这里改动影响）。
    const boundService = resolveServiceByToken(serviceTokens, req.headers['x-service-token']);
    if (boundService === 'recorder' && req.method === 'GET' &&
        ['/api/channels', '/api/ai/channels'].includes(pathname)) return;
    if (boundService && url.startsWith('/api/v1/config/')) {
      (req as any).boundService = boundService;
      return;
    }

    const hash = await passwordCache.get();
    if (!hash && (!requireInitialPassword || (req.method==='PUT' && pathname==='/api/settings/password'))) return;
    const ok = !!sessions.get(hash, req.headers['x-console-token']);
    if (!ok) {
      reply.status(401).send({ code: 401, error: '需要登录' });
    }
  });

  // Only the provisioned recorder may ask the authoritative password store.
  // No cached empty token and no fallback to a stale local password copy.
  fastify.post('/internal/recorder-auth', async (req, reply) => {
    if (resolveServiceByToken(serviceTokens, req.headers['x-service-token']) !== 'recorder')
      return reply.status(403).send();
    const body = req.body as { token?: unknown; cookie?: unknown } | null;
    const hash = await passwordCache.get();
    return reply.status((!hash && !requireInitialPassword) || sessions.mediaAllowed(hash, body?.token, body?.cookie) ? 204 : 401).send();
  });

  // 授权门控默认强制开启，测试通过构造参数显式注入。门控只按后台轮询
  // 缓存同步裁决，绝不在请求路径上等 license-service；/api/license/* 等白
  // 名单在失权时仍可达，保证现场能完成激活。
  const licenseClient = opts.licenseClient ?? new LicenseClient();
  const licenseGate = opts.licenseGate ?? new LicenseGate(licenseClient);
  licenseGate.start();
  fastify.addHook('onClose', async () => licenseGate.stop());
  fastify.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (licenseGate.isExempt(url, req.method)) return;
    const d = licenseGate.decide();
    if (d.block) {
      reply.status(503).send({
        code: d.code,
        message: d.code === 'LICENSE_REQUIRED'
          ? '设备未授权或授权已失效，请在「授权管理」中激活'
          : '授权状态信号缺失，系统已进入保护状态',
        state: d.status?.state ?? null,
        reason: d.reason ?? null,
      });
    }
  });

  // WHIP publishing has its own device credential, independent of console login.
  const aiServiceBaseUrl = opts.aiServiceBaseUrl
    ?? process.env.AI_SERVICE_BASE_URL
    ?? 'http://host.docker.internal:8000';
  const recorderServiceBaseUrl = opts.recorderServiceBaseUrl
    ?? process.env.RECORDER_SERVICE_BASE_URL
    ?? 'http://host.docker.internal:8100';

  // 统一配置中心：先初始化（statusRoutes 需要 pgStore 做兼容代理）
  let pgStore: PgConfigStore | null = null;
  let orchestrator: PublishOrchestrator | null = null;
  {
    const pgHost = process.env.CONFIG_PG_HOST;
    const pgPort = process.env.CONFIG_PG_PORT;
    const pgUser = process.env.CONFIG_PG_USER;
    const pgPassword = process.env.CONFIG_PG_PASSWORD;
    const pgDatabase = process.env.CONFIG_PG_DATABASE;
    const masterKeyPath = process.env.CONFIG_MASTER_KEY_PATH;

    if (pgHost && pgDatabase && masterKeyPath) {
      try {
        // 有界重试：整机开机/Docker restart 自动拉起时 backend 可能先于
        // PostgreSQL 就绪（depends_on 健康顺序只管 compose up）。重试耗尽
        // 拒绝启动，由进程监督器在 PG 恢复后重新拉起完整控制台。
        pgStore = await initPgStoreWithRetry({
          poolConfig: {
            host: pgHost,
            port: pgPort ? Number(pgPort) : 5432,
            user: pgUser ?? 'postgres',
            password: pgPassword ?? '',
            database: pgDatabase,
          },
          masterKeyPath,
        });

        // 2026-09-16：启动时用 PG 里的最新 backend/system/settings 覆盖
        // settingsStore 内存缓存——纯 ConfigCenter 部署（从没碰过旧
        // /api/settings 页面）重启前不会有别的代码路径把 PG 里的值同步
        // 回这份运行时缓存，不做这一步的话 aiProxy/recorderProxy/SrsClient
        // 读到的会是磁盘上 settings.json 的陈旧值，而 GET /api/settings
        // 走 readSettingsFromPgOrFallback 直读 PG，两边会互相矛盾。
        // 读失败（PG 抖动/文档不合法）不阻断启动，保留 settings.json 的值。
        try {
          const initialSettings = await readSettingsFromPgOrFallback(pgStore, settingsStore);
          settingsStore.setCache(initialSettings);
        } catch (e) {
          console.error('[app] 启动时从 PG 回灌 settings 失败，沿用本地 settings.json:', e);
        }

        // B4：一次性迁移 adminPasswordHash → config_secrets（幂等，失败不
        // 阻断启动，下次启动再试）
        try {
          const m = await migrateAdminPasswordToSecret(pgStore, settingsStore);
          if (m.migrated || m.cleanedJson) {
            console.info(
              `[app] adminPasswordHash 已迁移到 secrets (migrated=${m.migrated}, jsonCleaned=${m.cleanedJson})`,
            );
          }
        } catch (e) {
          console.error('[app] adminPasswordHash 迁移失败（下次启动重试）:', e);
        }

        // 发布编排器 + 各服务适配器
        // backend/srs：真适配器（BFF 内直接应用）；ai-service/recorder：拉模式
        // （服务自己轮询 desired_version 拉快照应用后自报状态，见 store/adapter.ts）
        const srsAdapter = new SrsConfigAdapter();
        orchestrator = new PublishOrchestrator(pgStore, [
          new BackendConfigAdapter(settingsStore, srsClient),
          srsAdapter,
          new PullModeAdapter('ai-service'),
          new PullModeAdapter('recorder'),
        ]);
        // 升级会用离线包默认配置覆盖 srs.conf：按配置中心重新下发（失败不阻断启动）
        await reapplyPublishedSrsSettings(pgStore, srsAdapter);

        console.info('[app] 统一配置中心已启用 (PG)');
      } catch (e) {
        // A configured PG is authoritative, especially after password migration.
        // Never start an unauthenticated, partially registered console on failure.
        await pgStore?.close().catch(() => undefined);
        await fastify.close();
        throw e;
      }
    } else {
      console.info('[app] 未配置 CONFIG_PG_*，配置中心路由未启用');
    }
  }

  await fastify.register(ingestRoutes, {
    sessions: whipSessions,
    channels: channelStore, settings: settingsStore, secrets: () => pgStore,
    token: process.env.INGEST_SERVICE_TOKEN ?? '',
    workerUrl: process.env.INGEST_SERVICE_URL ?? 'http://host.docker.internal:8120',
    srsUrl: `http://${settings.srsApiHost}`,
    srtEnabled: process.env.SRT_INGEST_ENABLED === '1',
  });
  await fastify.register(async (instance) => {
    await instance.register(channelRoutes, { channelService, inputReady: opts.ingestReady ?? (async (protocol) => {
      if (protocol === 'rtmp') return true;
      if (protocol === 'srt') return process.env.SRT_INGEST_ENABLED === '1';
      if (!pgStore) return false;
      if (protocol === 'webrtc') return true;
      try {
        const r = await fetch(`${process.env.INGEST_SERVICE_URL ?? 'http://host.docker.internal:8120'}/status`, {
          headers: { 'X-Service-Token': process.env.INGEST_SERVICE_TOKEN ?? '' }, signal: AbortSignal.timeout(2000) });
        return r.ok && !!(await r.json() as any).ready;
      } catch { return false; }
    }) });
    await instance.register(statusRoutes, {
      srsClient, settingsStore, channelService, channelStore, passwordCache,
      requireInitialPassword,
      authorizePasswordChange: async (token: unknown) => {
        const hash=await passwordCache.get();
        return !hash || !!sessions.get(hash,token);
      },
      aiServiceFallbackBaseUrl: aiServiceBaseUrl,
      pgStore: pgStore ?? undefined,
    });
    await instance.register(authRoutes, { passwordCache, sessions, requireInitialPassword });
    await instance.register(aiProxyRoutes, {
      fallbackBaseUrl: aiServiceBaseUrl,
      settingsStore,
      srsClient,
      timeoutMs: opts.aiProxyTimeoutMs,
      pgStore,
    });
    await instance.register(recorderProxyRoutes, {
      fallbackBaseUrl: recorderServiceBaseUrl,
      settingsStore,
      pgStore,
    });
    await instance.register(diagOverlayRoutes);
    await instance.register(observabilityRoutes, { pgStore });
    await instance.register(networkRoutes);
    await instance.register(systemTimeRoutes);
    await instance.register(licenseRoutes, { client: licenseClient, gate: licenseGate });
    await instance.register(brandingRoutes, {
      load: createBrandingLoader(
        opts.brandingFile ?? process.env.BRANDING_FILE ?? '/app/branding/branding.yaml',
        (msg) => console.warn(msg),
      ),
    });

    // 配置中心路由（PG 可用时才注册）
    if (pgStore && orchestrator) {
      await instance.register(configRoutes, {
        pgStore,
        orchestrator,
        serviceTokens,
      });
    }
  }, { prefix: '/api' });

  // 优雅退出
  const shutdown = async (signal: string) => {
    console.log(`\n[server] 收到 ${signal}，正在关闭...`);
    try {
      await fastify.close();
      console.log('[server] 已关闭');
    } catch (e) {
      console.error('[server] 关闭出错:', e);
      process.exit(1);
    }
    process.exit(0);
  };

  // 只在真起 server 时才注册信号（测试里 buildApp 不要注册，会导致测试挂起）
  if (process.env.NODE_ENV !== 'test') {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  return fastify;
}
