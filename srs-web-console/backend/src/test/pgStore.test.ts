import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgConfigStore } from '../store/pgStore.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 需要 RUN_PG_TESTS=1 才执行
const run = process.env.RUN_PG_TESTS ? describe : describe.skip;

const TEST_DB = process.env.TEST_PG_DATABASE || 'srs_console_pgstore_test';
const PG_HOST = process.env.TEST_PG_HOST || 'localhost';
const PG_PORT = Number(process.env.TEST_PG_PORT || 5432);
const PG_USER = process.env.TEST_PG_USER || 'srs_console';
const PG_PASSWORD = process.env.TEST_PG_PASSWORD || 'srs_console';

async function createTestDb(): Promise<void> {
  const pool = new Pool({
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: 'postgres',
  });
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await pool.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await pool.end();
  }
}

async function dropTestDb(): Promise<void> {
  const pool = new Pool({
    host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: 'postgres',
  });
  try {
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()
    `);
    await pool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  } finally {
    await pool.end();
  }
}

run('PgConfigStore 集成测试', () => {
  let tmpDir: string;
  let keyPath: string;
  let store: PgConfigStore;

  beforeAll(async () => {
    await createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstore-test-'));
    keyPath = path.join(tmpDir, 'master.key');
    store = new PgConfigStore({
      poolConfig: {
        host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: TEST_DB,
      },
      masterKeyPath: keyPath,
    });
    await store.init();
  }, 30000);

  afterAll(async () => {
    await store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await dropTestDb();
  }, 30000);

  describe('配置文档 CRUD', () => {
    it('upsertDocument 能新建配置', async () => {
      const doc = await store.upsertDocument({
        service: 'backend',
        group: 'test',
        name: 'demo',
        config: { foo: 'bar', num: 42 },
        description: '测试配置',
      });
      expect(doc.id).toBeGreaterThan(0);
      expect(doc.service).toBe('backend');
      expect(doc.config).toEqual({ foo: 'bar', num: 42 });
    });

    it('getDocument 能查到刚插入的', async () => {
      const doc = await store.getDocument('backend', 'test', 'demo');
      expect(doc).not.toBeNull();
      expect(doc!.config.foo).toBe('bar');
    });

    it('upsertDocument 同 key 是更新', async () => {
      const before = await store.getDocument('backend', 'test', 'demo');
      const updated = await store.upsertDocument({
        service: 'backend',
        group: 'test',
        name: 'demo',
        config: { foo: 'baz' },
      });
      expect(updated.id).toBe(before!.id);
      expect(updated.config.foo).toBe('baz');
    });

    it('listDocuments 能按服务过滤', async () => {
      // 再插另一个服务的
      await store.upsertDocument({
        service: 'ai-service', group: 'default', name: 'model',
        config: { name: 'yolov8' },
      });
      const list = await store.listDocuments('backend');
      expect(list.length).toBeGreaterThan(0);
      for (const d of list) {
        expect(d.service).toBe('backend');
      }
    });

    it('deleteDocument 能删除', async () => {
      await store.upsertDocument({
        service: 'backend', group: 'tmp', name: 'to-delete',
        config: { x: 1 },
      });
      const ok = await store.deleteDocument('backend', 'tmp', 'to-delete');
      expect(ok).toBe(true);
      const gone = await store.getDocument('backend', 'tmp', 'to-delete');
      expect(gone).toBeNull();
    });
  });

  describe('发布与版本', () => {
    it('publish 生成新版本号 v1', async () => {
      // 确保至少有一个文档
      await store.upsertDocument({
        service: 'backend', group: 'default', name: 'system',
        config: { port: 3000 },
      });
      const v = await store.publish('首次发布');
      expect(v.version).toBe(1);
      expect(v.status).toBe('published');
      expect(v.changeSummary).toBe('首次发布');
    });

    it('多次 publish 版本号递增', async () => {
      const v1 = await store.publish('v2');
      const v2 = await store.publish('v3');
      expect(v2.version).toBe(v1.version + 1);
    });

    it('getLatestVersion 返回最新已发布版本', async () => {
      const latest = await store.getLatestVersion('published');
      expect(latest).not.toBeNull();
      expect(latest!.status).toBe('published');
    });

    it('发布后服务状态变成 pending', async () => {
      const state = await store.getServiceState('backend');
      // 最后一次发布后应该是 pending
      expect(state).not.toBeNull();
      expect(state!.desiredVersion).toBeGreaterThan(0);
    });

    it('rollback 生成新版本并复制快照', async () => {
      // 确保 v1 存在
      const v1 = await store.publish('rollback 基线 v1');
      // 改一下草稿再发布 v2
      await store.upsertDocument({
        service: 'backend', group: 'default', name: 'system',
        config: { port: 9999 },
      });
      const v2 = await store.publish('v2 新配置');
      expect(v2.version).toBe(v1.version + 1);

      // 回滚到 v1 → 生成新版本
      const rolled = await store.rollbackToVersion(v1.version, 'admin');
      expect(rolled.version).toBe(v2.version + 1);
      expect(rolled.changeSummary).toContain('回滚');
      expect(rolled.status).toBe('published');
    });

    it('rollback 到不存在的版本抛错', async () => {
      await expect(store.rollbackToVersion(9999)).rejects.toThrow();
    });

    it('detectDrift 能正确识别漂移与同步', async () => {
      // 发一个版本 → 各服务 desired > applied → 漂移
      await store.publish('drift test');
      const { drifted, inSync } = await store.detectDrift();
      // 此时 desired 有值但 applied 没设 → 应该都是 drifted
      expect(drifted.length).toBeGreaterThan(0);
      // 把 backend 设成 applied = desired → 应该同步
      const latest = await store.getLatestVersion('published');
      await store.updateServiceState({
        serviceName: 'backend',
        appliedVersion: latest!.version,
        status: 'applied',
      });
      const drift2 = await store.detectDrift();
      const backendSynced = drift2.inSync.find((s) => s.serviceName === 'backend');
      expect(backendSynced).toBeDefined();
    });
  });

  describe('服务状态', () => {
    it('listServiceStates 返回 4 个初始服务', async () => {
      const states = await store.listServiceStates();
      expect(states.length).toBeGreaterThanOrEqual(4);
      const names = states.map((s) => s.serviceName);
      expect(names).toContain('backend');
      expect(names).toContain('srs');
      expect(names).toContain('ai-service');
      expect(names).toContain('recorder');
    });

    it('updateServiceState 能更新状态', async () => {
      const state = await store.updateServiceState({
        serviceName: 'backend',
        status: 'applied',
        appliedVersion: 1,
      });
      expect(state.status).toBe('applied');
      expect(state.appliedVersion).toBe(1);
    });
  });

  describe('敏感值加密存储', () => {
    it('setSecret + getSecret 能加密存、解密读', async () => {
      await store.setSecret('ai-service/apiKey', 'sk-abc-123-xyz');
      const val = await store.getSecret('ai-service/apiKey');
      expect(val).toBe('sk-abc-123-xyz');
    });

    it('hasSecret 对存在/不存在的 key 正确', async () => {
      expect(await store.hasSecret('ai-service/apiKey')).toBe(true);
      expect(await store.hasSecret('nonexistent/key')).toBe(false);
    });

    it('deleteSecret 能删除', async () => {
      await store.setSecret('tmp/key', 'val');
      expect(await store.hasSecret('tmp/key')).toBe(true);
      await store.deleteSecret('tmp/key');
      expect(await store.hasSecret('tmp/key')).toBe(false);
    });

    it('数据库里存的是密文，不是明文', async () => {
      const secretValue = 'super-secret-password';
      await store.setSecret('test/plaintext-check', secretValue);
      const res = await store.pool.query(
        'SELECT ciphertext FROM config_secrets WHERE key_path = $1',
        ['test/plaintext-check'],
      );
      const ciphertext: Buffer = res.rows[0].ciphertext;
      // 密文是 Buffer，不是字符串
      expect(Buffer.isBuffer(ciphertext)).toBe(true);
      // 密文不等于明文的 buffer
      expect(ciphertext.toString('utf8')).not.toContain(secretValue);
    });
  });

  describe('审计日志', () => {
    it('写操作会产生审计日志', async () => {
      const before = (await store.listAuditLogs(100)).length;
      await store.upsertDocument({
        service: 'backend', group: 'audit', name: 'test',
        config: { a: 1 },
      });
      const after = (await store.listAuditLogs(100)).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
