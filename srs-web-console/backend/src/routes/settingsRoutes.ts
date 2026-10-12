import { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../services/passwordHash.js';
import { LoginAttempts } from '../services/consoleSessions.js';
import { clientIdentity } from '../services/proxyIdentity.js';
import { JsonStore } from '../store/jsonStore.js';
import { ADMIN_PASSWORD_SECRET_KEY } from '../services/adminPasswordMigration.js';
import { AppSettings } from '../types/channel.js';
import { StatusRoutesOptions, SettingsUpdateSchema, SETTINGS_APPLY_VIA, PasswordSchema, safeSettings, AppSettingsSchema, readSettingsFromPgOrFallback, writeSettingsToPg } from './settingsShared.js';

export function registerSettingsRoutes(fastify: FastifyInstance, opts: StatusRoutesOptions) {
  const { srsClient, settingsStore, channelService, channelStore, passwordCache, aiServiceFallbackBaseUrl } = opts;
  fastify.get('/settings', async (req, reply) => {
    let settings: AppSettings;
    let adminPasswordSet: boolean;
    if (opts.pgStore) {
      settings = await readSettingsFromPgOrFallback(opts.pgStore, settingsStore);
      // B4：哈希在 secrets 里，文档/JSON 不再承载；以 secret 是否存在为准，
      // secret 不存在时再看 JSON（覆盖「尚未迁移」窗口）
      let hasSecret = false;
      try {
        hasSecret = await opts.pgStore.hasSecret(ADMIN_PASSWORD_SECRET_KEY);
      } catch {
        hasSecret = false; // PG 抖动：回退 JSON 判断
      }
      adminPasswordSet =
        hasSecret || ((await settingsStore.read()).adminPasswordHash || '').length > 0;
    } else {
      settings = await settingsStore.read();
      adminPasswordSet = (settings.adminPasswordHash || '').length > 0;
    }
    reply.send({ code: 0, data: { ...safeSettings(settings), adminPasswordSet } });
  });

  // ============================================================
  // PUT /api/settings — 更新设置（非密码字段）
  // ============================================================
  // 兼容代理：pgStore 存在时写入 PG（单源权威），同时更新内存 settingsStore
  // 保证运行时热更新；PG 不可用则拒绝写入，不 fallback 到旧 JSON 文件
  fastify.put('/settings', async (req, reply) => {
    const parse = SettingsUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      reply.status(400).send({
        code: 400,
        error: '参数错误',
        details: parse.error.flatten().fieldErrors,
      });
      return;
    }

    // appliedVia：只报告这次请求里真的出现过的字段，逐个如实标注（取自分类表）。
    const appliedVia: Partial<Record<keyof AppSettings, 'hot' | 'restart' | 'rejected'>> = {};
    const errors: Partial<Record<keyof AppSettings, string>> = {};

    for (const key of Object.keys(parse.data) as (keyof typeof parse.data)[]) {
      appliedVia[key] = SETTINGS_APPLY_VIA[key];
    }

    // 合并更新到当前设置
    let updated: AppSettings;

    if (opts.pgStore) {
      // PG 单源：先读当前值 → 合并 → 整体 Zod 校验 → 写回 PG
      // 同时更新内存 settingsStore 保证热更新，但不写 settings.json 文件
      const current = await readSettingsFromPgOrFallback(opts.pgStore, settingsStore);
      const merged: AppSettings = { ...current };

      const { aiService, ...flat } = parse.data;
      Object.assign(merged, flat);
      if (aiService) {
        merged.aiService = { ...merged.aiService, ...aiService };
      }

      // 整体 Zod 校验：确保写入 PG 的 blob 完全合法
      const fullParse = AppSettingsSchema.safeParse(merged);
      if (!fullParse.success) {
        reply.status(400).send({
          code: 400,
          error: '合并后配置不合法',
          details: fullParse.error.flatten().fieldErrors,
        });
        return;
      }

      // 写入 PG（单源权威）
      await writeSettingsToPg(opts.pgStore, fullParse.data);

      // 同步到内存 settingsStore（运行时热更新，不写盘、不双写 settings.json）
      settingsStore.setCache(fullParse.data);

      updated = fullParse.data;
    } else {
      // 旧路径：直接写 JsonStore
      updated = await settingsStore.mutate(s => {
        const { aiService, ...flat } = parse.data;
        Object.assign(s, flat);
        if (aiService) {
          Object.assign(s.aiService, aiService);
        }
      });
    }

    // 若改了 SRS API host
    if (parse.data.srsApiHost) {
      srsClient.setApiHost(parse.data.srsApiHost);
    }

    reply.send({
      code: 0,
      data: safeSettings(updated),
      appliedVia,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    });
  });

  // ============================================================
  // PUT /api/settings/password — 设置管理员密码
  // ============================================================
  let changingPassword=false;
  const passwordAttempts=new LoginAttempts();
  fastify.put('/settings/password', async (req, reply) => {
    if(changingPassword)return reply.status(409).send({error:'密码正在更新，请稍后重试'});
    changingPassword=true;
    try {
    if(opts.authorizePasswordChange && !await opts.authorizePasswordChange(req.headers['x-console-token']))
      return reply.status(401).send({error:'需要重新登录'});
    const parse = PasswordSchema.safeParse(req.body);
    if (!parse.success) {
      reply.status(400).send({ code: 400, error: '参数错误' });
      return;
    }

    // 空密码 = 关闭鉴权：不存任何哈希（sha256('') 仍是一个「有效口令」，
    // 任何知道这个约定的人都能算出来）。B4：PG 单源时哈希只进 config_secrets。
    if(opts.requireInitialPassword && parse.data.password.length<8)
      return reply.status(400).send({error:'管理密码至少需要 8 个字符'});
    const currentHash=await passwordCache?.get();
    if(currentHash) {
      const ip=clientIdentity(req).ip;
      if(!passwordAttempts.enter(ip))return reply.header('Retry-After','60').status(429).send({error:'验证过于频繁，请一分钟后重试'});
      let verified=false;
      try { verified=!!parse.data.oldPassword && await verifyPassword(parse.data.oldPassword,currentHash); }
      finally { passwordAttempts.leave(ip,verified); }
      if(!verified)return reply.status(403).send({error:'当前密码不正确；忘记密码请使用设备 sudo 重置工具'});
      if(await passwordCache?.get()!==currentHash)return reply.status(409).send({error:'密码已变更，请重新登录'});
    }
    const hash = parse.data.password ? await hashPassword(parse.data.password) : '';
    let adminPasswordSet: boolean;
    if (opts.pgStore) {
      if (hash) {
        await opts.pgStore.setSecret(ADMIN_PASSWORD_SECRET_KEY, hash);
        adminPasswordSet = true;
      } else {
        await opts.pgStore.deleteSecret(ADMIN_PASSWORD_SECRET_KEY);
        adminPasswordSet = false;
      }
      // 幂等清理：迁移期残留的 JSON 哈希一并清掉（PG 是唯一权威）。
      // 用 mutateEffective：以当前生效（PG 回灌/热更新后）的缓存为基底
      // 顺带落盘，不能用 mutate——那会从陈旧 settings.json 重读并冲回缓存。
      await settingsStore.mutateEffective(s => {
        s.adminPasswordHash = '';
      });
    } else {
      const updated = await settingsStore.mutate(s => {
        s.adminPasswordHash = hash;
      });
      adminPasswordSet = (updated.adminPasswordHash ?? '').length > 0;
    }

    // 立即让缓存失效，避免改密码后 2s TTL 窗口期内新密码反而登录失败
    passwordCache?.invalidate();

    reply.send({
      code: 0,
      data: { adminPasswordSet },
    });
    } finally {changingPassword=false;}
  });

  // ============================================================
  // POST /api/v1/config/import-legacy — 旧 JSON 一次性导入（B5）
  // ============================================================
  // 把磁盘上的旧 settings.json / channels.json 导入 PG 配置中心，之后旧文件
  // 只作启动兜底、不再人工编辑。幂等可重试：
  // - settings：PG 已有 backend/system/settings 时跳过（PG 是权威，不覆盖）
  // - channels：写 backend/legacy/channels 只读镜像（channels.json 是 BFF
  //   运行数据，仍由通道管理 API 维护——「业务数据不动」原则；镜像仅供
  //   配置中心查看/导出，不作为运行存储）

}
