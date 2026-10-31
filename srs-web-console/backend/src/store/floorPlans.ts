import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { floorPlanDocumentSchema } from './floorPlanDocument.js';
import { AlarmConfigError } from './alarmZones.js';
import { type FloorPlanImages, type ImageRef, parseFloorPlanJpeg } from '../services/floorPlanImages.js';

const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const dimensions = { w: z.number().int().min(1).max(1600), h: z.number().int().min(1).max(1600) };
const image = z.union([
  z.object({ data: z.string().max(2500000), ...dimensions }).strict(),
  z.object({ ref: z.string().uuid(), ...dimensions }).strict(),
  z.null(),
]);
const input = z.object({ plan: z.object({ id: z.string(), name: z.string(), shapes: z.unknown(), placements: z.unknown(), image }).strict(),
  expected_version: z.number().int().min(0).max(2147483646) }).strict();
const del = z.object({ expected_version: z.number().int().min(1).max(2147483646) }).strict();
type Row = { id:string; version:number; document:Record<string, unknown>; image:ImageRef|null; created_at:Date; updated_at:Date; deleted_at:Date|null };
const publicImage = (image:ImageRef|null) => image ? { ref:image.ref, w:image.w, h:image.h } : null;
const view = (row:Row) => ({ plan: { ...row.document, image:publicImage(row.image) }, version:row.version,
  created_at:row.created_at, updated_at:row.updated_at, image_validation:row.image ? 'jpeg_structure_only' : null });
const fail = (code:string, message:string, status=422):never => { throw new AlarmConfigError(code,message,status); };
export class FloorPlanConflict extends AlarmConfigError {
  constructor(code:string,message:string,readonly current:unknown) { super(code,message,409); }
}
const currentView = (row:Row|undefined) => !row ? null : row.deleted_at
  ? {deleted:true,id:row.id,version:row.version} : view(row);


export class FloorPlans {
  constructor(private readonly pool:Pool, private readonly images:FloorPlanImages) {}
  async list() {
    const result = await this.pool.query<Row>('SELECT * FROM floor_plans WHERE deleted_at IS NULL ORDER BY created_at,id LIMIT 21');
    if (result.rows.length > 20) fail('plan_capacity','平面图数量超出限制',503);
    return { items:result.rows.map(view) };
  }
  async get(idValue:string) {
    if (!id.safeParse(idValue).success) fail('invalid_plan','平面图编号无效');
    const result = await this.pool.query<Row>('SELECT * FROM floor_plans WHERE id=$1',[idValue]);
    if (!result.rows[0] || result.rows[0].deleted_at) fail('not_found','平面图不存在',404);
    return view(result.rows[0]!);
  }
  async readImage(ref:string) {
    if (!z.string().uuid().safeParse(ref).success) fail('not_found','底图不存在',404);
    const result = await this.pool.query<Row>("SELECT * FROM floor_plans WHERE image->>'ref'=$1 AND deleted_at IS NULL",[ref]);
    if (!result.rows[0]?.image) fail('not_found','底图不存在',404);
    return this.images.read(result.rows[0]!.image!);
  }
  async save(raw:unknown, actor:string, key:unknown) {
    const parsed = input.safeParse(raw);
    if (!parsed.success || !id.safeParse(actor).success || !id.safeParse(key).success) fail('invalid_request','平面图参数或操作编号无效');
    const { plan, expected_version } = parsed.data!;
    const document = floorPlanDocumentSchema.safeParse({ id:plan.id, name:plan.name, shapes:plan.shapes, placements:plan.placements });
    if (!document.success) fail('invalid_plan','平面图内容无效或超出限制');
    const bytes = plan.image && 'data' in plan.image ? parseFloorPlanJpeg(plan.image.data,plan.image.w,plan.image.h) : null;
    return this.operation(actor,key as string,['save',raw],async client => {
      const current = await client.query<Row>('SELECT * FROM floor_plans WHERE id=$1 FOR UPDATE',[plan.id]);
      const row = current.rows[0];
      if (row?.deleted_at) throw new FloorPlanConflict('plan_deleted','此平面图已删除，请使用新编号另存',currentView(row));
      if ((row?.version ?? 0) !== expected_version) fail('version_conflict','平面图已被修改，请重新载入或另存',409);
      if (!row && Number((await client.query('SELECT count(*)::int AS n FROM floor_plans WHERE deleted_at IS NULL')).rows[0].n) >= 20)
        fail('plan_capacity','最多保存20张平面图',409);
      let stored:ImageRef|null = null;
      if (plan.image && 'ref' in plan.image) {
        if (!row?.image || row.image.ref !== plan.image.ref || row.image.w !== plan.image.w || row.image.h !== plan.image.h)
          fail('invalid_image_ref','只能保留此平面图当前的底图',422);
        stored = row.image;
      } else if (plan.image && bytes) stored = await this.images.publish(bytes,plan.image.w,plan.image.h);
      const result = await client.query<Row>(`INSERT INTO floor_plans(id,version,document,image,created_by,updated_by)
        VALUES($1,1,$2,$3,$4,$4) ON CONFLICT(id) DO UPDATE SET version=floor_plans.version+1,
        document=EXCLUDED.document,image=EXCLUDED.image,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
        [plan.id,JSON.stringify(document.data),stored ? JSON.stringify(stored) : null,actor]);
      return { ...view(result.rows[0]!), saved:true };
    });
  }
  async delete(idValue:string, raw:unknown, actor:string, key:unknown) {
    const parsed=del.safeParse(raw);
    if (!parsed.success || !id.safeParse(idValue).success || !id.safeParse(actor).success || !id.safeParse(key).success)
      fail('invalid_request','删除参数或操作编号无效');
    return this.operation(actor,key as string,['delete',idValue,raw],async client => {
      const current=await client.query<Row>('SELECT * FROM floor_plans WHERE id=$1 FOR UPDATE',[idValue]);
      if (!current.rows[0] || current.rows[0].deleted_at) fail('not_found','平面图不存在',404);
      if (current.rows[0]!.version !== parsed.data!.expected_version) fail('version_conflict','平面图已被修改，请重新载入',409);
      await client.query("UPDATE floor_plans SET deleted_at=now(),updated_at=now(),updated_by=$2,version=version+1,document='{}'::jsonb,image=NULL WHERE id=$1",[idValue,actor]);
      return { deleted:true, id:idValue };
    });
  }
  private async operation(actor:string,key:string,payload:unknown, run:(client:import('pg').PoolClient)=>Promise<unknown>) {
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize all plan mutations: guards capacity, version and concurrent retries.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('floor-plans'))");
      const old=await client.query('SELECT request_hash,response FROM floor_plan_operations WHERE actor=$1 AND operation_key=$2',[actor,key]);
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) fail('idempotency_conflict','操作编号已用于其他内容',409);
        const response=old.rows[0].response;
        if (response.saved) {
          const current=await client.query<Row>('SELECT * FROM floor_plans WHERE id=$1',[response.plan.id]);
          const row=current.rows[0];
          if (!row || row.deleted_at || row.version !== response.version)
            throw new FloorPlanConflict('operation_superseded','操作结果已被后续修改取代，请重新载入或另存本地草稿',currentView(row));
        }
        await client.query('COMMIT'); return response;
      }
      await client.query(`DELETE FROM floor_plan_operations WHERE ctid IN
        (SELECT ctid FROM floor_plan_operations WHERE created_at < now() - interval '30 days' LIMIT 100)`);
      const count=await client.query('SELECT count(*)::int AS n FROM floor_plan_operations');
      if (Number(count.rows[0].n) >= 10000) fail('operation_capacity','平面图操作记录已满，请稍后重试',503);
      // Keep every currently referenced image until the transaction commits.
      // If the save later rolls back, its old image must still be readable.
      const refs=await client.query("SELECT image->>'ref' AS ref FROM floor_plans WHERE image IS NOT NULL");
      await this.images.cleanup(new Set(refs.rows.map(r=>String(r.ref)))).catch(()=>undefined);
      const result=await run(client);
      await client.query('INSERT INTO floor_plan_operations(actor,operation_key,request_hash,response) VALUES($1,$2,$3,$4)',[actor,key,hash,JSON.stringify(result)]);
      const bytes=await client.query('SELECT COALESCE(sum(octet_length(response::text)),0)::bigint AS n FROM floor_plan_operations');
      if (Number(bytes.rows[0].n) > 64 * 1024 * 1024) fail('operation_capacity','平面图操作记录已满，请稍后重试',503);
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK').catch(()=>undefined); throw e; }
    finally { client.release(); }
  }
}
