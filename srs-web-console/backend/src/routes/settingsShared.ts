// 系统状态 & 设置路由
import { z } from 'zod';
import { SrsClient } from '../services/srsClient.js';
import { JsonStore } from '../store/jsonStore.js';
import { ChannelService, ChannelStoreData } from '../services/channelService.js';
import { PasswordCache } from '../services/passwordCache.js';
import { AppSettings, DEFAULT_SETTINGS } from '../types/channel.js';
import { AppNameSchema, DownstreamProtocolSchema, UpstreamProtocolSchema } from './channels.js';
import type { PgConfigStore } from '../store/pgStore.js';

export interface StatusRoutesOptions {
  requireInitialPassword?: boolean;
  authorizePasswordChange?: (token: unknown) => Promise<boolean>;
  srsClient: SrsClient;
  settingsStore: JsonStore<AppSettings>;
  channelService: ChannelService;
  channelStore: JsonStore<ChannelStoreData>;
  passwordCache?: PasswordCache;
  /** settings.aiService.baseUrl 未配置时的兜底地址，与 aiProxyRoutes 共用同一个默认值来源 */
  aiServiceFallbackBaseUrl: string;
  /** 可选：PostgreSQL 配置仓库。提供时，/api/settings 读写走 PG 单源（backend/system/settings 文档），密码接口继续走 JsonStore。 */
  pgStore?: PgConfigStore;
}

// 设置字段白名单（导入时只允许导入这些，安全相关排除）
export const SETTINGS_WHITELIST: (keyof AppSettings)[] = [
  'srsApiHost',
  'srsRtmpHost',
  'srsHttpHost',
  'srsRtcHost',
  'srsSrtHost',
  'monitorSoftLimit',
  'monitorHardLimit',
  'pollIntervalMs',
  'srsVersion',
  'ingest',
];

// AI 微服务连接信息的更新 Schema——三个字段都可选，PUT /settings 的处理逻辑
// 会做子对象级合并（不是整体替换），只传 apiKey 不会连带清空 baseUrl。
export const AiServiceUpdateSchema = z.object({
  baseUrl: z.string().max(200).optional(),
  apiKey: z.string().max(200).optional(),
  pollIntervalMs: z.number().int().min(1000).max(60000).optional(),
});

// 更新设置的 Schema（不含密码）
export const IngestSettingsSchema = z.object({
  maxPullChannels: z.number().int().min(1).max(8),
  connectTimeoutSec: z.number().int().min(3).max(30),
});
export const SettingsUpdateSchema = z.object({
  srsApiHost: z.string().min(3).max(200).optional(),
  srsRtmpHost: z.string().max(200).optional(),
  srsHttpHost: z.string().max(200).optional(),
  srsRtcHost: z.string().max(200).optional(),
  srsSrtHost: z.string().max(200).optional(),
  monitorSoftLimit: z.number().int().min(1).max(16).optional(),
  monitorHardLimit: z.number().int().min(1).max(16).optional(),
  pollIntervalMs: z.number().int().min(1000).max(60000).optional(),
  srsVersion: z.string().max(50).optional(),
  aiService: AiServiceUpdateSchema.optional(),
  ingest: IngestSettingsSchema.optional(),
});

// 设置生效方式分类（三档，与 ai-service 架构文档 §11.2 同一套词汇，
// 统一整个 AINVR 项目对"改配置什么时候生效"的表达方式）：
//   hot      —— 立即生效，无需重启任何东西
//   restart  —— 需要重启某个组件才生效（本项目目前没有需要重启才能
//                生效的设置字段；如果将来加了，实现里要真的触发那个
//                重启动作，不能只是标注一下就不管）
//   rejected —— 拒绝修改 / 当前不支持修改
//
// 2026-09-17：rtcCandidateIp 已从这里搬走——它曾经在这个文档里挂过一份
// （连带 writeCandidateIp 调用），但配置中心的 BackendConfigAdapter.apply()
// 从不触达这条写入，等于"存了但没用"的死字段（唯一真正生效的路径是
// srs/system/settings 文档 + SrsConfigAdapter，见 store/srsAdapter.ts 头部
// 注释）。一个字段只认一个归属，现在这个文档不再收这个键。
export const SETTINGS_APPLY_VIA: Record<keyof typeof SettingsUpdateSchema.shape, 'hot' | 'restart' | 'rejected'> = {
  srsApiHost: 'hot',
  srsRtmpHost: 'hot',
  srsHttpHost: 'hot',
  srsRtcHost: 'hot',
  srsSrtHost: 'hot',
  monitorSoftLimit: 'hot',
  monitorHardLimit: 'hot',
  pollIntervalMs: 'hot',
  srsVersion: 'hot',
  // aiProxy 每次请求都从 settingsStore 现读，不缓存 baseUrl/apiKey——
  // 改了立即对下一次代理请求生效，不需要重启 backend 进程。
  aiService: 'hot',
  ingest: 'hot',
};

// 密码设置 Schema（允许空字符串 = 关闭密码）
export const PasswordSchema = z.object({
  password: z.string().max(100),
  oldPassword: z.string().max(100).optional(),
});

// 通道 Schema（导入校验用）—— app/downstreamProtocols 复用 CRUD 接口
// 那套 schema（channels.ts），不要另开一套更宽松的规则（审计发现：
// 这里此前是自己临时拼的、缺格式正则和数组边界，能导入 CRUD 接口本会
// 拒绝的脏数据，例如 app 里带非法字符、downstreamProtocols 传空数组）。
export const ChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  upstreamProtocol: UpstreamProtocolSchema,
  streamName: z.string().min(1).max(100),
  downstreamProtocols: z.array(DownstreamProtocolSchema).min(1).max(5),
  app: AppNameSchema,
  primaryProtocol: DownstreamProtocolSchema.optional(),
  remark: z.string().max(500).optional(),
  rtspUrl: z.string().url().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** 导入时的字段级校验失败——区别于其它未预料到的异常，路由层按 400 处理 */
export class ImportValidationError extends Error {}

// 导出的备份文件 Schema
export const ExportSchema = z.object({
  version: z.number().optional(),
  exportedAt: z.string().optional(),
  channels: z.array(ChannelSchema),
  settings: z.record(z.any()).optional(),
});


export function safeSettings(s: AppSettings) {
  const { adminPasswordHash, aiService, ...rest } = s;
  return {
    ...rest,
    // B4：PG 单源时哈希已迁 secrets，本字段恒空；adminPasswordSet 由调用方
    // 按 hasSecret 覆盖。这里保留 json 兜底路径的判断
    adminPasswordSet: (adminPasswordHash ?? '').length > 0,
    aiService: {
      baseUrl: aiService.baseUrl,
      pollIntervalMs: aiService.pollIntervalMs,
      // apiKey 是凭据，跟 adminPasswordHash 一个道理——只回显"设没设"
      aiApiKeySet: aiService.apiKey.length > 0,
    },
  };
}

// ===== 兼容代理：settings 的 PG 读写 =====
// 完整的 AppSettings Schema（用于 PUT 前整体校验，确保写入 PG 的 blob 合法）
// 2026-09-16 导出：BackendConfigAdapter（store/backendAdapter.ts）复用同一份
// schema 做 ConfigCenter 发布前校验 + apply 时的合法性兜底——绝不能在那边
// 再维护一份定义，两份 schema 早晚会在字段上漂移，届时"/api/settings 校验
// 通过但 ConfigCenter 发布校验拒绝"（或反过来）会比现在这个 bug 更难排查。
export const AppSettingsSchema = z.object({
  ingest: IngestSettingsSchema.optional(),
  srsApiHost: z.string().min(3).max(200),
  srsRtmpHost: z.string().max(200),
  srsHttpHost: z.string().max(200),
  srsRtcHost: z.string().max(200),
  srsSrtHost: z.string().max(200),
  monitorSoftLimit: z.number().int().min(1).max(50),
  monitorHardLimit: z.number().int().min(1).max(50),
  pollIntervalMs: z.number().int().min(1000).max(60000),
  srsVersion: z.string().max(50),
  // B4：adminPasswordHash 已迁 config_secrets，不再随 settings 文档存储；
  // zod 对文档里的历史残留字段默认 strip，不会写回
  aiService: z.object({
    baseUrl: z.string().max(200),
    apiKey: z.string().max(200),
    pollIntervalMs: z.number().int().min(1000).max(60000),
  }),
});

/**
 * 从 PG 读取 settings，没有则从 settingsStore 兜底读取（首次兼容导入）
 * 返回完整的 AppSettings（含密码哈希，调用方自己做 safeSettings 脱敏）
 *
 * 2026-09-16 导出：app.ts 启动时也要调用一次，把 settingsStore 的内存缓存
 * 用 PG 里的最新值覆盖——此前没有这一步，纯 ConfigCenter 部署（管理员从
 * 没碰过旧 /api/settings 页面）重启后 settingsStore 会静默回退到磁盘上的
 * 陈旧 settings.json，而 GET /api/settings 走的是这个函数直读 PG，会显示
 * "新值"——同一份 backend 配置，运行时用的和这个接口显示的对不上。
 */
export async function readSettingsFromPgOrFallback(
  pgStore: PgConfigStore,
  settingsStore: JsonStore<AppSettings>,
): Promise<AppSettings> {
  const doc = await pgStore.getDocument('backend', 'system', 'settings');
  if (doc) {
    const parsed = AppSettingsSchema.safeParse(doc.config);
    if (parsed.success) {
      return parsed.data;
    }
    // PG 里的配置不合法，记录日志但不 fallback 到 JSON（避免双源歧义）
    console.error('[settings] PG 中的 settings 不合法，返回默认值:', parsed.error.issues);
    return { ...DEFAULT_SETTINGS };
  }
  // PG 里没有 settings 文档：从 settingsStore（旧 JSON）读一次兜底
  // 这是唯一的 fallback 读取路径，不代表双写——下次 PUT 会写进 PG
  const fallback = await settingsStore.read();
  return fallback;
}

/**
 * 把完整 settings 写入 PG 的 backend/system/settings 文档
 * 写入前用 AppSettingsSchema 完整校验，确保 blob 合法
 */
export async function writeSettingsToPg(
  pgStore: PgConfigStore,
  settings: AppSettings,
  actor = 'admin',
): Promise<void> {
  const parsed = AppSettingsSchema.parse(settings); // 抛错由上层捕获
  await pgStore.upsertDocument(
    {
      service: 'backend',
      group: 'system',
      name: 'settings',
      config: parsed as unknown as Record<string, unknown>,
      description: 'Backend 系统设置（旧 /api/settings 兼容存储）',
    },
    actor,
  );
}

