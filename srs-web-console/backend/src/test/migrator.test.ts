import { describe, it, expect, beforeAll, afterAll, skip } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, getCurrentVersion } from '../store/migrator.js';

// 用专门的测试数据库，不和开发库混
// 需要 RUN_PG_TESTS=1 才执行，依赖 PG 容器可访问
const TEST_DB = process.env.TEST_PG_DATABASE || 'srs_console_test';
const PG_CONFIG = {
  host: process.env.TEST_PG_HOST || 'localhost',
  port: Number(process.env.TEST_PG_PORT || 5432),
  user: process.env.TEST_PG_USER || 'srs_console',
  password: process.env.TEST_PG_PASSWORD || 'srs_console',
  database: 'postgres', // 先连 postgres 建库
};

// 没有 PG 环境就整个跳过
const run = process.env.RUN_PG_TESTS ? describe : describe.skip;

async function createTestDb(): Promise<void> {
  const pool = new Pool(PG_CONFIG);
  try {
    await pool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await pool.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await pool.end();
  }
}

async function dropTestDb(): Promise<void> {
  const pool = new Pool(PG_CONFIG);
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

function getTestPool(): Pool {
  return new Pool({
    ...PG_CONFIG,
    database: TEST_DB,
  });
}

run('migrator', () => {
  beforeAll(async () => {
    await createTestDb();
  }, 30000);

  afterAll(async () => {
    await dropTestDb();
  }, 30000);

  it('空库执行迁移：所有迁移成功，版本号正确', async () => {
    const pool = getTestPool();
    try {
      const result = await runMigrations(pool);
      expect(result.applied).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
      expect(result.applied).toBe(result.total);

      const version = await getCurrentVersion(pool);
      expect(version).toBeGreaterThan(0);

      // 验证表存在
      const tables = await pool.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
      const names = tables.rows.map((r) => r.tablename);
      expect(names).toContain('config_documents');
      expect(names).toContain('config_versions');
      expect(names).toContain('config_snapshots');
      expect(names).toContain('config_service_states');
      expect(names).toContain('config_audit_logs');
      expect(names).toContain('config_secrets');
      expect(names).toContain('schema_migrations');
    } finally {
      await pool.end();
    }
  }, 15000);

  it('幂等：第二次运行迁移不重复执行', async () => {
    const pool = getTestPool();
    try {
      const r1 = await runMigrations(pool);
      const r2 = await runMigrations(pool);
      // 第二次应该 0 个新迁移
      expect(r2.applied).toBe(0);
      expect(r2.total).toBe(r1.total);
      // 版本号不变
      const v1 = await getCurrentVersion(pool);
      const r3 = await runMigrations(pool);
      const v2 = await getCurrentVersion(pool);
      expect(r3.applied).toBe(0);
      expect(v1).toBe(v2);
    } finally {
      await pool.end();
    }
  }, 15000);

  it('初始服务状态 4 条都在', async () => {
    const pool = getTestPool();
    try {
      await runMigrations(pool);
      const res = await pool.query(
        'SELECT service_name, status FROM config_service_states ORDER BY service_name',
      );
      expect(res.rows.length).toBe(4);
      const names = res.rows.map((r) => r.service_name);
      expect(names).toEqual(['ai-service', 'backend', 'recorder', 'srs']);
      for (const row of res.rows) {
        expect(row.status).toBe('unknown');
      }
    } finally {
      await pool.end();
    }
  }, 15000);
});
