// PostgreSQL 启动初始化（有界重试）
//
// 为什么需要它：容器由 Docker restart 策略/整机开机自动拉起时，
// docker compose depends_on 的 service_healthy 顺序只在 `compose up`
// 流程里生效——backend 完全可能先于 PostgreSQL 就绪。2026-09-19 事故中
// backend 在 PG 尚未可用时启动，init() 连接超时后配置中心被永久跳过，
// 进程带伤运行十余小时：微服务拉配置全部 404、BFF 的 AI 代理因读不到
// PG secret 退回旧密钥而 401。这里把"启动只连一次"改成有界重试，覆盖
// PG 健康检查/崩溃恢复窗口；重试耗尽仍由调用方走原有降级路径，不无限
// 阻塞启动。
import type { PoolConfig } from 'pg';
import { PgConfigStore } from './pgStore.js';

/** 仅约束启动所需的两个方法，便于单元测试注入假实现。 */
export interface PgStoreLike {
  init(): Promise<unknown>;
  close(): Promise<void>;
}

export interface PgStoreRetryOptions {
  /** 总尝试次数（含首次），默认 12 次 */
  maxAttempts?: number;
  /** 首次重试等待毫秒，默认 1000，之后指数退避 */
  firstDelayMs?: number;
  /** 退避等待上限毫秒，默认 10000 */
  maxDelayMs?: number;
  /** 注入等待实现（单元测试用，避免真实计时） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入实例工厂（单元测试用，生产路径默认直接 new PgConfigStore） */
  createStore?: (opts: { poolConfig: PoolConfig; masterKeyPath: string }) => PgStoreLike;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_FIRST_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 创建 PgConfigStore 并执行 init()；连接失败时按指数退避有界重试。
 * 每次尝试都新建实例并关闭上一个失败实例的连接池，不跨轮复用半开连接。
 * 重试耗尽时抛出最后一次的原始错误（由调用方决定降级策略）。
 */
export async function initPgStoreWithRetry(
  opts: { poolConfig: PoolConfig; masterKeyPath: string },
  retry: PgStoreRetryOptions = {},
): Promise<PgConfigStore> {
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = retry.sleep ?? realSleep;
  const createStore =
    retry.createStore ?? ((o): PgStoreLike => new PgConfigStore(o));

  let delay = retry.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const store = createStore(opts);
    try {
      await store.init();
      if (attempt > 1) {
        console.info(`[pgStore] PostgreSQL 在第 ${attempt}/${maxAttempts} 次尝试后就绪`);
      }
      return store as PgConfigStore;
    } catch (e) {
      lastError = e;
      await store.close().catch(() => undefined);
      if (attempt === maxAttempts) break;
      console.error(
        `[pgStore] 启动连接失败（第 ${attempt}/${maxAttempts} 次），${delay}ms 后重试:`,
        e instanceof Error ? e.message : e,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw lastError;
}
