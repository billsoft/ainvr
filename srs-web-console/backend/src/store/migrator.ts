/**
 * 简易数据库迁移器
 * - 读 migrations/ 目录下的 001_xxx.sql 文件
 * - 按版本号顺序执行，幂等（已执行的跳过，基于 schema_migrations 表）
 * - 每个 migration 在一个事务里执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

export interface MigrationRecord {
  version: number;
  name: string;
}

/** 解析 SQL 文件：按文件名前 3 位数字取版本号 */
function loadMigrationFiles(): { version: number; name: string; sql: string }[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((f) => {
    const match = f.match(/^(\d+)_?(.*)\.sql$/);
    if (!match) throw new Error(`迁移文件名不合法: ${f}（格式：001_name.sql）`);
    const version = Number(match[1]);
    const name = match[2] ?? f;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    return { version, name, sql };
  });
}

/** 确保 schema_migrations 表存在 */
async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(256) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** 获取已执行的版本 */
async function getAppliedVersions(pool: Pool): Promise<Set<number>> {
  const res = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(res.rows.map((r: { version: number }) => r.version));
}

/** 执行所有未执行的迁移；返回执行了多少个 */
export async function runMigrations(pool: Pool): Promise<{ applied: number; total: number }> {
  await ensureMigrationsTable(pool);
  const all = loadMigrationFiles();
  const applied = await getAppliedVersions(pool);

  let count = 0;
  for (const mig of all) {
    if (applied.has(mig.version)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(mig.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [mig.version, mig.name],
      );
      await client.query('COMMIT');
      count += 1;
      console.info(`[migrator] v${mig.version} ${mig.name} ✅`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`[migrator] v${mig.version} ${mig.name} ❌ 失败`);
      throw e;
    } finally {
      client.release();
    }
  }

  return { applied: count, total: all.length };
}

/** 获取当前数据库版本（已应用的最新版本号） */
export async function getCurrentVersion(pool: Pool): Promise<number> {
  await ensureMigrationsTable(pool);
  const res = await pool.query(
    'SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations',
  );
  return Number(res.rows[0]!.v);
}
