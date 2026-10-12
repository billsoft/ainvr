import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgConfigStore } from '../store/pgStore.js';
import { PublishOrchestrator } from '../store/publishOrchestrator.js';
import { StubConfigAdapter, PullModeAdapter } from '../store/adapter.js';
import type { ApplyResult } from '../store/adapter.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const run = process.env.RUN_PG_TESTS ? describe : describe.skip;

const TEST_DB = process.env.TEST_PG_DATABASE || 'srs_console_orch_test';
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

/** 总是成功的 mock 适配器 */
class SuccessAdapter extends StubConfigAdapter {
  public lastDocs: any[] = [];
  public lastVersion = 0;
  callCount = 0;

  constructor(name: string, private readonly applyVia: 'hot' | 'restart' = 'hot') {
    super(name);
  }

  override async apply(docs: any[], version: number): Promise<ApplyResult> {
    this.callCount++;
    this.lastDocs = docs;
    this.lastVersion = version;
    return { ok: true, applyVia: this.applyVia, restartRequired: this.applyVia === 'restart', appliedVersion: version };
  }

  override async rollback(docs: any[], version: number): Promise<ApplyResult> {
    this.callCount++;
    this.lastDocs = docs;
    this.lastVersion = version;
    return { ok: true, applyVia: 'hot', restartRequired: false, appliedVersion: version };
  }
}

/** 总是失败的 mock 适配器 */
class FailAdapter extends StubConfigAdapter {
  callCount = 0;
  constructor(name: string, private readonly errorMsg: string = 'mock error') { super(name); }
  override async apply() {
    this.callCount++;
    return { ok: false, applyVia: 'rejected' as const, restartRequired: false, error: this.errorMsg };
  }
  override async rollback() {
    this.callCount++;
    return { ok: false, applyVia: 'rejected' as const, restartRequired: false, error: this.errorMsg };
  }
}

run('发布编排器集成测试', () => {
  let store: PgConfigStore;
  let tmpDir: string;

  beforeAll(async () => {
    await createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
    store = new PgConfigStore({
      poolConfig: { host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: TEST_DB },
      masterKeyPath: path.join(tmpDir, 'master.key'),
    });
    await store.init();
  }, 30000);

  afterAll(async () => {
    await store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await dropTestDb();
  }, 30000);

  // 每个用例前清空业务表，保留 schema_migrations
  beforeEach(async () => {
    await store.pool.query('TRUNCATE config_documents, config_versions, config_snapshots, config_audit_logs CASCADE');
    await store.pool.query(`
      UPDATE config_service_states
      SET status = 'unknown',
          applied_version = NULL,
          desired_version = NULL,
          restart_required = false,
          error_message = NULL,
          applied_at = NULL,
          last_check_at = NULL
    `);
  });

  describe('publish', () => {
    it('只有 backend 配置时：1 个服务成功，整体 all_ok', async () => {
      await store.upsertDocument({
        service: 'backend', group: 'system', name: 'test',
        config: { port: 3001 },
      });
      const adapter = new SuccessAdapter('backend');
      const orch = new PublishOrchestrator(store, [adapter]);

      // 预置一条历史错误（上一次失败发布残留），发布成功后必须被清空
      await store.updateServiceState({
        serviceName: 'backend', status: 'failed', errorMessage: '上一次失败的残留错误',
      });

      const result = await orch.publish('test v1', 'tester');
      expect(result.overallStatus).toBe('all_ok');
      expect(result.results.length).toBe(1);
      expect(result.results[0]!.service).toBe('backend');
      expect(result.results[0]!.ok).toBe(true);
      expect(result.results[0]!.applyVia).toBe('hot');
      expect(adapter.callCount).toBe(1);
      expect(adapter.lastVersion).toBe(result.version.version);

      // 服务状态应是 applied，且历史错误被清空
      const state = await store.getServiceState('backend');
      expect(state!.status).toBe('applied');
      expect(state!.appliedVersion).toBe(result.version.version);
      expect(state!.errorMessage).toBe('');
    });

    it('多个服务部分失败：整体 partial', async () => {
      await store.upsertDocument({
        service: 'backend', group: 'test', name: 'a',
        config: { a: 1 },
      });
      await store.upsertDocument({
        service: 'ai-service', group: 'test', name: 'b',
        config: { b: 2 },
      });
      const ok = new SuccessAdapter('backend');
      const fail = new FailAdapter('ai-service');
      const orch = new PublishOrchestrator(store, [ok, fail]);

      const result = await orch.publish('partial test');
      expect(result.overallStatus).toBe('partial');
      expect(result.results.length).toBe(2);

      const backendR = result.results.find(r => r.service === 'backend')!;
      const aiR = result.results.find(r => r.service === 'ai-service')!;
      expect(backendR.ok).toBe(true);
      expect(aiR.ok).toBe(false);
      expect(aiR.error).toContain('mock error');

      // 状态分别是 applied 和 failed
      const s1 = await store.getServiceState('backend');
      const s2 = await store.getServiceState('ai-service');
      expect(s1!.status).toBe('applied');
      expect(s2!.status).toBe('failed');
    });

    it('所有服务失败：整体 all_failed', async () => {
      await store.upsertDocument({
        service: 'srs', group: 'test', name: 'x', config: { x: 1 },
      });
      await store.upsertDocument({
        service: 'recorder', group: 'test', name: 'y', config: { y: 1 },
      });
      const orch = new PublishOrchestrator(store, [
        new FailAdapter('srs'),
        new FailAdapter('recorder'),
      ]);

      const result = await orch.publish('all fail');
      expect(result.overallStatus).toBe('all_failed');
      expect(result.results.length).toBe(2);
      for (const r of result.results) {
        expect(r.ok).toBe(false);
      }
    });

    it('pull 模式服务：发布置 pending 不声称 applied，服务自报后覆盖', async () => {
      await store.upsertDocument({
        service: 'recorder', group: 'system', name: 'settings',
        config: { files: { segmentSeconds: 60 } },
      });
      const orch = new PublishOrchestrator(store, [new PullModeAdapter('recorder')]);

      const result = await orch.publish('pull test');
      // 全部为 pull 模式服务：发布成功但等待各服务自行拉取 → all_pending
      expect(result.overallStatus).toBe('all_pending');
      const r = result.results[0]!;
      expect(r.ok).toBe(true);
      expect(r.applyVia).toBe('pull');
      expect(r.appliedVersion).toBeUndefined();

      // 发布后的服务状态：desired 已指向新版本，但状态是 pending（等待拉取），不是 applied
      const state = await store.getServiceState('recorder');
      expect(state!.status).toBe('pending');
      expect(state!.desiredVersion).toBe(result.version.version);
      expect(state!.appliedVersion).toBeUndefined();

      // 服务拉取应用后自报（与 recorder 客户端同路径：POST service-states）
      await store.updateServiceState({
        serviceName: 'recorder',
        appliedVersion: result.version.version,
        status: 'applied',
        errorMessage: '',
      });
      const after = await store.getServiceState('recorder');
      expect(after!.status).toBe('applied');
      expect(after!.appliedVersion).toBe(result.version.version);
    });

    it('未注册适配器的服务：rejected', async () => {
      await store.upsertDocument({
        service: 'unknown-svc', group: 'test', name: 'z', config: { z: 1 },
      });
      const orch = new PublishOrchestrator(store, []);
      const result = await orch.publish('unknown');
      const r = result.results.find(x => x.service === 'unknown-svc')!;
      expect(r.ok).toBe(false);
      expect(r.applyVia).toBe('rejected');
      expect(r.error).toContain('未注册');
    });

    it('restart 类配置：状态是 partial', async () => {
      await store.upsertDocument({
        service: 'backend', group: 'restart', name: 'svc',
        config: { needsRestart: true },
      });
      const adapter = new SuccessAdapter('backend', 'restart');
      const orch = new PublishOrchestrator(store, [adapter]);

      const result = await orch.publish('restart test');
      expect(result.results[0]!.restartRequired).toBe(true);
      expect(result.results[0]!.applyVia).toBe('restart');

      // 状态是 partial（需要重启才算完全 applied）
      const state = await store.getServiceState('backend');
      expect(state!.status).toBe('partial');
    });
  });

  // 2026-09-16：PublishOrchestrator.rollbackToVersion() 已随"版本历史/
  // 回滚"UI 一起下线（唯一调用方 POST /v1/config/versions/:version/rollback
  // 路由已删除），原 describe('rollback', ...) 用例随之移除。
  // pgStore.rollbackToVersion() 数据层方法未删，见 pgStore.test.ts。

  describe('validatePublish', () => {
    it('校验通过时 ok=true', async () => {
      await store.upsertDocument({
        service: 'backend', group: 'val', name: 'ok',
        config: { ok: true },
      });
      const orch = new PublishOrchestrator(store, [
        new SuccessAdapter('backend'),
      ]);
      const result = await orch.validatePublish();
      expect(result.ok).toBe(true);
      expect(result.perService.length).toBe(1);
      expect(result.perService[0]!.ok).toBe(true);
    });

    it('未注册适配器的服务校验不通过', async () => {
      await store.upsertDocument({
        service: 'unregistered', group: 'val', name: 'x',
        config: { x: 1 },
      });
      const orch = new PublishOrchestrator(store, []);
      const result = await orch.validatePublish();
      expect(result.ok).toBe(false);
      const svc = result.perService.find(s => s.service === 'unregistered')!;
      expect(svc.ok).toBe(false);
      expect(svc.errors[0]).toContain('未注册');
    });
  });

  // BackendConfigAdapter 的单测见 backendAdapter.test.ts（不需要 PG）：
  // 覆盖 setCache 热生效、srsApiHost 热切换、非法 settings 拒绝。
});
