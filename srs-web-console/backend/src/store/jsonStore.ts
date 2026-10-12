// JSON 文件持久化存储
// 可靠性设计：
//   1. proper-lockfile 互斥锁，覆盖整个 read-modify-write 周期
//   2. 原子写：写 tmp 文件 → fsync → rename 覆盖原文件
//   3. .bak 备份：rename 前先把旧文件拷成 .bak，读取失败时回退
//   4. 数据文件带 version 字段，便于将来迁移
//   5. 优雅退出：释放锁 + 确保落盘

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export interface JsonStoreOptions<T> {
  filePath: string;
  defaultData: T;
  version: number;
  lockTimeoutMs?: number;
  lockRetries?: number;
}

export interface StoreFile<T> {
  version: number;
  data: T;
}

export class JsonStore<T extends object> {
  private readonly filePath: string;
  private readonly bakPath: string;
  private readonly tmpPath: string;
  private readonly defaultData: T;
  private readonly version: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetries: number;

  // 运行时缓存：减少磁盘读（注意：锁内读才能保证最新）
  private cached: StoreFile<T> | null = null;
  private cacheValid = false;

  constructor(opts: JsonStoreOptions<T>) {
    this.filePath = opts.filePath;
    this.bakPath = opts.filePath + '.bak';
    this.tmpPath = opts.filePath + '.tmp';
    this.defaultData = opts.defaultData;
    this.version = opts.version;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.lockRetries = opts.lockRetries ?? 10;

    // 确保目录存在
    const dir = path.dirname(opts.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ---- 低级操作 ----

  /**
   * 从磁盘读取（不走缓存），解析失败尝试 .bak 回退
   */
  private readFromDisk(): StoreFile<T> {
    // 先读主文件
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as StoreFile<T>;
        if (parsed && typeof parsed === 'object' && 'data' in parsed) {
          // 版本兼容：只检查 major 一致
          if (Math.floor(parsed.version) === Math.floor(this.version)) {
            return { version: parsed.version, data: this.backfillMissingKeys(parsed.data as T) };
          }
          // 版本不匹配，这里先透传（将来加迁移逻辑）
          return { version: this.version, data: this.backfillMissingKeys(parsed.data as T) };
        }
      }
    } catch (e) {
      // 主文件损坏，尝试 .bak
      console.warn(`[jsonStore] 主文件读取失败，尝试 .bak: ${(e as Error).message}`);
    }

    // 尝试 .bak
    try {
      if (fs.existsSync(this.bakPath)) {
        const raw = fs.readFileSync(this.bakPath, 'utf8');
        const parsed = JSON.parse(raw) as StoreFile<T>;
        if (parsed && typeof parsed === 'object' && 'data' in parsed) {
          console.warn('[jsonStore] 已从 .bak 恢复数据');
          return { version: parsed.version, data: this.backfillMissingKeys(parsed.data as T) };
        }
      }
    } catch (e2) {
      console.warn(`[jsonStore] .bak 也失败: ${(e2 as Error).message}`);
    }

    // 全新文件
    return { version: this.version, data: structuredClone(this.defaultData) };
  }

  /**
   * 补齐旧文件里缺失的顶层字段（浅合并，只填 undefined 的 key，绝不覆盖
   * 已有值）——schema 演进的必经问题：给 AppSettings/ChannelStoreData
   * 加新顶层字段后，磁盘上跑了很久的旧 settings.json 里没有这个 key，
   * 读回来是 undefined，消费方一旦直接 `data.newField.xxx` 就是运行时崩溃。
   * 只做一层，不递归深合并——目前所有消费场景都是"整个新顶层字段缺失"，
   * 不是"字段内部某个子字段缺失"，深合并会把这条简单不变量搞复杂。
   */
  private backfillMissingKeys(data: T): T {
    const def = this.defaultData as unknown as Record<string, unknown>;
    const out = data as unknown as Record<string, unknown>;
    for (const key of Object.keys(def)) {
      if (out[key] === undefined) {
        out[key] = structuredClone(def[key]);
      }
    }
    return out as T;
  }

  /**
   * 原子写入磁盘：tmp → fsync → 旧文件拷 .bak → rename tmp → fsync dir
   */
  private writeToDisk(content: StoreFile<T>): void {
    const raw = JSON.stringify(content, null, 2);

    // 1. 写 tmp
    fs.writeFileSync(this.tmpPath, raw, 'utf8');

    // 2. fsync tmp（确保数据落盘，防断电丢）
    const fd = fs.openSync(this.tmpPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 3. 旧文件 → .bak（只在旧文件存在时做）
    if (fs.existsSync(this.filePath)) {
      try {
        fs.copyFileSync(this.filePath, this.bakPath);
      } catch (e) {
        console.warn(`[jsonStore] 创建 .bak 失败: ${(e as Error).message}`);
      }
    }

    // 4. rename（原子操作）
    fs.renameSync(this.tmpPath, this.filePath);

    // 5. fsync 目录（确保 rename 元数据落盘）
    try {
      const dirFd = fs.openSync(path.dirname(this.filePath), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // 目录 fsync 非关键，失败忽略
    }
  }

  // ---- 锁工具 ----

  private async withLock<R>(fn: () => Promise<R> | R): Promise<R> {
    // 用文件目录做锁对象（锁文件与数据文件同目录）
    const lockOpts: lockfile.LockOptions = {
      stale: this.lockTimeoutMs,
      retries: this.lockRetries,
      realpath: false,
    };

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.filePath, lockOpts);
      // 进锁后先失效缓存，确保读到最新磁盘数据
      this.cacheValid = false;
      return await fn();
    } finally {
      if (release) {
        await release().catch(() => {
          // 释放失败不抛（锁会因 stale 自动过期）
        });
      }
    }
  }

  // ---- 公共 API ----

  /**
   * 读取数据（读操作，共享——但为简单起见也加排他锁，保证不读到半写状态）
   * 正常情况下读操作不用加锁（rename 是原子的），加锁是为了缓存一致性。
   */
  async read(): Promise<T> {
    // 缓存有效则直接返回（避免重复读盘；PG 单源模式下也靠这个保留内存中的最新值）
    if (this.cacheValid && this.cached) {
      return this.cached.data;
    }
    // 直接读文件（rename 原子，不会读到半截），不走锁（性能更好）
    const file = this.readFromDisk();
    this.cached = file;
    this.cacheValid = true;
    return file.data;
  }

  /**
   * 修改数据 —— 传入 mutator 函数，在锁内完成「读 → 修改 → 写回」
   * mutator 可以直接修改 data 对象（深拷贝保护？不需要——锁内只有一个修改者）
   * 返回修改后的数据
   */
  async mutate(mutator: (data: T) => void | Promise<void>): Promise<T> {
    return this.withLock(async () => {
      const file = this.readFromDisk();
      await mutator(file.data);
      file.version = this.version;
      this.writeToDisk(file);
      this.cached = file;
      this.cacheValid = true;
      return file.data;
    });
  }

  /**
   * 以「当前生效数据」为基底做读-改-写（PG 单源模式专用）。
   *
   * 与 mutate() 的区别：mutate() 无条件从磁盘文件重读——PG 模式下磁盘
   * settings.json 只作启动兜底，配置中心的热更新只写了内存缓存（setCache），
   * 磁盘内容可能已陈旧；此时若用 mutate() 清 adminPasswordHash 残留，会把
   * 整份陈旧磁盘内容连同清掉的哈希一起写回缓存，冲掉已发布的热更新。
   * mutateEffective() 在缓存有值时以内存生效值为基底（没有缓存才退回磁盘），
   * 既把残留哈希同步清出兜底文件，又不回退其它任何字段。
   */
  async mutateEffective(mutator: (data: T) => void | Promise<void>): Promise<T> {
    return this.withLock(async () => {
      const file: StoreFile<T> = this.cached
        ? { version: this.version, data: structuredClone(this.cached.data) }
        : this.readFromDisk();
      await mutator(file.data);
      file.version = this.version;
      this.writeToDisk(file);
      this.cached = file;
      this.cacheValid = true;
      return file.data;
    });
  }

  /**
   * 完全替换数据（用得少，但提供）
   */
  async replace(newData: T): Promise<T> {
    return this.withLock(async () => {
      const file: StoreFile<T> = { version: this.version, data: newData };
      this.writeToDisk(file);
      this.cached = file;
      this.cacheValid = true;
      return file.data;
    });
  }

  /**
   * 仅更新内存缓存，不写盘。
   * 用于 PG 单源模式下同步运行时配置（热更新），避免双写 settings.json。
   * 注意：下一次 read() 缓存有效时不会重读；但 mutate() 会强制从磁盘重新
   * 加载并覆盖这个缓存——PG 模式下需要顺带落盘（如清 adminPasswordHash
   * 残留）的写路径必须用 mutateEffective()，不能用 mutate()。
   */
  setCache(newData: T): void {
    this.cached = { version: this.version, data: structuredClone(newData) };
    this.cacheValid = true;
  }

  /**
   * 检查文件是否全新（刚创建，没有真实数据）
   */
  fileExists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * 获取文件路径
   */
  getFilePath(): string {
    return this.filePath;
  }
}
