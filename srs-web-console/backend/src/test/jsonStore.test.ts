import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonStore } from '../store/jsonStore.js';

interface TestData {
  items: { id: string; name: string }[];
  counter: number;
}

const defaultData: TestData = { items: [], counter: 0 };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-test-'));
}

describe('JsonStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    filePath = path.join(tmpDir, 'data.json');
  });

  afterEach(() => {
    // 清理 tmp 目录
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ---- 基本读写 ----

  it('全新文件读返回默认值', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const data = await store.read();
    expect(data).toEqual({ items: [], counter: 0 });
    // 读操作不创建文件
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('mutate 能修改并持久化', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });

    const result = await store.mutate(data => {
      data.items.push({ id: '1', name: 'test' });
      data.counter = 42;
    });

    expect(result.items).toHaveLength(1);
    expect(result.counter).toBe(42);
    expect(fs.existsSync(filePath)).toBe(true);

    // 新 store 实例读回来一致
    const store2 = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const data2 = await store2.read();
    expect(data2.items[0].id).toBe('1');
    expect(data2.counter).toBe(42);
  });

  it('文件内容包含 version 字段', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 2 });
    await store.mutate(d => { d.counter = 1; });

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.data).toBeDefined();
  });

  // ---- 原子写 & 损坏恢复 ----

  it('写过程中文件损坏（模拟半截文件），能从 .bak 回退', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });

    // 第一次写 → 产生主文件和 .bak
    await store.mutate(d => { d.items.push({ id: 'a', name: 'A' }); });
    // 第二次写 → 主文件更新，.bak 存第一次的内容
    await store.mutate(d => { d.items.push({ id: 'b', name: 'B' }); });

    // 验证 .bak 存在
    expect(fs.existsSync(filePath + '.bak')).toBe(true);

    // 模拟主文件损坏（写半截 JSON）
    fs.writeFileSync(filePath, '{ broken json !!! ', 'utf8');

    // 读应该回退到 .bak
    const store2 = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const data = await store2.read();
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    // .bak 是第一次写后的内容（1 个 item）
    expect(data.items[0].id).toBe('a');
  });

  it('旧文件缺新增顶层字段时，读回自动补齐默认值（不返回 undefined）', async () => {
    // 模拟 schema 演进前写盘的旧文件：没有 counter 字段
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, data: { items: [{ id: 'old', name: 'Old' }] } }),
      'utf8',
    );

    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const data = await store.read();
    expect(data.items).toEqual([{ id: 'old', name: 'Old' }]); // 已有字段原样保留
    expect(data.counter).toBe(0); // 缺失字段回填默认值，不是 undefined
  });

  it('主文件和 .bak 都坏，返回默认值（不崩溃）', async () => {
    // 创建损坏的主文件
    fs.writeFileSync(filePath, 'garbage', 'utf8');
    fs.writeFileSync(filePath + '.bak', 'also garbage', 'utf8');

    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const data = await store.read();
    expect(data).toEqual({ items: [], counter: 0 });
  });

  // ---- 并发（RMW 交错不丢更新）----

  it('两路并发 mutate，两个增量都不丢（验证锁覆盖整个 RMW）', async () => {
    const store = new JsonStore<TestData>({
      filePath,
      defaultData,
      version: 1,
      lockRetries: 20,
    });

    // 初始化 counter = 0
    await store.mutate(d => { d.counter = 0; });

    // 两路各加 10 次，每次在 mutator 内故意等一下模拟慢操作
    // 没锁的话会大量丢失更新；有锁应该 20 次都累加
    const N = 10;

    const addOne = async () => {
      for (let i = 0; i < N; i++) {
        await store.mutate(d => {
          // 读值 → 模拟计算 → 写回
          const v = d.counter;
          // 用 Atomics 风格模拟慢操作（只是让交错概率更高）
          const start = Date.now();
          while (Date.now() - start < 2) {
            // busy wait 2ms（故意让另一个并发有机会读）
          }
          d.counter = v + 1;
        });
      }
    };

    await Promise.all([addOne(), addOne()]);

    const final = await store.read();
    expect(final.counter).toBe(N * 2); // 有锁应该是 20，无锁会小于
  });

  it('并发添加不同 item，两个都在', async () => {
    const store = new JsonStore<TestData>({
      filePath,
      defaultData,
      version: 1,
      lockRetries: 20,
    });

    const addItem = async (id: string, name: string) => {
      await store.mutate(d => {
        // 先"读"当前长度，再延迟 push，模拟交错
        const len = d.items.length;
        const start = Date.now();
        while (Date.now() - start < 3) { /* busy */ }
        d.items.push({ id, name });
        // 额外断言：长度应该是 len+1 才对（没锁的话另一个可能已经加了但我们这里看不到）
        // 不过我们在锁内，所以 len 应该等于我们读时的长度，最后 push 后是 len+1
      });
    };

    await Promise.all([
      addItem('a', 'A'),
      addItem('b', 'B'),
    ]);

    const data = await store.read();
    expect(data.items).toHaveLength(2);
    expect(data.items.map(i => i.id).sort()).toEqual(['a', 'b']);
  });

  // ---- replace API ----

  it('replace 完全替换数据', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const newData: TestData = { items: [{ id: 'x', name: 'X' }], counter: 99 };
    await store.replace(newData);

    const readBack = await store.read();
    expect(readBack).toEqual(newData);
  });

  // ---- fileExists ----

  it('fileExists 正确反映文件存在性', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    expect(store.fileExists()).toBe(false);
    await store.mutate(d => { d.counter = 1; });
    expect(store.fileExists()).toBe(true);
  });
});

// PG 单源模式回归：磁盘文件已陈旧，运行时经 setCache 持有更新值后，
// mutateEffective 必须以内存生效值为基底落盘，不能把陈旧磁盘内容冲回缓存。
describe('JsonStore.mutateEffective（PG 模式）', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    filePath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('缓存值比磁盘新：以缓存为基底修改并落盘，旧磁盘值不回潮', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });

    // 1. 磁盘先落一份旧值
    await store.mutate((d) => { d.counter = 1; d.items.push({ id: 'old', name: '磁盘旧值' }); });

    // 2. 运行时通过 setCache 拿到更新值（模拟 PG 回灌/配置中心热更新）
    store.setCache({ items: [{ id: 'new', name: 'PG 新值' }], counter: 99 });

    // 3. mutateEffective 清字段（模拟清 adminPasswordHash 残留）
    const result = await store.mutateEffective((d) => { d.counter = 0; });

    // 内存生效值保留 PG 新值，只有被改字段变化
    expect(result.items).toEqual([{ id: 'new', name: 'PG 新值' }]);
    expect(result.counter).toBe(0);
    expect((await store.read()).items[0]!.id).toBe('new');

    // 落盘内容也是 PG 新值（启动兜底文件被同步成最新）
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk.data.items).toEqual([{ id: 'new', name: 'PG 新值' }]);
    expect(onDisk.data.counter).toBe(0);
  });

  it('缓存为空时退回磁盘读取（等价 mutate 行为）', async () => {
    const store = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    await store.mutate((d) => { d.counter = 5; });
    // 新实例模拟"从没 setCache"：直接调 mutateEffective 应读到磁盘
    const store2 = new JsonStore<TestData>({ filePath, defaultData, version: 1 });
    const result = await store2.mutateEffective((d) => { d.counter = 6; });
    expect(result.counter).toBe(6);
  });
});
