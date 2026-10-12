import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { initPgStoreWithRetry, type PgStoreLike } from '../store/pgStartup.js';
import { PgConfigStore } from '../store/pgStore.js';

/** 计数假 store：按脚本让 init 失败/成功，记录 close 调用。 */
function fakeStore(script: Array<'fail' | 'ok'>, closes: number[]) {
  let calls = 0;
  return {
    init: vi.fn(async () => {
      const i = calls++;
      if (script[i] === 'fail') throw new Error(`connection failure #${i + 1}`);
    }),
    close: vi.fn(async () => {
      closes.push(calls);
    }),
  } satisfies PgStoreLike & { init: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe('initPgStoreWithRetry', () => {
  it('首次即成功：不重试、不关闭实例', async () => {
    const closes: number[] = [];
    const store = fakeStore(['ok'], closes);
    const sleep = vi.fn(async (_ms: number) => undefined);

    const result = await initPgStoreWithRetry(
      { poolConfig: {}, masterKeyPath: '/unused' },
      { sleep, createStore: () => store },
    );

    expect(result).toBe(store);
    expect(store.init).toHaveBeenCalledTimes(1);
    expect(store.close).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('失败两次后成功：指数退避重试，失败实例均被关闭', async () => {
    const closes: number[] = [];
    const store = fakeStore(['fail', 'fail', 'ok'], closes);
    const sleep = vi.fn(async (_ms: number) => undefined);

    const result = await initPgStoreWithRetry(
      { poolConfig: {}, masterKeyPath: '/unused' },
      { firstDelayMs: 1000, maxDelayMs: 10000, sleep, createStore: () => store },
    );

    expect(result).toBe(store);
    expect(store.init).toHaveBeenCalledTimes(3);
    expect(closes).toHaveLength(2);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000]);
  });

  it('重试耗尽：抛出最后一次错误，退避封顶，每个失败实例都关闭', async () => {
    const closes: number[] = [];
    const store = fakeStore(['fail', 'fail', 'fail'], closes);
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(
      initPgStoreWithRetry(
        { poolConfig: {}, masterKeyPath: '/unused' },
        { maxAttempts: 3, firstDelayMs: 1000, maxDelayMs: 1500, sleep, createStore: () => store },
      ),
    ).rejects.toThrow('connection failure #3');

    expect(store.init).toHaveBeenCalledTimes(3);
    expect(closes).toHaveLength(3);
    // 1000 → 封顶 1500（不出现 2000）
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 1500]);
  });
});

describe('PgConfigStore 连接池容错', () => {
  it('空闲连接 error 事件被吞掉而不是崩溃进程（57P01 回归）', async () => {
    // 构造函数不发起连接、不加载密钥，无需真实 PostgreSQL
    const store = new PgConfigStore({
      poolConfig: { host: '127.0.0.1', port: 1 },
      masterKeyPath: path.join(os.tmpdir(), 'pg-startup-test-master.key'),
    });
    try {
      // 无 'error' 监听时 EventEmitter 会同步抛出；有兜底监听时这里必须安静返回
      expect(() =>
        store.pool.emit('error', new Error('terminating connection due to administrator command')),
      ).not.toThrow();
    } finally {
      await store.pool.end();
    }
  });
});
