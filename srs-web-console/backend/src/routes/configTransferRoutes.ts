import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { ConfigApply } from '../services/configApply.js';
import { isConfigService } from '../store/services.js';
import { ConfigRoutesOptions, sanitizeImportDocSecrets, validateNoSensitiveFields, rejectReservedAdminPasswordField, serviceScopeError } from './configPolicy.js';

export function registerConfigTransferRoutes(fastify: FastifyInstance, opts: ConfigRoutesOptions, autoApply: ConfigApply) {
  const { pgStore, orchestrator } = opts;
  const serviceTokens = opts.serviceTokens ?? new Map<string, string>();
  fastify.get('/v1/config/export', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const [docs, versions, states] = await Promise.all([
      pgStore.listDocuments(),
      pgStore.listVersions(20),
      pgStore.listServiceStates(),
    ]);
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      documents: docs.map((d) => ({
        service: d.service,
        group: d.group,
        name: d.name,
        config: d.config,
        description: d.description,
      })),
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        changeSummary: v.changeSummary,
        publishedAt: v.publishedAt,
      })),
      serviceStates: states,
    };
    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="config-export-${Date.now()}.json"`);
    return { code: 0, data: exportData };
  });

  // 导入配置（覆盖草稿，不自动发布）
  //
  // P1-0 / P1-3 修复（2026-09-15）：
  //  - 整个导入在单个事务里完成（overwrite 失败不半导入）
  //  - 敏感值清洗：已知敏感路径的明文转成 ${secret:...} 占位符 + 写入 config_secrets
  //  - 未知字段里疑似敏感值（password/token/secret 键名且非空字符串）拒绝导入
  fastify.post('/v1/config/import', async (req, reply) => {
    const scopeErr = serviceScopeError(req as any, null);
    if (scopeErr) { reply.status(scopeErr.code); return scopeErr; }
    const body = req.body as {
      mode?: 'merge' | 'overwrite';
      data: {
        documents?: Array<{
          service: string;
          group: string;
          name: string;
          config: Record<string, unknown>;
          description?: string;
        }>;
      };
    };
    const mode = body.mode ?? 'merge';
    const docs = body.data?.documents;
    if (!Array.isArray(docs)) {
      reply.status(400);
      return { code: 400, error: 'documents 必须是数组' };
    }

    const client = await pgStore.pool.connect();
    try {
      await client.query('BEGIN');

      // overwrite 模式：先清空现有文档（在事务里）
      if (mode === 'overwrite') {
        const all = await client.query(
          'SELECT service, "group", name FROM config_documents ORDER BY service, "group", name',
        );
        for (const row of all.rows) {
          await client.query(
            'DELETE FROM config_documents WHERE service = $1 AND "group" = $2 AND name = $3',
            [row.service, row.group, row.name],
          );
          await client.query(
            `INSERT INTO config_audit_logs (actor, action, service, "group", config_name, detail)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            ['import', 'delete', row.service, row.group, row.name,
              JSON.stringify({ mode: 'import-overwrite' })],
          );
        }
      }

      // 逐文档导入：敏感值清洗 + 校验 + upsert
      let imported = 0;
      for (const d of docs) {
        if (!d.service || !d.group || !d.name || !d.config) continue;

        // 白名单：与 POST /documents 对齐，防止 testsvc 之类任意服务名经
        // 导入落库（垃圾文档会进列表/导出/快照，并在发布时凭空产生 rejected）
        if (!isConfigService(d.service)) {
          await client.query('ROLLBACK');
          reply.status(400);
          return {
            code: 400,
            error: `导入失败：未知服务「${d.service}」，允许的服务：backend（控制台）/ srs（流媒体服务）/ ai-service（AI 识别）/ recorder（录像）`,
          };
        }

        // 1. 清洗已知敏感路径（明文 → ${secret:...} 占位符 + 写入 config_secrets）
        //    走同一个 client，保证事务一致性（回滚时 secret 一起回滚）
        const cleaned = await sanitizeImportDocSecrets(
          d.service, d.config, pgStore, 'import', client,
        );

        // 2. 校验：未知疑似敏感字段拒绝 + adminPasswordHash 保留字段整体拒绝
        //    （顺序：先查 adminPasswordHash 专项，它不属于「疑似未知敏感值」，
        //    是明确已知且明确拒绝，错误信息要更精确）
        const reservedErr = rejectReservedAdminPasswordField(d.service, d.group, d.name, cleaned);
        const err = reservedErr ?? validateNoSensitiveFields(cleaned, d.service);
        if (err) {
          await client.query('ROLLBACK');
          reply.status(reservedErr ? 403 : 400);
          return {
            code: reservedErr ? 403 : 400,
            error: `导入失败：${d.service}/${d.group}/${d.name} ${err}`,
          };
        }

        // 3. upsert 文档
        await client.query(
          `INSERT INTO config_documents (service, "group", name, config, description)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (service, "group", name) DO UPDATE
             SET config = EXCLUDED.config,
                 description = EXCLUDED.description,
                 updated_at = now()`,
          [d.service, d.group, d.name,
            JSON.stringify(cleaned), d.description ?? null],
        );

        // 4. 审计日志
        await client.query(
          `INSERT INTO config_audit_logs (actor, action, service, "group", config_name)
           VALUES ($1, $2, $3, $4, $5)`,
          ['import', mode === 'overwrite' ? 'import-overwrite' : 'import',
            d.service, d.group, d.name],
        );

        imported++;
      }

      await client.query('COMMIT');
      return { code: 0, data: { imported, mode } };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  });

  // ---- 服务应用状态 ----

  // 全部服务状态列表——全局操作，服务 token 拒绝（拉配置客户端只查自己那条，
  // 走下面按 :service 的接口）

}
