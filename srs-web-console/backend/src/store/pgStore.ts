import { CONFIG_HISTORY_RETENTION_SQL } from './configRetention.js';
/**
 * PostgreSQL 配置仓库：统一配置中心的唯一存储入口
 * - 管理配置文档的 CRUD、版本、发布、回滚
 * - 敏感值通过 crypto 模块加密存 config_secrets 表
 * - 所有写操作都带事务
 */
import { Pool, PoolConfig } from 'pg';
import { CryptoStore } from './crypto.js';
import { runMigrations, getCurrentVersion } from './migrator.js';
import { CONFIG_SERVICES } from './services.js';

export interface ConfigDocument {
  id: number;
  service: string;
  group: string;
  name: string;
  config: Record<string, unknown>;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConfigVersion {
  id: number;
  version: number;
  status: 'draft' | 'published' | 'archived';
  publishedBy?: string;
  publishedAt?: Date;
  changeSummary?: string;
  createdAt: Date;
}

export interface ServiceState {
  serviceName: string;
  appliedVersion?: number;
  desiredVersion?: number;
  // restarting：backend 经重启助手（host-restart-helper）触发了
  // systemctl restart，还没等到服务重启后的自报——是个短暂过渡态，
  // 服务重新拉取配置并自报 applied/failed 后会被覆盖掉。
  status: 'pending' | 'applied' | 'partial' | 'failed' | 'unknown' | 'restarting';
  restartRequired: boolean;
  errorMessage?: string;
  appliedAt?: Date;
  lastCheckAt?: Date;
}

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  service?: string;
  group?: string;
  configName?: string;
  versionBefore?: number;
  versionAfter?: number;
  detail?: Record<string, unknown>;
  ipAddress?: string;
  createdAt: Date;
}

export class PgConfigStore {
  readonly pool: Pool;
  private readonly crypto: CryptoStore;

  constructor(opts: { poolConfig: PoolConfig; masterKeyPath: string }) {
    this.pool = new Pool({ connectionTimeoutMillis: 5000, statement_timeout: 15000,
      query_timeout: 20000, idle_in_transaction_session_timeout: 20000, ...opts.poolConfig });
    this.crypto = new CryptoStore(opts.masterKeyPath);
    // 首次查询时触发密钥加载/生成（避免构造函数抛错影响测试）

    // 空闲连接被服务端主动关闭（PostgreSQL 重启 / 被管理命令 terminate，
    // 例如 57P01 administrator command）时，node-postgres 会把错误投递到
    // pool 的 'error' 事件；EventEmitter 对无监听者的 'error' 默认抛未捕获
    // 异常——2026-09-19 事故中正是这一条直接崩掉了整个 BFF 进程。这里记录
    // 即可：坏连接会在下次取用前被剔除并自动新建，运行期查询无需重启进程
    // 就能在 PG 恢复后自愈。
    this.pool.on('error', (err: Error) => {
      console.error('[pgStore] 连接池空闲连接错误（忽略，连接将自动重建）:', err.message);
    });
  }

  /** 启动：跑 migration → 返回当前版本 */
  async init(): Promise<number> {
    const result = await runMigrations(this.pool);
    const version = await getCurrentVersion(this.pool);
    console.info(`[pgStore] 数据库就绪，schema 版本 v${version}（本次应用 ${result.applied} 个迁移）`);
    this.crypto.loadMasterKey();
    await this.migrateMongoSecrets();
    return version;
  }

  /** Encrypt both legacy documents and snapshots. Historical values have
   * independent keys, so a historical snapshot never adopts today's URI. */
  private async migrateMongoSecrets(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('mongo_secret_migration'))");
      for (const table of ['config_documents', 'config_snapshots']) {
        const rows = await client.query(`SELECT id, config FROM ${table} WHERE service='ai-service' FOR UPDATE`);
        for (const row of rows.rows) {
          const config = row.config;
          const snap = config?.snapshot_store;
          if (!snap || typeof snap !== 'object') continue;
          let changed = false;
          for (const field of ['mongo_uri', 'mongo_readonly_password']) {
            const value = snap[field];
            if (typeof value !== 'string' || !value || value.startsWith('${secret:')) continue;
            const key = `ai-service/snapshot_store.${field}/legacy-${table}-${row.id}`;
            await client.query(`INSERT INTO config_secrets(key_path,ciphertext,algorithm,key_version)
              VALUES($1,$2,'aes-256-gcm',1) ON CONFLICT(key_path) DO NOTHING`, [key, this.crypto.encrypt(value)]);
            snap[field] = '${secret:' + key + '}';
            changed = true;
          }
          if (changed) await client.query(`UPDATE ${table} SET config=$1 WHERE id=$2`, [JSON.stringify(config), row.id]);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---- 配置文档 ----

  async getDocument(service: string, group: string, name: string): Promise<ConfigDocument | null> {
    const res = await this.pool.query(
      'SELECT * FROM config_documents WHERE service = $1 AND "group" = $2 AND name = $3',
      [service, group, name],
    );
    return res.rows[0] ? this.mapDoc(res.rows[0]) : null;
  }

  async listDocuments(service?: string, group?: string): Promise<ConfigDocument[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (service) { conds.push(`service = $${idx++}`); params.push(service); }
    if (group) { conds.push(`"group" = $${idx++}`); params.push(group); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT * FROM config_documents ${where} ORDER BY service, "group", name`,
      params,
    );
    return res.rows.map((r) => this.mapDoc(r));
  }

  async upsertDocument(doc: Omit<ConfigDocument, 'id' | 'createdAt' | 'updatedAt'>, actor = 'admin'): Promise<ConfigDocument> {
    return this.transaction(async client => {
      const res = await client.query(
        `INSERT INTO config_documents (service, "group", name, config, description)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (service, "group", name) DO UPDATE
           SET config = EXCLUDED.config, description = EXCLUDED.description, updated_at = now()
         RETURNING *`,
        [doc.service, doc.group, doc.name, JSON.stringify(doc.config), doc.description ?? null],
      );
      const newDoc = this.mapDoc(res.rows[0]!);
      await this.addAuditLog({
        actor, action: 'update', service: doc.service, group: doc.group, configName: doc.name,
      }, client);
      return newDoc;
    });
  }

  async deleteDocument(service: string, group: string, name: string, actor = 'admin'): Promise<boolean> {
    return this.transaction(async client => {
      const res = await client.query(
        'DELETE FROM config_documents WHERE service = $1 AND "group" = $2 AND name = $3 RETURNING id',
        [service, group, name],
      );
      if (res.rowCount) {
        await this.addAuditLog({ actor, action: 'delete', service, group, configName: name }, client);
      }
      return (res.rowCount ?? 0) > 0;
    });
  }

  // ---- 版本 & 发布 ----

  async getLatestVersion(status?: 'draft' | 'published' | 'archived'): Promise<ConfigVersion | null> {
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const res = await this.pool.query(
      `SELECT * FROM config_versions ${where} ORDER BY version DESC LIMIT 1`,
      params,
    );
    return res.rows[0] ? this.mapVersion(res.rows[0]) : null;
  }

  async listVersions(limit = 50): Promise<ConfigVersion[]> {
    const res = await this.pool.query(
      'SELECT * FROM config_versions ORDER BY version DESC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => this.mapVersion(r));
  }

  /** 获取某个版本的完整快照（按服务分组前的扁平列表） */
  async getVersionSnapshot(version: number): Promise<ConfigDocument[] | null> {
    const verRes = await this.pool.query(
      'SELECT id FROM config_versions WHERE version = $1',
      [version],
    );
    if (verRes.rows.length === 0) return null;
    const versionId = Number(verRes.rows[0]!.id);

    const snapRes = await this.pool.query(
      `SELECT service, "group", name, config
       FROM config_snapshots
       WHERE version_id = $1
       ORDER BY service, "group", name`,
      [versionId],
    );
    if (snapRes.rows.length === 0) return [];

    return snapRes.rows.map((r: Record<string, unknown>) => this.mapDoc({
      id: 0, ...r,
      created_at: null, updated_at: null,
      // 快照没有 description 字段，补 null
      description: (r as any).description ?? null,
    }));
  }

  /** 按服务名筛选某版本的快照文档 */
  async getVersionSnapshotForService(version: number, service: string): Promise<ConfigDocument[]> {
    const all = await this.getVersionSnapshot(version);
    if (!all) return [];
    return all.filter((d) => d.service === service);
  }

  /** 发布：把当前所有文档快照 → 生成新版本 → 标记为 published
   *  版本号用 INSERT...SELECT 原子生成 + advisory lock 串行化，避免并发重复 */
  async publish(changeSummary = '', actor = 'admin', options?: {
    signal?: AbortSignal;
    services: string[];
    prepare: (client: import('pg').PoolClient) => Promise<void>;
  }): Promise<ConfigVersion> {
    options?.signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 用 advisory lock 让 publish 全局串行化（锁 key = 哈希 'config_publish'）
      // 保证同事务内 INSERT...SELECT MAX+1 不会被并发干扰
      await client.query('SELECT pg_advisory_xact_lock(hashtext(\'config_publish\'))');
      // Automatic saves merge, validate and store documents/secrets in this same
      // transaction. A rejected save must never become visible to pull clients.
      options?.signal?.throwIfAborted();
      if (options) await options.prepare(client);
      options?.signal?.throwIfAborted();

      // 原子生成下一个版本号：子查询取 MAX + 1，配合唯一约束 + 上面的锁保证安全
      const verRes = await client.query(
        `INSERT INTO config_versions (version, status, published_by, published_at, change_summary)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM config_versions),
                 'published', $1, now(), $2)
         RETURNING *`,
        [actor, changeSummary],
      );
      const version = this.mapVersion(verRes.rows[0]!);
      const nextVersion = version.version;

      // 快照所有文档
      const docsRes = await client.query('SELECT * FROM config_documents ORDER BY service, "group", name');
      for (const doc of docsRes.rows) {
        await client.query(
          `INSERT INTO config_snapshots (version_id, service, "group", name, config)
           VALUES ($1, $2, $3, $4, $5)`,
          [version.id, doc.service, doc.group, doc.name, doc.config],
        );
      }

      // 各服务状态设为 pending（名单唯一定义见 store/services.ts）
      const services = options?.services ?? [...CONFIG_SERVICES];
      for (const svc of services) {
        await client.query(
          `INSERT INTO config_service_states (service_name, desired_version, status, restart_required)
           VALUES ($1, $2, 'pending', false)
           ON CONFLICT (service_name) DO UPDATE
             SET desired_version = EXCLUDED.desired_version, status = 'pending', restart_required = false, updated_at = now()`,
          [svc, nextVersion],
        );
      }

      options?.signal?.throwIfAborted();
      await this.addAuditLog({
        actor, action: 'publish', versionAfter: nextVersion,
        detail: { changeSummary },
      }, client);
      options?.signal?.throwIfAborted();
      await client.query('COMMIT');

      return version;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** 回滚到指定版本（第 1 步骨架：仅回退快照 + 设 pending，实际逐服务下发第 2 步实现）
   *  同样使用 advisory lock 串行化，避免并发回滚冲突 */
  async rollbackToVersion(targetVersion: number, actor = 'admin'): Promise<ConfigVersion> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext(\'config_publish\'))');

      // 确认目标版本存在且已发布
      const targetRes = await client.query(
        'SELECT * FROM config_versions WHERE version = $1 AND status = \'published\'',
        [targetVersion],
      );
      if (targetRes.rows.length === 0) {
        throw new Error(`版本 v${targetVersion} 不存在或未发布，无法回滚`);
      }
      const target = this.mapVersion(targetRes.rows[0]!);

      // 原子生成新版本（标记为回滚
      const verRes = await client.query(
        `INSERT INTO config_versions (version, status, published_by, published_at, change_summary)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM config_versions),
                 'published', $1, now(), $2)
         RETURNING *`,
        [actor, `回滚到 v${targetVersion}`],
      );
      const newVersion = this.mapVersion(verRes.rows[0]!);

      // 快照：从目标版本的快照复制为新版本的快照
      await client.query(
        `INSERT INTO config_snapshots (version_id, service, "group", name, config)
         SELECT $1, service, "group", name, config
         FROM config_snapshots
         WHERE version_id = $2`,
        [newVersion.id, target.id],
      );

      // 各服务状态设为 pending（等待逐服务下发；名单唯一定义见 store/services.ts）
      const services = [...CONFIG_SERVICES];
      for (const svc of services) {
        await client.query(
          `INSERT INTO config_service_states (service_name, desired_version, status, restart_required)
           VALUES ($1, $2, 'pending', false)
           ON CONFLICT (service_name) DO UPDATE
             SET desired_version = EXCLUDED.desired_version, status = 'pending',
                 restart_required = false, updated_at = now()`,
          [svc, newVersion.version],
        );
      }

      await this.addAuditLog({
        actor, action: 'rollback',
        versionBefore: targetVersion, versionAfter: newVersion.version,
        detail: { targetVersion, rollback: true },
      }, client);
      await client.query('COMMIT');

      return newVersion;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** 配置漂移检测：对比 desired_version 与 applied_version 不一致的服务 */
  async detectDrift(): Promise<{ drifted: ServiceState[]; inSync: ServiceState[] }> {
    const all = await this.listServiceStates();
    const drifted = all.filter(
      (s) => s.desiredVersion != null && s.appliedVersion !== s.desiredVersion,
    );
    const inSync = all.filter(
      (s) => s.desiredVersion == null || s.appliedVersion === s.desiredVersion,
    );
    return { drifted, inSync };
  }

  // ---- 服务状态 ----

  async getServiceState(serviceName: string): Promise<ServiceState | null> {
    const res = await this.pool.query(
      'SELECT * FROM config_service_states WHERE service_name = $1',
      [serviceName],
    );
    return res.rows[0] ? this.mapServiceState(res.rows[0]) : null;
  }

  async listServiceStates(): Promise<ServiceState[]> {
    const res = await this.pool.query('SELECT * FROM config_service_states ORDER BY service_name');
    return res.rows.map((r) => this.mapServiceState(r));
  }

  async updateServiceState(state: Partial<ServiceState> & { serviceName: string }): Promise<ServiceState> {
    // 用 INSERT ... ON CONFLICT DO UPDATE，服务不存在也能插入
    const assignments: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    values.push(state.serviceName); // $1 = service_name
    const serviceNameIdx = idx++;

    const setFields: string[] = [];

    if (state.appliedVersion !== undefined) {
      values.push(state.appliedVersion);
      setFields.push(`applied_version = EXCLUDED.applied_version`);
    }
    if (state.desiredVersion !== undefined) {
      values.push(state.desiredVersion);
      setFields.push(`desired_version = EXCLUDED.desired_version`);
    }
    if (state.status !== undefined) {
      values.push(state.status);
      setFields.push(`status = EXCLUDED.status`);
    }
    if (state.restartRequired !== undefined) {
      values.push(state.restartRequired);
      setFields.push(`restart_required = EXCLUDED.restart_required`);
    }
    if (state.errorMessage !== undefined) {
      values.push(state.errorMessage);
      setFields.push(`error_message = EXCLUDED.error_message`);
    }
    if (state.appliedAt !== undefined) {
      values.push(state.appliedAt);
      setFields.push(`applied_at = EXCLUDED.applied_at`);
    }
    // last_check_at 始终更新为 now
    setFields.push(`last_check_at = now()`);

    // 组装列列表（INSERT 的列）
    const insertCols = ['service_name'];
    const placeholders = [`$${serviceNameIdx}`];

    let colIdx = 2; // $1 已经用了 service_name
    if (state.appliedVersion !== undefined) {
      insertCols.push('applied_version'); placeholders.push(`$${colIdx++}`);
    }
    if (state.desiredVersion !== undefined) {
      insertCols.push('desired_version'); placeholders.push(`$${colIdx++}`);
    }
    if (state.status !== undefined) {
      insertCols.push('status'); placeholders.push(`$${colIdx++}`);
    }
    if (state.restartRequired !== undefined) {
      insertCols.push('restart_required'); placeholders.push(`$${colIdx++}`);
    }
    if (state.errorMessage !== undefined) {
      insertCols.push('error_message'); placeholders.push(`$${colIdx++}`);
    }
    if (state.appliedAt !== undefined) {
      insertCols.push('applied_at'); placeholders.push(`$${colIdx++}`);
    }

    const sql = `
      INSERT INTO config_service_states (${insertCols.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (service_name) DO UPDATE SET
        ${setFields.join(', ')}
      RETURNING *
    `;

    const res = await this.pool.query(sql, values);
    return this.mapServiceState(res.rows[0]!);
  }

  // ---- 审计 ----

  private async transaction<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async addAuditLog(entry: Partial<AuditLogEntry>, client: Pick<import('pg').PoolClient, 'query'> = this.pool): Promise<void> {
    await client.query(
      `INSERT INTO config_audit_logs (actor, action, service, "group", config_name,
          version_before, version_after, detail, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.actor ?? 'admin', entry.action!,
        entry.service ?? null, entry.group ?? null, entry.configName ?? null,
        entry.versionBefore ?? null, entry.versionAfter ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ipAddress ?? null,
      ],
    );
    await client.query(CONFIG_HISTORY_RETENTION_SQL);
  }

  async listAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    const res = await this.pool.query(
      'SELECT * FROM config_audit_logs ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => this.mapAudit(r));
  }

  // ---- 敏感值 ----

  async setSecret(keyPath: string, plainValue: string, actor = 'admin'): Promise<void> {
    const blob = this.crypto.encrypt(plainValue);
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO config_secrets (key_path, ciphertext, algorithm, key_version)
         VALUES ($1, $2, 'aes-256-gcm', 1)
         ON CONFLICT (key_path) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext, algorithm = EXCLUDED.algorithm, key_version = EXCLUDED.key_version, updated_at = now()`,
        [keyPath, blob],
      );
      await this.addAuditLog({ actor, action: 'set-secret', configName: keyPath }, client);
    });
  }

  /** 加密明文（对外暴露，供同事务写入 secret 使用（import 等场景） */
  encryptSecret(plainValue: string): Buffer {
    return this.crypto.encrypt(plainValue);
  }

  async getSecret(keyPath: string): Promise<string | null> {
    const res = await this.pool.query(
      'SELECT ciphertext FROM config_secrets WHERE key_path = $1',
      [keyPath],
    );
    if (res.rows.length === 0) return null;
    return this.crypto.decrypt(res.rows[0]!.ciphertext);
  }

  async hasSecret(keyPath: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM config_secrets WHERE key_path = $1',
      [keyPath],
    );
    return res.rows.length > 0;
  }

  async deleteSecret(keyPath: string, actor = 'admin'): Promise<boolean> {
    return this.transaction(async client => {
      const res = await client.query(
        'DELETE FROM config_secrets WHERE key_path = $1 RETURNING id',
        [keyPath],
      );
      if (res.rowCount) {
        await this.addAuditLog({ actor, action: 'delete-secret', configName: keyPath }, client);
      }
      return (res.rowCount ?? 0) > 0;
    });
  }

  // ---- 映射器 ----

  private mapDoc(r: Record<string, unknown>): ConfigDocument {
    return {
      id: Number(r.id),
      service: r.service as string,
      group: r.group as string,
      name: r.name as string,
      config: (r.config ?? {}) as Record<string, unknown>,
      description: r.description as string | undefined,
      createdAt: r.created_at as Date,
      updatedAt: r.updated_at as Date,
    };
  }

  private mapVersion(r: Record<string, unknown>): ConfigVersion {
    return {
      id: Number(r.id),
      version: Number(r.version),
      status: r.status as ConfigVersion['status'],
      publishedBy: r.published_by as string | undefined,
      publishedAt: r.published_at as Date | undefined,
      changeSummary: r.change_summary as string | undefined,
      createdAt: r.created_at as Date,
    };
  }

  private mapServiceState(r: Record<string, unknown>): ServiceState {
    return {
      serviceName: r.service_name as string,
      appliedVersion: r.applied_version != null ? Number(r.applied_version) : undefined,
      desiredVersion: r.desired_version != null ? Number(r.desired_version) : undefined,
      status: r.status as ServiceState['status'],
      restartRequired: Boolean(r.restart_required),
      errorMessage: r.error_message as string | undefined,
      appliedAt: r.applied_at as Date | undefined,
      lastCheckAt: r.last_check_at as Date | undefined,
    };
  }

  private mapAudit(r: Record<string, unknown>): AuditLogEntry {
    return {
      id: Number(r.id),
      actor: r.actor as string,
      action: r.action as string,
      service: r.service as string | undefined,
      group: r.group as string | undefined,
      configName: r.config_name as string | undefined,
      versionBefore: r.version_before != null ? Number(r.version_before) : undefined,
      versionAfter: r.version_after != null ? Number(r.version_after) : undefined,
      detail: r.detail as Record<string, unknown> | undefined,
      ipAddress: r.ip_address as string | undefined,
      createdAt: r.created_at as Date,
    };
  }
}
