/**
 * adminPasswordHash 迁 PG secrets（B4，2026-09-15）
 *
 * 背景：此前哈希随 settings 整包存 backend/system/settings 文档——进了
 * 配置文档、版本快照、导出路径，违反「敏感值只存 config_secrets」边界。
 *
 * 迁移语义（幂等，启动时跑一次）：
 * - secret 不存在且旧 JSON 有哈希 → setSecret（来源标记 migration）+ 清 JSON
 * - secret 已存在 → 只清 JSON 残留（幂等）
 * - 两边都没有 → 不动
 *
 * 安全策略（评审定稿）：迁移完成后 JSON 不再持有哈希；PG 不可用时
 * passwordCache 走 fail-closed（见 passwordCache.ts），不允许静默降级为
 * 无密码放行——只有「尚未迁移」（secret 不存在且 JSON 有旧哈希）才允许
 * JSON 兜底。
 */
import { JsonStore } from '../store/jsonStore.js';
import { AppSettings } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';

/** 哈希在 config_secrets 里的 key_path */
export const ADMIN_PASSWORD_SECRET_KEY = 'backend/adminPasswordHash';

export interface AdminPasswordMigrationResult {
  /** 是否执行了 setSecret（首迁） */
  migrated: boolean;
  /** 是否清理了 JSON 残留 */
  cleanedJson: boolean;
}

export async function migrateAdminPasswordToSecret(
  pgStore: PgConfigStore,
  settingsStore: JsonStore<AppSettings>,
): Promise<AdminPasswordMigrationResult> {
  const result: AdminPasswordMigrationResult = { migrated: false, cleanedJson: false };
  const jsonHash = (await settingsStore.read()).adminPasswordHash || '';
  const hasSecret = await pgStore.hasSecret(ADMIN_PASSWORD_SECRET_KEY);

  if (!hasSecret && jsonHash) {
    await pgStore.setSecret(ADMIN_PASSWORD_SECRET_KEY, jsonHash, 'migration');
    result.migrated = true;
  }
  if (jsonHash) {
    // 幂等清理：PG 是唯一权威，旧 JSON 不再持有哈希。
    // 必须用 mutateEffective（以 PG 回灌的当前缓存为基底）而非 mutate
    // （无条件重读可能已陈旧的 settings.json），否则清哈希时会把整份旧
    // 设置冲回运行时缓存，抹掉配置中心已发布的热更新。
    await settingsStore.mutateEffective((s) => {
      s.adminPasswordHash = '';
    });
    result.cleanedJson = true;
  }
  return result;
}
