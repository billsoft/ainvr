// 密码哈希短 TTL 缓存
// 鉴权钩子在每个 /api/ 请求上都要知道"是否设置了密码/密码是什么哈希"，
// 直接每请求读一次在低算力开发板上是不必要的开销（叠加各页面 5s 轮询会
// 很明显）。2s TTL：足够短，改密码后最多 2s 内旧缓存过期；配合 invalidate()
// 在改密码成功后立即失效，避免"改完新密码但当前请求窗口内还在用旧哈希
// 校验"的体验问题。
//
// B4（2026-09-15）：哈希迁 PG secrets `backend/adminPasswordHash` 后的读取
// 策略（评审定稿，不允许安全降级）：
// 1. PG 可用 → 以 secret 为准（空值表示需要首次设置密码）
// 2. secret 不存在且旧 JSON 有哈希 → 尚未迁移，回退 JSON（迁移前状态）
// 3. PG 读失败且 JSON 已清理（迁移后）→ **fail-closed**：抛出不可用异常，
//    请求返回 503，PG 恢复自动恢复——绝不静默降级为"无密码放行"
import { JsonStore } from '../store/jsonStore.js';
import { AppSettings } from '../types/channel.js';
import type { PgConfigStore } from '../store/pgStore.js';
import { ADMIN_PASSWORD_SECRET_KEY } from './adminPasswordMigration.js';
import { isLegacyHash, protectDigest } from './passwordHash.js';

export interface PasswordCache {
  get(): Promise<string>;
  invalidate(): void;
}

/** 不可用状态不能表示成可被请求头匹配的凭据。 */
export class AuthenticationUnavailable extends Error {
  readonly statusCode = 503;
  constructor() { super('访问密码暂不可验证，请稍后重试'); }
}

export function createPasswordCache(
  settingsStore: JsonStore<AppSettings>,
  ttlMs = 2000,
  /** 延迟取 pgStore：app.ts 里 passwordCache 构造在 PG 初始化之前，
   *  必须调用时才解析（pgStore 是 let 变量，启动完成后恒定） */
  getPgStore?: () => PgConfigStore | null,
): PasswordCache {
  let cache: { hash: string | null; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  return {
    async get(): Promise<string> {
      if(inFlight)return inFlight;
      inFlight=(async()=>{
      const now = Date.now();
      if (cache && cache.expiresAt > now) {
        if (cache.hash === null) throw new AuthenticationUnavailable();
        return cache.hash;
      }
      const pgStore = getPgStore?.() ?? null;

      let hash: string | null = null;
      let pgBroken = false;
      if (pgStore) {
        try {
          hash = await pgStore.getSecret(ADMIN_PASSWORD_SECRET_KEY); // null = 未设置
        } catch {
          pgBroken = true;
        }
      }

      if (hash === null) {
        // secret 不存在（或 PG 读失败）：看旧 JSON 是否还有迁移前哈希
        let jsonHash = '';
        try {
          jsonHash = (await settingsStore.read()).adminPasswordHash || '';
        } catch {
          cache = { hash: null, expiresAt: Date.now() + ttlMs };
          throw new AuthenticationUnavailable();
        }
        if (pgBroken && !jsonHash) {
          // 迁移后 PG 挂：fail-closed，绝不无密码放行
          cache = { hash: null, expiresAt: Date.now() + ttlMs };
          throw new AuthenticationUnavailable();
        } else {
          hash = jsonHash;
        }
      }

      // Upgrade the existing SHA digest without requiring the plaintext password.
      // All concurrent readers await the same migration. Never write on PG failure.
      if(isLegacyHash(hash) && !pgBroken) {
        const protectedHash=await protectDigest(hash);
        if(pgStore) {
          await pgStore.setSecret(ADMIN_PASSWORD_SECRET_KEY,protectedHash);
          await settingsStore.mutateEffective(s=>{s.adminPasswordHash='';});
        } else await settingsStore.mutate(s=>{s.adminPasswordHash=protectedHash;});
        hash=protectedHash;
      }
      cache = { hash, expiresAt: now + ttlMs };
      return hash;
      })();
      try {return await inFlight;} finally {inFlight=null;}
    },
    invalidate(): void {
      cache = null;
    },
  };
}
