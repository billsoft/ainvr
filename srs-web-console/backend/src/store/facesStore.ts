import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { FacesError, facesId, facesVersion, facesDocumentSchema, facesTemplateSchema, facesSaveSchema, facesDeleteSchema, type FacesLibrary, type FacesTemplate } from '../services/facesContract.js';

interface Row { id: string; version: number; document: FacesLibrary['document']; templates: Record<string, FacesTemplate>; updated_at: Date; deleted_at: Date | null }
const view = (row: Row): FacesLibrary => ({ id: row.id, version: row.version, document: row.document, templates: row.templates, updated_at: row.updated_at.toISOString(), ...(row.deleted_at ? { deleted: true } : {}) });
const fail = (code: string, message: string, status = 422): never => { throw new FacesError(code, message, status); };
export class FacesStore {
  constructor(private readonly pool: Pool) {}
  async list(): Promise<FacesLibrary[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM faces_libraries WHERE deleted_at IS NULL ORDER BY created_at,id LIMIT 17');
    if (rows.length > 16) fail('faces_capacity', '人脸库超出设备上限', 503);
    return rows.map(view);
  }
  async get(id: string): Promise<FacesLibrary> {
    facesId.parse(id);
    const { rows } = await this.pool.query<Row>('SELECT * FROM faces_libraries WHERE id=$1', [id]);
    if (!rows[0] || rows[0].deleted_at) fail('faces_library_missing', '人脸库不存在或已删除', 404);
    return view(rows[0]);
  }
  async getVersion(id: string, version: number): Promise<FacesLibrary & { retain_until: string }> {
    facesId.parse(id); facesVersion.parse(version);
    const { rows } = await this.pool.query<{ library_id: string; version: number; document: FacesLibrary['document']; templates: Record<string, FacesTemplate>; created_at: Date; retain_until: Date }>(
      'SELECT library_id,version,document,templates,created_at,retain_until FROM faces_library_versions WHERE library_id=$1 AND version=$2', [id, version]);
    const row = rows[0];
    // Missing versions may have been removed by retention; never substitute latest.
    if (!row || row.retain_until.getTime() <= Date.now()) fail('evidence_expired', '历史库版本不存在或已过保留期', 410);
    const document = facesDocumentSchema.parse(row.document);
    const templates = Object.fromEntries(Object.entries(row.templates).map(([memberId, template]) => [memberId, facesTemplateSchema.parse(template)]));
    return { id: row.library_id, version: row.version, document, templates, updated_at: row.created_at.toISOString(), retain_until: row.retain_until.toISOString() };
  }
  async save(id: string, raw: unknown, templates: Record<string, FacesTemplate>, actor: string, key: string, authorizedChannels?: string[]): Promise<FacesLibrary> {
    facesId.parse(id);
    const { expected_version, document } = facesSaveSchema.parse(raw);
    // Only verified references supplied by FacesService may enter this store.
    if (Object.keys(templates).some(memberId => !document.members.some(member => member.id === memberId && member.template_id === templates[memberId].template_id))) fail('faces_template_invalid', '模板引用与成员不一致');
    return this.operation(actor, key, ['save', id, raw], async client => {
      const row = (await client.query<Row>('SELECT * FROM faces_libraries WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (row?.deleted_at) fail('faces_library_deleted', '此库已删除，请以新编号创建', 409);
      if ((row?.version ?? 0) !== expected_version) throw new FacesError('version_conflict', '人脸库已更新；输入已保留，请读取最新版本后核对。', 409, row ? { id: row.id, version: row.version } : null);
      if (Date.parse(document.valid_until) > Date.now()) {
        const incompatible = await client.query(`SELECT id FROM faces_libraries WHERE id<>$1 AND deleted_at IS NULL
          AND (document->>'valid_until')::timestamptz>now() AND document->>'model'<>$2
          AND ($3::text[] IS NULL OR (document->'channel_ids') ?| $3::text[]) LIMIT 1`, [id, document.model, authorizedChannels ?? null]);
        if (incompatible.rows.length) throw new FacesError('faces_model_conflict', '其他有效人脸库使用不同模型。请先统一模型或结束旧库有效期，当前配置未保存。', 409);
      }
      const count = await client.query<{ libraries: number; members: number }>(`SELECT count(*)::int AS libraries, COALESCE(sum(jsonb_array_length(document->'members')),0)::int AS members FROM faces_libraries WHERE deleted_at IS NULL AND id<>$1`, [id]);
      if (count.rows[0].libraries >= 16 || count.rows[0].members + document.members.length > 500) fail('faces_capacity', '设备最多16个人脸库、合计500位成员', 409);
      const stored = await client.query<Row>(`INSERT INTO faces_libraries(id,version,document,templates,updated_by) VALUES($1,1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET version=faces_libraries.version+1,document=EXCLUDED.document,templates=EXCLUDED.templates,updated_by=EXCLUDED.updated_by,updated_at=now()
        WHERE faces_libraries.version=$5 AND faces_libraries.deleted_at IS NULL RETURNING *`, [id, JSON.stringify(document), JSON.stringify(templates), actor, expected_version]);
      if (!stored.rows[0]) fail('version_conflict', '人脸库已更新，请核对最新版本', 409);
      // A superseded configuration can be referenced by at most 90 days of retained face history.
      await client.query("UPDATE faces_library_versions SET retain_until=now()+interval '90 days' WHERE library_id=$1 AND version=$2", [id, expected_version]);
      await client.query("INSERT INTO faces_library_versions(library_id,version,document,templates,retain_until) VALUES($1,$2,$3,$4,now()+interval '90 days')", [id, stored.rows[0].version, JSON.stringify(document), JSON.stringify(templates)]);
      await this.audit(client, actor, row ? 'update' : 'create', id, expected_version, stored.rows[0].version, document.members.length);
      return view(stored.rows[0]);
    });
  }
  async delete(id: string, raw: unknown, actor: string, key: string) {
    facesId.parse(id); const { expected_version } = facesDeleteSchema.parse(raw);
    return this.operation(actor, key, ['delete', id, raw], async client => {
      const row = (await client.query<Row>('SELECT * FROM faces_libraries WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || row.deleted_at) fail('faces_library_missing', '人脸库不存在或已删除', 404);
      if (row.version !== expected_version) throw new FacesError('version_conflict', '人脸库已更新，未删除；请核对最新版本。', 409, { id, version: row.version });
      await client.query("UPDATE faces_libraries SET version=version+1,deleted_at=now(),updated_at=now(),updated_by=$2,document='{}',templates='{}' WHERE id=$1 AND version=$3", [id, actor, expected_version]);
      await client.query("UPDATE faces_library_versions SET retain_until=now()+interval '90 days' WHERE library_id=$1 AND version=$2", [id, expected_version]);
      await this.audit(client, actor, 'delete', id, expected_version, expected_version + 1, row.document.members.length);
      return { id, version: expected_version + 1, deleted: true as const };
    });
  }
  private async audit(client: PoolClient, actor: string, action: string, id: string, before: number, after: number, members: number) {
    await client.query(`INSERT INTO config_audit_logs(actor,action,service,"group",config_name,version_before,version_after,detail)
      VALUES($1,$2,'backend','faces',$3,$4,$5,$6)`, [actor, action, id, before, after, JSON.stringify({ members, access: 'console-management' })]);
  }
  private async operation<T>(actor: string, key: string, payload: unknown, run: (client: PoolClient) => Promise<T>): Promise<T> {
    facesId.parse(key);
    if (actor !== 'console-administrator') fail('faces_management_required', '人脸配置需要已登录的控制台管理会话', 403);
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('faces-libraries-v1'))");
      const old = (await client.query('SELECT request_hash,response FROM faces_operations WHERE actor=$1 AND operation_key=$2', [actor, key])).rows[0];
      if (old) {
        if (old.request_hash !== hash) fail('idempotency_conflict', '同一操作编号不能用于不同内容', 409);
        const current = (await client.query<Row>('SELECT * FROM faces_libraries WHERE id=$1', [old.response.id])).rows[0];
        if (!current || current.version !== old.response.version || Boolean(current.deleted_at) !== Boolean(old.response.deleted))
          throw new FacesError('operation_superseded', '之前的保存已被后续编辑取代，请读取最新配置；当前输入已保留。', 409, current ? { id: current.id, version: current.version } : null);
        await client.query('COMMIT'); return old.response as T;
      }
      await client.query("DELETE FROM faces_operations WHERE ctid IN (SELECT ctid FROM faces_operations WHERE created_at<now()-interval '30 days' LIMIT 100)");
      await client.query(`DELETE FROM faces_library_versions WHERE ctid IN (SELECT v.ctid FROM faces_library_versions v JOIN faces_libraries l ON l.id=v.library_id WHERE v.retain_until<now() AND (l.deleted_at IS NOT NULL OR v.version<>l.version) LIMIT 100)`);
      await client.query(`DELETE FROM faces_libraries WHERE id IN (SELECT l.id FROM faces_libraries l WHERE l.deleted_at<now()-interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM faces_library_versions v WHERE v.library_id=l.id)
        AND NOT EXISTS (SELECT 1 FROM faces_operations o WHERE o.response->>'id'=l.id::text) LIMIT 100)`);
      const result = await run(client);
      await client.query('INSERT INTO faces_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)', [actor, key, hash, JSON.stringify(result)]);
      const budget = await client.query(`SELECT (SELECT count(*) FROM faces_operations) AS operations,(SELECT count(*) FROM faces_library_versions) AS versions,
        (SELECT COALESCE(sum(octet_length(response::text)),0) FROM faces_operations)+(SELECT COALESCE(sum(octet_length(document::text)+octet_length(templates::text)),0) FROM faces_library_versions) AS bytes`);
      if (Number(budget.rows[0].operations) > 10000 || Number(budget.rows[0].versions) > 10000 || Number(budget.rows[0].bytes) > 64 * 1024 * 1024) fail('faces_history_capacity', '配置版本与操作记录已达上限，历史引用不会被提前清除', 503);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
