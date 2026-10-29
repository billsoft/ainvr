import type { PoolClient } from 'pg';
import { searchMigrationModelSchema } from './searchModelMigrationContract.js';
export class SearchModelSelectionError extends Error {
  constructor(){super('已有搜索空间不能直接更换模型，请使用“准备模型迁移”；当前模型保持服务。');}
}
/** Normal config saves cannot authorize feature-space replacement. Same-ID HBM
 * updates are additionally fenced by the runtime model pin before BPU Load.
 * First disabled/empty setup remains ordinary configuration, without a fake
 * migration task just to choose its first model. */
export async function assertSearchModelSelectionChange(client: Pick<PoolClient,'query'>,
  baseline: Record<string,unknown>,next: Record<string,unknown>) {
  const before=(baseline.model as {package_id?:unknown}|undefined)?.package_id;
  const after=(next.model as {package_id?:unknown}|undefined)?.package_id;
  if(after==null||before===after)return;
  const raw=(await client.query("SELECT to_jsonb(s)->'active_model' AS active_model FROM search_runtime_state s WHERE singleton=true")).rows[0]?.active_model;
  const active=raw?searchMigrationModelSchema.parse(raw):null;
  if(active) {
    if(after===active.package_id)return; // Repair a failed/unpublished draft back to the actual source.
    throw new SearchModelSelectionError();
  }
  if(before==null)return;
  const known=(await client.query(`SELECT s.id FROM search_index_shards s JOIN search_jobs j ON j.id=s.build_job_id
    WHERE s.published_revision IS NOT NULL AND s.record_count>0 AND s.state<>'deleting' AND j.payload->>'package_id'=$1 LIMIT 1`,[before])).rows;
  if(baseline.enabled===true||known.length)throw new SearchModelSelectionError();
}
