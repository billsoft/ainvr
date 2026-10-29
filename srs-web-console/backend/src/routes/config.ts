import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { ConfigApply,type ApplyOperation } from '../services/configApply.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {SearchModelMigrationRouteOptions} from './searchModelMigrationRoutes.js';
import type { ConfigDocument } from '../store/pgStore.js';
import { isConfigService } from '../store/services.js';
import { resolveServiceByToken } from '../services/serviceTokens.js';
import { ADMIN_PASSWORD_SECRET_KEY } from '../services/adminPasswordMigration.js';
import { ConfigRoutesOptions, resolveSecretRefs, sanitizeImportDocSecrets, rejectReservedAdminPasswordField, serviceScopeError } from './configPolicy.js';
export type { ConfigRoutesOptions } from './configPolicy.js';
import { registerConfigTransferRoutes } from './configTransferRoutes.js';
import { prepareSearchSettings } from '../store/searchConfigAdapter.js';
import { prepareSearchVerifyLlmConfiguration } from '../services/searchVerifyConfiguration.js';
import { assertSearchModelSelectionChange } from '../services/searchModelSelectionGuard.js';
import { searchModelMigrationRoutes } from './searchModelMigrationRoutes.js';
import {prepareSearchModelMigrationPlanActivation,prepareSearchModelMigrationPlanRestore} from '../services/searchModelMigrationActivation.js';
import {searchMigrationPlanProgressSchema} from '../services/searchModelMigrationPlan.js';
export async function configRoutes(fastify: FastifyInstance, opts: ConfigRoutesOptions) {
  const { pgStore, orchestrator } = opts;
  const serviceTokens = opts.serviceTokens ?? new Map<string, string>();
  const autoApply = new ConfigApply(pgStore, 480_000, async service => {
    if (service !== 'ai-service') return true;
    // A startup config report may precede uvicorn binding its listening socket.
    const doc = await pgStore.getDocument('backend', 'system', 'settings');
    const settings = doc?.config ?? await opts.readBackendSettings?.();
    const ai = settings?.aiService as { baseUrl?: string } | undefined;
    const base = ai?.baseUrl || opts.aiServiceBaseUrl || process.env.AI_SERVICE_BASE_URL;
    if (!base) return false;
    try {
      const response = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  });
  if(opts.searchMigrations) {
    const migration=opts.searchMigrations;
    const publishPlan=(input:Parameters<NonNullable<SearchModelMigrationRouteOptions['publishPlan']>>[0],external?:AbortSignal)=>{
      const state=searchMigrationPlanProgressSchema.parse(input.job.migration_progress);
      const expires=Math.min(state.switch_deadline_ms??0,input.job.lease_until?.getTime()??0,input.job.expires_at.getTime());
      if(expires<=Date.now())throw new Error('migration_finalization_timeout');
      return autoApply.start(['search-service'],signal=>orchestrator.publish('切换已验收搜索模型（完整历史）',input.job.actor,{
        services:['search-service'],signal,prepare:client=>prepareSearchModelMigrationPlanActivation(client,{...input,store:migration.activationStore,artifacts:migration.planArtifacts}),
      }),{timeoutMs:Math.max(1,expires-Date.now()),signal:external});
    };
    const restorePlan=(input:Parameters<NonNullable<SearchModelMigrationRouteOptions['restorePlan']>>[0],external?:AbortSignal)=>autoApply.start(['search-service'],signal=>orchestrator.publish('恢复搜索模型原配置',input.job.actor,{
      services:['search-service'],signal,prepare:client=>prepareSearchModelMigrationPlanRestore(client,{...input,store:migration.activationStore}),
    }),{timeoutMs:30000,signal:external});
    const waitIdle=async(signal:AbortSignal)=>{while(autoApply.busy){signal.throwIfAborted();await delay(100,undefined,{signal});}signal.throwIfAborted();};
    const waitApply=async(operation:ApplyOperation,signal:AbortSignal)=>{
      while(operation.status==='running'){signal.throwIfAborted();await delay(100,undefined,{signal});}
      if(operation.status!=='succeeded')throw new Error('migration_apply_failed');
    };
    migration.onPlanApplyReady?.({
      publish:async(job,frozen,signal)=>{
        await waitIdle(signal);const context=await (migration.internalContext??migration.context)();
        if(!context||!job.lease_owner)throw new Error('migration_source_changed');
        await waitApply(publishPlan({job,worker:job.lease_owner,context,frozen},signal),signal);
      },
      restore:async(job,signal)=>{
        await waitIdle(signal);if(!job.lease_owner)throw new Error('migration_job_stale');
        await waitApply(restorePlan({job,worker:job.lease_owner},signal),signal);
      },
    });
    await searchModelMigrationRoutes(fastify,{...migration,apply:autoApply,
      activate:input=>autoApply.start(['search-service'],signal=>orchestrator.publish('切换已验收搜索模型',input.actor,{
        services:['search-service'],signal,prepare:client=>migration.prepareActivation(client,{...input,store:migration.activationStore,artifacts:migration.artifacts}),
      })),
      publishPlan,restorePlan,
    });
  }

  fastify.get('/v1/config/apply', async (req, reply) => {
    const err = serviceScopeError(req as any, null);
    if (err) { reply.status(err.code); return err; }
    const id = (req.query as { id?: string }).id;
    return { code: 0, data: id ? autoApply.get(id) : autoApply.current };
  });

  fastify.post('/v1/config/apply', async (req, reply) => {
    const err = serviceScopeError(req as any, null);
    if (err) { reply.status(err.code); return err; }
    if (autoApply.busy) { reply.status(409); return { code: 409, error: '配置正在更新，请稍后重试' }; }
    const changes = (req.body as any)?.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > 4 || changes.some(c =>
      !c || !isConfigService(c.service) || c.group !== 'system' || c.name !== 'settings' ||
      !c.config || typeof c.config !== 'object' || Array.isArray(c.config) ||
      (Object.hasOwn(c, 'expectedUpdatedAt') && c.expectedUpdatedAt !== null &&
        (typeof c.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(c.expectedUpdatedAt)))) ||
      rejectReservedAdminPasswordField(c.service, c.group, c.name, c.config))) {
      reply.status(400); return { code: 400, error: '无效的配置变更' };
    }
    const services = [...new Set<string>(changes.map(c => c.service))];
    const job = autoApply.start(services, signal => orchestrator.publish('系统配置保存并应用', 'admin', {
      services, signal,
      prepare: async client => {
        await client.query("SET LOCAL statement_timeout = '15s'");
        // Lock the latest documents; never merge a stale browser copy of other categories.
        await client.query('LOCK TABLE config_documents IN SHARE ROW EXCLUSIVE MODE');
        for (const change of changes) {
          const old = await client.query('SELECT config, updated_at FROM config_documents WHERE service=$1 AND "group"=$2 AND name=$3',
            [change.service, change.group, change.name]);
          if (Object.hasOwn(change, 'expectedUpdatedAt')) {
            const actual = old.rows[0] ? new Date(old.rows[0].updated_at).getTime() : null;
            const expected = change.expectedUpdatedAt === null ? null : Date.parse(change.expectedUpdatedAt);
            if (actual !== expected) throw new Error('配置已被其他操作更新，请重新进入本页后再编辑保存');
          }
          if (change.service === 'backend') {
            for (const key of ['monitorSoftLimit', 'monitorHardLimit']) {
              if (Object.hasOwn(change.config, key) && (!Number.isInteger(change.config[key]) || change.config[key] < 1 || change.config[key] > 16))
                throw new Error('监看上限须为 1–16 路');
            }
          }
          // Bootstrap a partial first save from the actual runtime configuration.
          // Do not substitute deployment defaults or expose legacy credentials.
          const baseline = old.rows[0]?.config ?? (change.service === 'backend'
            ? await opts.readBackendSettings?.() : undefined) ?? {};
          let config = { ...baseline, ...change.config };
          if (change.service === 'search-service') {
            config = prepareSearchSettings(config, old.rows[0]?.config);
            await assertSearchModelSelectionChange(client,baseline,config);
          }
          if (change.service === 'llm-service') {
            // Merge only this category's existing task map. The internal search
            // caller is provisioned in this same save transaction and never
            // rotates because an older browser omitted its hidden entry.
            config.tasks = { ...(baseline.tasks ?? {}), ...(change.config.tasks ?? {}) };
            config = (await prepareSearchVerifyLlmConfiguration(pgStore, client, config, baseline)).settings;
          }
          if (change.service === 'backend') {
            delete config.adminPasswordHash;
            config.aiService = { ...baseline.aiService, ...change.config.aiService };
            const legacyKey = config.aiService.apiKey;
            if (legacyKey) {
              // The proxy already prefers this canonical secret. Never overwrite
              // a newer canonical credential while migrating the fallback.
              const ciphertext = await pgStore.encryptSecret(legacyKey);
              await client.query(`INSERT INTO config_secrets (key_path, ciphertext, algorithm, key_version)
                VALUES ($1,$2,'aes-256-gcm',1) ON CONFLICT (key_path) DO NOTHING`,
                ['ai-service/server.api_key', ciphertext]);
              config.aiService.apiKey = '';
            }
          }
          if (change.service === 'recorder' && Object.hasOwn(change.config, 'channelSchedules')) {
            const schedules = change.config.channelSchedules;
            if (!schedules || typeof schedules !== 'object' || Array.isArray(schedules) ||
                Object.entries(schedules).some(([id, spec]: [string, any]) =>
                  !id || !spec || typeof spec.enabled !== 'boolean' || !Array.isArray(spec.hours) ||
                  spec.hours.some((hour: unknown) => !Number.isInteger(hour) || Number(hour) < 0 || Number(hour) > 23))) {
              throw new Error('录像计划必须包含有效的开关和 0–23 点整点时段');
            }
            // A dialog edits visible channels, not channels missing during a
            // transient catalogue refresh. Preserve those untouched entries.
            config.channelSchedules = { ...(old.rows[0]?.config?.channelSchedules ?? {}), ...schedules };
            delete config.enabledChannelIds;
          }
          const adapter = orchestrator.getAdapter(change.service);
          const valid = await adapter?.validate([{ ...change, config }]);
          if (!valid?.ok) throw new Error(`${change.service} 参数校验失败：${valid?.errors.join('; ') ?? '未注册适配器'}`);
          const safe = await sanitizeImportDocSecrets(change.service, config, pgStore, 'admin', client);
          // Explicit key removal must also clear the old canonical secret, used by AI proxy.
          if (change.service === 'ai-service' && change.config.server &&
              Object.hasOwn(change.config.server, 'api_key') && !change.config.server.api_key) {
            await client.query('DELETE FROM config_secrets WHERE key_path=$1', ['ai-service/server.api_key']);
          }
          await client.query(`INSERT INTO config_documents (service,"group",name,config)
            VALUES ($1,$2,$3,$4) ON CONFLICT(service,"group",name)
            DO UPDATE SET config=EXCLUDED.config,updated_at=now()`,
          [change.service, change.group, change.name, JSON.stringify(safe)]);
        }
      },
    }));
    reply.status(202);
    return { code: 0, data: job };
  });

  // ---- 配置文档 ----

  // 列表：按服务/分组过滤（拉配置客户端 _ever_had_config() 会带 ?service=
  // 查自己的文档是否存在，服务 token 场景必须继续可用，见 serviceScopeError 头注）
  fastify.get('/v1/config/documents', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const scopeErr = serviceScopeError(req as any, query.service ?? null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const docs = await pgStore.listDocuments(query.service, query.group);
    return { code: 0, data: docs };
  });

  // 单个文档
  fastify.get('/v1/config/documents/:service/:group/:name', async (req, reply) => {
    const { service, group, name } = req.params as Record<string, string>;
    const scopeErr = serviceScopeError(req as any, service);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const doc = await pgStore.getDocument(service, group, name);
    if (!doc) {
      reply.status(404);
      return { code: 404, error: '配置不存在' };
    }
    return { code: 0, data: doc };
  });

  // 新建/更新文档（UPSERT；service 必须在白名单内，防止测试/任意名字入库）
  fastify.post('/v1/config/documents', async (req, reply) => {
    const body = req.body as {
      service: string;
      group: string;
      name: string;
      config: Record<string, unknown>;
      description?: string;
    };
    if (!isConfigService(body.service)) {
      reply.status(400);
      return { code: 400, error: `未知服务「${body.service}」，允许的服务：backend（控制台）/ srs（流媒体服务）/ ai-service（AI 识别）/ recorder（录像）` };
    }
    const scopeErr = serviceScopeError(req as any, body.service);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const reservedErr = rejectReservedAdminPasswordField(body.service, body.group, body.name, body.config);
    if (reservedErr) {
      reply.status(403);
      return { code: 403, error: reservedErr };
    }
    const safeConfig = await sanitizeImportDocSecrets(body.service, body.config, pgStore, 'admin');
    const doc = await pgStore.upsertDocument({ ...body, config: safeConfig });
    return { code: 0, data: doc };
  });

  // 删除文档
  fastify.delete('/v1/config/documents/:service/:group/:name', async (req, reply) => {
    const { service, group, name } = req.params as Record<string, string>;
    // 与 POST 一致：白名单外的服务名直接拒绝（对未知名本来也是 no-op，
    // 显式 400 避免把接口当成探测/污染入口）
    if (!isConfigService(service)) {
      reply.status(400);
      return { code: 400, error: `未知服务「${service}」，允许的服务：backend（控制台）/ srs（流媒体服务）/ ai-service（AI 识别）/ recorder（录像）` };
    }
    const scopeErr = serviceScopeError(req as any, service);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const ok = await pgStore.deleteDocument(service, group, name);
    return { code: 0, data: { deleted: ok } };
  });

  // ---- 版本与发布 ----
  //
  // 2026-09-16 产品化收口：面向最终用户的"版本历史/回滚"大表格已从
  // ConfigCenter 前端彻底移除（历史版本列表、逐版本 diff、手动回滚按钮
  // 都是给开发/运维看的内部状态，不该出现在产品化界面）。这两条只服务于
  // 那张表格的只读列表接口（GET /v1/config/versions、GET .../versions/latest）
  // 随前端一起删除；POST .../rollback 见下方单独说明。
  // 保留 pgStore.listVersions()/getLatestVersion() 本身（不动数据层）——
  // GET /v1/config/export 仍在用 pgStore.listVersions() 拼导出包，删数据层
  // 方法会牵连导出功能；只删这里对外暴露的、专供已下线 UI 使用的 HTTP 路由。

  // 某版本的完整快照
  // 两种模式：
  // - 浏览器/无令牌：全量快照，${secret:...} 占位符原样返回（编辑器可见引用，
  //   明文永不出去）。
  // - 服务拉取（合法 X-Service-Token + ?service=xxx）：只返回该服务的文档，
  //   并解析其中以 <service>/ 为前缀的 secret 占位符（按服务过滤后再解密，
  //   服务拿不到别的服务的明文——2026-09-15 A2 评审定下的边界）。
  fastify.get('/v1/config/versions/:version/snapshot', async (req, reply) => {
    const { version } = req.params as Record<string, string>;
    const query = req.query as Record<string, string>;
    const docs = await pgStore.getVersionSnapshot(Number(version));
    if (!docs) {
      reply.status(404);
      return { code: 404, error: '版本不存在' };
    }

    const svc = query.service;
    // token 推导服务身份（每服务独立 token）；?service= 与绑定服务不一致 → 403
    const boundService = resolveServiceByToken(serviceTokens, req.headers['x-service-token']);
    if (boundService) {
      // 2026-09-16 收口：服务 token 必须带 ?service=<自己> 才能拉——此前
      // 不带 ?service= 时会落进下面"否则返回全量多服务快照"分支，等于
      // 任一服务 token 都能看到全部服务的配置文档结构（虽然 secret 占位符
      // 不会被解析，但文档结构/字段本身也不该被别的服务看到）。
      if (!svc || !isConfigService(svc) || boundService !== svc) {
        reply.status(403);
        return { code: 403, error: `token 绑定的是服务「${boundService}」，必须以 ?service=${boundService} 请求` };
      }
      const svcDocs: ConfigDocument[] = docs.filter((d) => d.service === svc);
      for (const doc of svcDocs) {
        await resolveSecretRefs(doc.config, svc, (key) => pgStore.getSecret(key));
      }
      return { code: 0, data: svcDocs };
    }
    return { code: 0, data: docs };
  });

  // 兼容旧客户端的明确错误；所有更新统一由 /apply 协调，避免绕过更新锁。
  fastify.post('/v1/config/publish', async (req, reply) => {
    const err = serviceScopeError(req as any, null);
    if (err) { reply.status(err.code); return err; }
    reply.status(410);
    return { code: 410, error: '旧入口已停用，请通过保存配置自动应用' };
  });

  // 发布前预校验——全局操作，服务 token 拒绝
  fastify.post('/v1/config/validate', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const body = req.body as { version?: number } ?? {};
    const result = await orchestrator.validatePublish(body.version);
    return { code: 0, data: result };
  });

  // ---- 配置漂移检测 ----

  fastify.get('/v1/config/drift', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const drift = await pgStore.detectDrift();
    return { code: 0, data: drift };
  });

  // ---- PG 连接信息（"数据库配置"页只读展示） ----

  // backend 自己连配置中心用的 PG 是鸡生蛋问题：要改这个连接就得先改
  // .env 重建容器，不可能经"配置发布"这套流程改（改错了会直接连不上
  // 存着这次改动的那个数据库）。这个端点只做只读展示 + 连通性探活，
  // 密码永远不返回——全局操作，服务 token 拒绝。
  fastify.get('/v1/config/pg-info', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    let connected = false;
    try {
      await pgStore.pool.query('SELECT 1');
      connected = true;
    } catch {
      connected = false;
    }
    return {
      code: 0,
      data: {
        host: process.env.CONFIG_PG_HOST || '',
        port: process.env.CONFIG_PG_PORT || '',
        database: process.env.CONFIG_PG_DATABASE || '',
        user: process.env.CONFIG_PG_USER || '',
        connected,
      },
    };
  });

  // ---- 导入/导出 ----

  // 导出当前所有配置（文档 + 敏感值元信息，不含明文）——全局操作，服务 token 拒绝
  registerConfigTransferRoutes(fastify, opts, autoApply);
  fastify.get('/v1/config/service-states', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const states = await pgStore.listServiceStates();
    return { code: 0, data: states };
  });

  // 单服务状态——拉配置客户端用它读自己的 desiredVersion，服务 token 必须
  // 继续可用，但只能查自己
  fastify.get('/v1/config/service-states/:service', async (req, reply) => {
    const { service } = req.params as Record<string, string>;
    const scopeErr = serviceScopeError(req as any, service);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const state = await pgStore.getServiceState(service);
    if (!state) {
      reply.status(404);
      return { code: 404, error: '服务不存在' };
    }
    return { code: 0, data: state };
  });

  // 服务上报自己的应用状态（供各服务回调用；service 白名单防任意名字 upsert，
  // 带 token 时校验 token 绑定服务与 :service 一致，防冒名上报）
  fastify.post('/v1/config/service-states/:service', async (req, reply) => {
    const { service } = req.params as Record<string, string>;
    if (!isConfigService(service)) {
      reply.status(404);
      return { code: 404, error: `未知服务「${service}」` };
    }
    if (service === 'search-service') {
      reply.status(409);
      return { code: 409, error: '搜索服务必须通过带依赖版本的 runtime-state 上报' };
    }
    const boundService = resolveServiceByToken(serviceTokens, req.headers['x-service-token']);
    if (boundService && boundService !== service) {
      reply.status(403);
      return { code: 403, error: `token 绑定的是服务「${boundService}」，不能冒名上报「${service}」` };
    }
    const body = req.body as Partial<{
      appliedVersion: number;
      status: string;
      restartRequired: boolean;
      errorMessage: string;
    }>;
    const state = await pgStore.updateServiceState({
      serviceName: service,
      appliedVersion: body.appliedVersion,
      status: body.status as any,
      restartRequired: body.restartRequired,
      errorMessage: body.errorMessage,
      // 拉模式客户端（config_center_client.py）自己不带时间戳——"刚上报
      // applied"这一刻的服务器时间就是准确的 appliedAt，没必要让客户端
      // 传。2026-09-18 之前这里完全不传 appliedAt，pull 模式服务的这个
      // 字段永远是空的；现在用来判断"发布后触发的重启是否已经完成"
      // （重启助手触发后轮询这个值有没有比触发时刻更新）。
      appliedAt: body.status === 'applied' ? new Date() : undefined,
    });
    return { code: 0, data: state };
  });

  // 旧手动重启入口停用；重启由自动应用操作负责并等待服务恢复。
  fastify.post('/v1/config/restart/:service', async (req, reply) => {
    const err = serviceScopeError(req as any, null);
    if (err) { reply.status(err.code); return err; }
    reply.status(410);
    return { code: 410, error: '旧入口已停用，请通过保存配置自动应用' };
  });

  // ---- 审计日志 ----

  // 全局操作，服务 token 拒绝（审计日志跨服务，且含敏感操作记录）
  fastify.get('/v1/config/audit-logs', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const query = req.query as Record<string, string>;
    const limit = query.limit ? Number(query.limit) : 100;
    const logs = await pgStore.listAuditLogs(limit);
    return { code: 0, data: logs };
  });

  // ---- 敏感值（只返回 key，不返回明文） ----
  // 2026-09-16：三条全部对服务 token 整体拒绝——写路径设计上唯一入口是
  // BFF（浏览器管理员），服务侧没有任何配置写入口（拉配置客户端自己
  // 从没调过这三个接口，密钥是通过 snapshot 端点按服务过滤解密后拿到的），
  // 不存在"服务只读/写自己密钥"这种合法用例，与其按前缀做部分放行、
  // 徒增一条以后可能被绕过的规则，不如直接整体拒绝更简单也更安全。

  fastify.get('/v1/config/secrets/*', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const key = (req.params as { '*': string })['*'];
    const has = await pgStore.hasSecret(key);
    if (!has) {
      reply.status(404);
      return { code: 404, error: '未设置' };
    }
    return { code: 0, data: { key, set: true, value: '********' } };
  });

  // Password verifier is reserved for the authenticated password-change route.
  // Generic config/secret writes must never replace or delete this identity state.
  function rejectAdminPasswordSecretKey(key: string, reply: { status: (c: number) => void }): boolean {
    if (key !== ADMIN_PASSWORD_SECRET_KEY) return false;
    reply.status(403);
    return true;
  }

  fastify.put('/v1/config/secrets/*', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const key = (req.params as { '*': string })['*'];
    if (rejectAdminPasswordSecretKey(key, reply)) {
      return { code: 403, error: '管理员密码凭据不支持通过通用密钥接口修改，请使用 PUT /api/settings 改密码' };
    }
    const body = req.body as { value: string; actor?: string };
    await pgStore.setSecret(key, body.value, body.actor ?? 'admin');
    return { code: 0, data: { key, set: true } };
  });

  fastify.delete('/v1/config/secrets/*', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const key = (req.params as { '*': string })['*'];
    if (rejectAdminPasswordSecretKey(key, reply)) {
      return { code: 403, error: '管理员密码凭据不支持通过通用密钥接口删除，请使用 PUT /api/settings 改密码' };
    }
    const ok = await pgStore.deleteSecret(key);
    return { code: 0, data: { deleted: ok } };
  });
}
