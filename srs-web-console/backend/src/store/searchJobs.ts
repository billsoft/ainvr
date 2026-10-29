import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CONFIG_HISTORY_RETENTION_SQL } from './configRetention.js';
import { searchModelMigrationPayloadSchema, searchModelMigrationProgressSchema, searchModelMigrationAcceptanceSchema,
  searchModelMigrationFingerprint, validateSearchMigrationCheckpoint,
  searchMigrationWriteSourceSchema,searchMigrationModelSchema,
  type SearchModelMigrationProgress,type SearchMigrationModel,type SearchMigrationWriteGrant,type SearchMigrationReportReadGrant } from '../services/searchModelMigrationContract.js';
import { searchMigrationPlanPayloadSchema, searchMigrationPlanProgressSchema, searchMigrationPlanFingerprint, migrationPlanChildCount, migrationPlanChild, migrationPlanChildRequestId, type SearchMigrationPlanProgress,searchMigrationSourceIdsDigest,searchMigrationPlanAcceptanceSchema,searchMigrationObservedExtentSchema,searchMigrationPauseRejectionCodeSchema,migrationPlanFinalSpec,migrationPlanRound,migrationPlanIngestionGate,type SearchMigrationIngestionGate } from '../services/searchModelMigrationPlan.js';
import { searchControlRequestId } from '../services/searchControlIdentity.js';
const kind = z.enum(['index', 'rebuild', 'verify']);
const uuid = z.string().uuid();
const terminalCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const checkpoint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const migrationActor = (value: string) => z.string().min(1).max(64)
  .refine(actor => !/[\u0000-\u001f\u007f]/u.test(actor)).parse(value);
function boundedMigrationJson(value: unknown, maximum: number) {
  const json = JSON.stringify(value);
  // PG JSONB renders spaces after separators; account for that representation,
  // rather than accepting a compact document that exceeds the SQL hard limit.
  const conservativeBytes = Buffer.byteLength(json) + (json.match(/[:,]/g)?.length ?? 0);
  if (conservativeBytes > maximum) throw new SearchJobError('migration_control_too_large');
  return json;
}
export const searchIndexPayloadSchema = z.object({ shard_id: uuid, channel_id: uuid,
  model_version: z.string().regex(/^search-v1-[a-f0-9]{64}$/), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  storage_generation: z.string().regex(/^[a-f0-9]{64}$/), config_revision: z.string().regex(/^[a-f0-9]{64}$/),
  package_id: z.string().min(1).max(128) }).strict();
type IndexPayload = z.infer<typeof searchIndexPayloadSchema>;
function refreshIdentity(payload: IndexPayload) {
  return [payload.config_revision, payload.storage_generation, payload.package_id, payload.model_version, payload.channel_id, payload.day];
}
/** Frozen shared UUIDv8 algorithm; idempotence binds the watermark, not a poll. */
export function indexRefreshRequestKey(payload: IndexPayload, minimum: number) {
  checkpoint.parse(minimum); searchIndexPayloadSchema.parse(payload);
  return searchControlRequestId('ainvr-search-index-refresh-v1', [...refreshIdentity(payload), minimum]);
}
export class SearchJobError extends Error {}
export interface SearchJob {
  id: string; actor: string; kind: z.infer<typeof kind>; payload: unknown;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  generation: number; attempts: number; lease_owner: string | null;
  lease_until: Date | null; expires_at: Date; result_ref?: string | null; error_code?: string | null;
  refresh_scope?: string | null; requested_checkpoint?: string | null; completed_checkpoint?: string | null;
  claimed_checkpoint?: string | null;
  migration_progress?: unknown; migration_acceptance?: unknown;
}
export class SearchJobs {
  constructor(private readonly pool: Pool) {}
  async enqueue(actor: string, requestKey: string, jobKind: string, payload: unknown) {
    if (payload && typeof payload === 'object' && 'purpose' in payload && ['reencode','reencode_plan'].includes(String(payload.purpose)))
      throw new SearchJobError('migration_specific_operation_required');
    return this.enqueueInternal(actor, requestKey, jobKind, payload);
  }
  async enqueueMigration(actor: string, requestKey: string, input: unknown) {
    migrationActor(actor);
    const parsed = searchModelMigrationPayloadSchema.parse(input);
    if(parsed.plan_id) throw new SearchJobError('migration_plan_specific_operation_required');
    const payload = { ...parsed, scope: { channel_ids: [...parsed.scope.channel_ids].sort(),
      from: new Date(parsed.scope.from).toISOString(), to: new Date(parsed.scope.to).toISOString() } };
    const progress: SearchModelMigrationProgress = {
      schema_version: 'search-reencode-progress-v1', payload_fingerprint: searchModelMigrationFingerprint(payload),
      phase: 'encoding', cursor: null, scanned: 0, encoded: 0, unavailable: 0,
      source_completed_through: null, target_checkpoint: null, coverage_sha256: null, index_manifest_sha256: null,
    };
    return this.enqueueInternal(actor, requestKey, 'rebuild', payload, progress);
  }
  private async enqueueInternal(actor: string, requestKey: string, jobKind: string, payload: unknown,
    migrationProgress?: SearchModelMigrationProgress | SearchMigrationPlanProgress) {
    uuid.parse(requestKey); kind.parse(jobKind);
    if (!actor || actor.length > 128) throw new SearchJobError('invalid_actor');
    // Callers supply an already validated contract, not arbitrary URLs or paths.
    const json = JSON.stringify(payload);
    if (!json || Buffer.byteLength(json) > 12000) throw new SearchJobError('job_too_large');
    const fingerprint = createHash('sha256').update(jobKind + '\n' + json).digest('hex');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Shared admission lock: bounds remain true under concurrent enqueue.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      await c.query(`DELETE FROM search_jobs WHERE id IN
        (SELECT j.id FROM search_jobs j WHERE j.expires_at<=clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM search_index_shards s WHERE s.build_job_id=j.id OR s.retired_job_id=j.id)
          AND NOT EXISTS(SELECT 1 FROM search_jobs parent WHERE parent.id::text=j.payload->>'plan_id'
            AND parent.payload->>'purpose'='reencode_plan' AND parent.expires_at>clock_timestamp())
          ORDER BY j.expires_at LIMIT 1000)`);
      const old = await c.query('SELECT * FROM search_jobs WHERE actor=$1 AND request_key=$2', [actor, requestKey]);
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fingerprint) throw new SearchJobError('idempotency_conflict');
        await c.query('COMMIT'); return old.rows[0] as SearchJob;
      }
      const count = await c.query('SELECT count(*)::int AS count FROM search_jobs WHERE refresh_scope IS NULL');
      if (count.rows[0].count >= 1000) throw new SearchJobError('queue_full');
      const active = await c.query("SELECT count(*)::int AS count FROM search_jobs WHERE actor=$1 AND refresh_scope IS NULL AND state IN ('pending','running')", [actor]);
      if (active.rows[0].count >= 32) throw new SearchJobError('actor_queue_full');
      const params = [randomUUID(), actor, requestKey, fingerprint, jobKind, json];
      const r = migrationProgress ? await c.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,expires_at,migration_progress)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days',$7) RETURNING *`, [...params, boundedMigrationJson(migrationProgress, 8192)]) :
        await c.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours') RETURNING *`, params);
      if (migrationProgress) await this.migrationAudit(c, actor, 'search-migration-create', r.rows[0].id,
        { payload_fingerprint: migrationProgress.payload_fingerprint });
      await c.query('COMMIT'); return r.rows[0] as SearchJob;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
  /** Called only after native proves that the legacy profile failure was never submitted.
   * CAS preserves identity and invalidates every previous lease generation. */
  async retryUnsubmittedVerification(id: string, actor: string, generation: number): Promise<SearchJob | null> {
    uuid.parse(id); z.string().min(1).max(128).parse(actor); z.number().int().min(0).parse(generation);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      const active = await c.query("SELECT count(*)::int AS count FROM search_jobs WHERE actor=$1 AND refresh_scope IS NULL AND state IN ('pending','running')", [actor]);
      if (active.rows[0].count >= 32) { await c.query('COMMIT'); return null; }
      const result = await c.query(`UPDATE search_jobs SET state='pending',generation=generation+1,
        attempts=0,error_code=NULL,result_ref=NULL,lease_owner=NULL,lease_until=NULL
        WHERE id=$1 AND actor=$2 AND generation=$3 AND kind='verify' AND refresh_scope IS NULL
          AND state='failed' AND error_code='profile_changed' AND expires_at>clock_timestamp() RETURNING *`, [id,actor,generation]);
      await c.query('COMMIT'); return result.rows[0] ?? null;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async refreshIndex(requestKey: string, input: unknown, minimum: number, retentionDays: number): Promise<SearchJob> {
    uuid.parse(requestKey); checkpoint.parse(minimum); z.number().int().min(1).max(365).parse(retentionDays);
    const payload = searchIndexPayloadSchema.parse(input), json = JSON.stringify(payload);
    if (indexRefreshRequestKey(payload, minimum) !== requestKey) throw new SearchJobError('idempotency_conflict');
    const scope = createHash('sha256').update(JSON.stringify(['ainvr-search-index-scope-v1', refreshIdentity(payload)])).digest('hex');
    const fingerprint = createHash('sha256').update('index\n' + json).digest('hex');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      await c.query(`DELETE FROM search_jobs WHERE id IN (SELECT j.id FROM search_jobs j WHERE j.expires_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM search_index_shards s WHERE s.build_job_id=j.id OR s.retired_job_id=j.id)
          AND NOT EXISTS(SELECT 1 FROM search_jobs parent WHERE parent.id::text=j.payload->>'plan_id'
            AND parent.payload->>'purpose'='reencode_plan' AND parent.expires_at>clock_timestamp())
        ORDER BY j.expires_at LIMIT 1000)`);
      // Same lock order as publication: job first, then directory.
      const old = (await c.query('SELECT * FROM search_jobs WHERE actor=$1 AND refresh_scope=$2 FOR UPDATE', ['internal-search-index', scope])).rows[0];
      const shard = (await c.query(`SELECT * FROM search_index_shards WHERE id=$1 AND channel_id=$2 AND model_version=$3 AND day=$4
        AND directory_storage_generation=$5 FOR UPDATE`, [payload.shard_id, payload.channel_id, payload.model_version, payload.day, payload.storage_generation])).rows[0];
      if (!shard) throw new SearchJobError('idempotency_conflict');
      const published = shard.published_revision !== null && shard.manifest_sha256 !== null && shard.published_storage_generation === payload.storage_generation;
      const covered = published ? Number(shard.checkpoint) : 0;
      if (!Number.isSafeInteger(covered)) throw new SearchJobError('invalid_checkpoint');
      if (old) {
        if (old.fingerprint !== fingerprint) throw new SearchJobError('idempotency_conflict');
        const demanded = Math.max(Number(old.requested_checkpoint), minimum);
        const completed = Math.max(Number(old.completed_checkpoint), covered);
        const rearm = old.state !== 'running' && old.state !== 'pending' && demanded > completed && minimum > Number(old.requested_checkpoint);
        const r = await c.query(`UPDATE search_jobs SET requested_checkpoint=$2,completed_checkpoint=$3,
          state=CASE WHEN $4 THEN 'pending' ELSE state END,attempts=CASE WHEN $4 THEN 0 ELSE attempts END,
          error_code=CASE WHEN $4 THEN NULL ELSE error_code END,
          expires_at=GREATEST(expires_at,($5::date+($6::int+1))::timestamp AT TIME ZONE 'UTC') WHERE id=$1 RETURNING *`,
          [old.id, demanded, completed, rearm, payload.day, retentionDays]);
        await c.query('COMMIT'); return r.rows[0] as SearchJob;
      }
      const count = await c.query('SELECT count(*)::int AS n FROM search_jobs WHERE refresh_scope IS NOT NULL');
      if (count.rows[0].n >= 65536) throw new SearchJobError('queue_full');
      const r = await c.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,state,refresh_scope,requested_checkpoint,completed_checkpoint,expires_at)
        VALUES($1,'internal-search-index',$2,$3,'index',$4,$5,$6,$7,$8,
          GREATEST(clock_timestamp()+interval '1 day',($9::date+($10::int+1))::timestamp AT TIME ZONE 'UTC')) RETURNING *`,
        [randomUUID(), requestKey, fingerprint, json, published && covered >= minimum ? 'succeeded' : 'pending', scope, minimum, covered, payload.day, retentionDays]);
      await c.query('COMMIT'); return r.rows[0] as SearchJob;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async claim(worker: string, jobKind: string, leaseMs = 30000, actor?: string, indexContext?: Pick<IndexPayload,'model_version'|'package_id'|'config_revision'|'storage_generation'>, recentVerificationActors: readonly string[] = []): Promise<SearchJob | null> {
    uuid.parse(worker); kind.parse(jobKind);
    z.array(z.string().min(1).max(128)).max(1000).parse(recentVerificationActors);
    if (actor !== undefined && (!actor || actor.length > 128)) throw new SearchJobError('invalid_actor');
    z.number().int().min(1000).max(60000).parse(leaseMs);
    if(indexContext) z.object({model_version:searchIndexPayloadSchema.shape.model_version,package_id:searchIndexPayloadSchema.shape.package_id,
      config_revision:searchIndexPayloadSchema.shape.config_revision,storage_generation:searchIndexPayloadSchema.shape.storage_generation}).strict().parse(indexContext);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // A predicate alone races at 31 live leases; serialize this short claim
      // transaction, not file/Mongo work, to enforce the hard running limit.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-job-claims',0))");
      // Reconcile a crash between durable publication and the job ACK. Never
      // repeat an already-covered refresh just because its lease expired.
      if (actor === 'internal-search-index') await c.query(`WITH covered AS (
        SELECT j.id,s.checkpoint,s.id AS shard_id,s.published_revision FROM search_jobs j JOIN search_index_shards s ON s.id::text=j.payload->>'shard_id'
        WHERE j.actor=$1 AND j.refresh_scope IS NOT NULL AND j.state IN ('pending','running')
          AND (j.state='pending' OR j.lease_until<=clock_timestamp()) AND j.expires_at>clock_timestamp()
          AND s.published_revision IS NOT NULL AND s.manifest_sha256 IS NOT NULL AND s.state<>'deleting'
          AND s.directory_storage_generation=j.payload->>'storage_generation' AND s.published_storage_generation=j.payload->>'storage_generation'
          AND s.checkpoint>=j.requested_checkpoint ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 32)
        UPDATE search_jobs j SET state='succeeded',completed_checkpoint=GREATEST(j.completed_checkpoint,c.checkpoint),
          result_ref='shard:'||c.shard_id::text||':'||c.published_revision::text,error_code=NULL,lease_owner=NULL,lease_until=NULL
        FROM covered c WHERE j.id=c.id`, [actor]);
      await c.query(`UPDATE search_jobs SET state='failed',error_code='attempts_exhausted',
        lease_owner=NULL,lease_until=NULL WHERE state='running' AND lease_until<=clock_timestamp() AND attempts>=3`);
      if (actor === 'internal-search-index') {
        const live = await c.query(`SELECT count(*)::int AS n FROM search_jobs WHERE actor=$1 AND state='running'
          AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`, [actor]);
        if (live.rows[0].n >= 32) { await c.query('COMMIT'); return null; }
      }
      const r = await c.query(`WITH candidate AS (
      SELECT id FROM search_jobs WHERE kind=$1 AND ($4::text IS NULL OR actor=$4) AND expires_at>clock_timestamp() AND attempts<3
      AND COALESCE(payload->>'purpose','') NOT IN ('reencode','reencode_plan')
      AND ($5::jsonb IS NULL OR payload @> $5::jsonb)
      AND (refresh_scope IS NULL OR $4='internal-search-index')
      AND (state='pending' OR (state='running' AND lease_until<=clock_timestamp()))
      ORDER BY CASE WHEN $1='verify' THEN array_position($6::text[],actor) END DESC NULLS FIRST,
        created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE search_jobs j SET state='running',lease_owner=$2,
      lease_until=LEAST(j.expires_at,clock_timestamp()+$3::int*interval '1 millisecond'),
      generation=j.generation+1,attempts=j.attempts+1,claimed_checkpoint=j.requested_checkpoint,result_ref=NULL,error_code=NULL
    FROM candidate c WHERE j.id=c.id RETURNING j.*`, [jobKind, worker, leaseMs, actor ?? null,indexContext?JSON.stringify(indexContext):null,[...recentVerificationActors]]);
      await c.query('COMMIT'); return r.rows[0] ?? null;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async renew(id: string, worker: string, generation: number, leaseMs = 30000) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    z.number().int().min(1000).max(60000).parse(leaseMs);
    const r = await this.pool.query(`UPDATE search_jobs SET lease_until=LEAST(expires_at,now()+$4::int*interval '1 millisecond')
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND COALESCE(payload->>'purpose','') NOT IN ('reencode','reencode_plan')
        AND state='running' AND lease_until>now() AND expires_at>now()`, [id, worker, generation, leaseMs]);
    return r.rowCount === 1;
  }
  async finish(id: string, worker: string, generation: number, outcome: { resultRef: string; checkpoint?: number } | { errorCode: string }) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    const success = 'resultRef' in outcome;
    const value = success ? z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/).parse(outcome.resultRef) : terminalCode.parse(outcome.errorCode);
    const covered = success && outcome.checkpoint !== undefined ? checkpoint.parse(outcome.checkpoint) : null;
    const r = await this.pool.query(`UPDATE search_jobs SET
      state=CASE WHEN refresh_scope IS NOT NULL AND $7 AND requested_checkpoint>$8::bigint THEN 'pending'
        WHEN refresh_scope IS NOT NULL AND NOT $7 AND attempts<3 THEN 'pending' ELSE $4 END,
      completed_checkpoint=CASE WHEN refresh_scope IS NOT NULL AND $7 THEN GREATEST(completed_checkpoint,$8::bigint) ELSE completed_checkpoint END,
      attempts=CASE WHEN refresh_scope IS NOT NULL AND $7 AND requested_checkpoint>$8::bigint THEN 0 ELSE attempts END,
      result_ref=$5,error_code=$6,lease_owner=NULL,lease_until=NULL
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
        AND COALESCE(payload->>'purpose','') NOT IN ('reencode','reencode_plan')
        AND (refresh_scope IS NULL OR NOT $7 OR ($8::bigint IS NOT NULL AND $8::bigint>=claimed_checkpoint))`,
    [id, worker, generation, success ? 'succeeded' : 'failed', success ? value : null, success ? null : value, success, covered]);
    return r.rowCount === 1;
  }
  async cancel(id: string, actor: string) {
    uuid.parse(id);
    const r = await this.pool.query(`UPDATE search_jobs SET state='cancelled',generation=generation+1,
      lease_owner=NULL,lease_until=NULL WHERE id=$1 AND actor=$2 AND COALESCE(payload->>'purpose','') NOT IN ('reencode','reencode_plan')
      AND state IN ('pending','running') RETURNING id`, [id, actor]);
    return r.rowCount === 1;
  }
  /** Parent plans are small immutable control records in the same task table.
   * They reserve no separate model, executor, queue or per-source identity. */
  async enqueueMigrationPlan(actor:string,requestKey:string,input:unknown) {
    migrationActor(actor);
    const payload=searchMigrationPlanPayloadSchema.parse(input),total=migrationPlanChildCount(payload);
    const progress:SearchMigrationPlanProgress={schema_version:'search-reencode-plan-progress-v1',
      payload_fingerprint:searchMigrationPlanFingerprint(payload),phase:'preparing',next_partition:0,total_children:total,
      aggregate_sha256:null,coverage_sha256:null,index_manifest_sha256:null};
    return this.enqueueInternal(actor,requestKey,'rebuild',payload,progress);
  }
  async claimMigrationPlan(worker:string,leaseMs=30000,recoveryOnly=false):Promise<SearchJob|null> {
    uuid.parse(worker);z.number().int().min(1000).max(60000).parse(leaseMs);
    z.boolean().parse(recoveryOnly);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-reencode-plan-claim',0))");
      await c.query(`UPDATE search_jobs SET state='failed',error_code='attempts_exhausted',lease_owner=NULL,lease_until=NULL
        WHERE payload->>'purpose'='reencode_plan' AND state='running' AND lease_until<=clock_timestamp() AND attempts>=3
          AND migration_progress->>'phase' NOT IN ('activated','restoring','restore_failed')`);
      const live=await c.query(`SELECT 1 FROM search_jobs WHERE payload->>'purpose'='reencode_plan' AND state='running'
        AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() LIMIT 1`);
      if(live.rowCount){await c.query('COMMIT');return null;}
      const result=await c.query(`WITH candidate AS(SELECT id,state='running' AS reclaimed FROM search_jobs WHERE kind='rebuild' AND payload->>'purpose'='reencode_plan'
        AND expires_at>clock_timestamp() AND (attempts<3 OR migration_progress->>'phase' IN ('activated','restoring','restore_failed'))
        AND (NOT $3::boolean OR migration_progress->>'phase' IN ('activated','restoring','restore_failed'))
        AND (state='pending' OR (state='running' AND lease_until<=clock_timestamp()))
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE search_jobs j SET state='running',lease_owner=$1,lease_until=LEAST(j.expires_at,clock_timestamp()+$2::int*interval '1 millisecond'),
        generation=j.generation+1,attempts=j.attempts+1,error_code=NULL FROM candidate c WHERE j.id=c.id RETURNING j.*,c.reclaimed`,[worker,leaseMs,recoveryOnly]);
      const job=result.rows[0] as SearchJob|undefined;
      if(job){
        const spec=searchMigrationPlanPayloadSchema.parse(job.payload),progress=searchMigrationPlanProgressSchema.parse(job.migration_progress);
        if(result.rows[0].reclaimed&&['quiescing','catching_up','publishing'].includes(progress.phase)) {
          // Losing the parent lease releases Native ingress. A recovered worker
          // must obtain a new epoch/H, never reuse the old drained proof.
          const expired=!progress.switch_deadline_ms||progress.switch_deadline_ms<=Date.now();
          const next=searchMigrationPlanProgressSchema.parse({...progress,phase:expired?'ready':'quiescing',active_round:0,pause:null,final_plan:null,
            next_partition:migrationPlanChildCount(spec),total_children:migrationPlanChildCount(spec),aggregate_sha256:progress.base_aggregate_sha256,
            coverage_sha256:progress.base_coverage_sha256,index_manifest_sha256:progress.base_index_manifest_sha256,switch_error:expired?'finalization_timeout':null});
          await c.query(`UPDATE search_jobs SET state=$2,migration_progress=$3,lease_owner=CASE WHEN $2='succeeded' THEN NULL ELSE lease_owner END,
            lease_until=CASE WHEN $2='succeeded' THEN NULL ELSE lease_until END WHERE id=$1`,[job.id,expired?'succeeded':'running',boundedMigrationJson(next,8192)]);
          job.migration_progress=next;if(expired){await c.query('COMMIT');await this.reconcileMigrationPlanChildren(c,job.id);return null;}
        }
      }
      await c.query('COMMIT');await this.reconcileMigrationPlanChildren(c);return job??null;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async renewMigrationPlan(id:string,worker:string,generation:number,leaseMs=30000) {
    uuid.parse(id);uuid.parse(worker);z.number().int().positive().parse(generation);z.number().int().min(1000).max(60000).parse(leaseMs);
    return (await this.pool.query(`UPDATE search_jobs SET lease_until=LEAST(expires_at,clock_timestamp()+$4::int*interval '1 millisecond')
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND payload->>'purpose'='reencode_plan' AND state='running'
      AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`,[id,worker,generation,leaseMs])).rowCount===1;
  }
  async failMigrationPlan(id:string,worker:string,generation:number,errorCode:string) {
    uuid.parse(id);uuid.parse(worker);z.number().int().positive().parse(generation);
    z.enum(['source_changed','history_unavailable','storage_unavailable','artifact_invalid','capacity_exceeded','model_unavailable','encoding_failed']).parse(errorCode);
    const failed=(await this.pool.query(`UPDATE search_jobs SET state='failed',error_code=$4,lease_owner=NULL,lease_until=NULL
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND payload->>'purpose'='reencode_plan' AND state='running'
      AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
      AND migration_progress->>'phase' NOT IN ('activated','restoring','restore_failed')`,[id,worker,generation,errorCode])).rowCount===1;
    if(failed)await this.reconcileMigrationPlanChildren(this.pool,id);return failed;
  }
  private async migrationPlanLease(c:PoolClient,id:string,worker:string,generation:number) {
    uuid.parse(id);uuid.parse(worker);z.number().int().positive().parse(generation);
    return (await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND kind='rebuild'
      AND payload->>'purpose'='reencode_plan' AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
      FOR UPDATE`,[id,worker,generation])).rows[0] as SearchJob|undefined;
  }
  /** Regenerate IDs from the exact source catalog revision. At most eight live
   * children are admitted; completing a batch makes room without queue flooding.
   * The parent partition cursor and child inserts commit together. */
  async prepareMigrationPlanChildren(id:string,worker:string,generation:number,sourceIds:readonly string[],maximum=8) {
    z.number().int().min(1).max(8).parse(maximum);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      const parent=await this.migrationPlanLease(c,id,worker,generation);
      if(!parent){await c.query('COMMIT');return null;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),progress=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      if(!['preparing','encoding','catching_up'].includes(progress.phase)){await c.query('COMMIT');return {created:[],progress};}
      // Validate even on a repeated request with no capacity: never accept a
      // different source list just because every partition was already created.
      const round=migrationPlanRound(spec,progress);
      if(sourceIds.length!==round.spec.source_count||searchMigrationSourceIdsDigest(sourceIds)!==round.spec.source_ids_sha256)
        throw new SearchJobError('migration_source_catalog_changed');
      const active=(await c.query(`SELECT count(*)::int AS n FROM search_jobs WHERE actor=$1 AND refresh_scope IS NULL
        AND state IN ('pending','running') AND expires_at>clock_timestamp()`,[parent.actor])).rows[0].n;
      const queued=(await c.query(`SELECT count(*)::int AS n FROM search_jobs WHERE payload->>'plan_id'=$1 AND payload->>'plan_round'=$2
        AND COALESCE(payload->>'plan_switch_generation','0')=$3 AND state IN ('pending','running') AND expires_at>clock_timestamp()`,[parent.id,String(round.round),round.round===1?String(parent.generation):'0'])).rows[0].n;
      const count=(await c.query('SELECT count(*)::int AS n FROM search_jobs WHERE refresh_scope IS NULL')).rows[0].n;
      const available=Math.max(0,Math.min(maximum,8-queued,32-active,1000-count,progress.total_children-progress.next_partition));
      const created:SearchJob[]=[];
      for(let n=0;n<available;n++) {
        const index=progress.next_partition+n,payload=migrationPlanChild(parent.id,round.spec,sourceIds,index,round.round,round.after,parent.generation);
        const childProgress:SearchModelMigrationProgress={schema_version:'search-reencode-progress-v1',payload_fingerprint:searchModelMigrationFingerprint(payload),
          phase:'encoding',cursor:null,scanned:0,encoded:0,unavailable:0,source_completed_through:null,target_checkpoint:null,coverage_sha256:null,index_manifest_sha256:null};
        const json=JSON.stringify(payload),fingerprint=createHash('sha256').update('rebuild\n'+json).digest('hex');
        const result=await c.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,expires_at,migration_progress)
          VALUES($1,$2,$3,$4,'rebuild',$5,$6,$7) RETURNING *`,[randomUUID(),parent.actor,migrationPlanChildRequestId(parent.id,round.round,index,parent.generation),
          fingerprint,json,parent.expires_at,boundedMigrationJson(childProgress,8192)]);
        created.push(result.rows[0] as SearchJob);
      }
      const next=searchMigrationPlanProgressSchema.parse({...progress,phase:round.round===1?'catching_up':'encoding',next_partition:progress.next_partition+created.length});
      await c.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[parent.id,boundedMigrationJson(next,8192)]);
      await c.query('COMMIT');return {created,progress:next};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  /** Bounded immutable snapshot for independent current-artifact validation.
   * No image/vector bytes or arbitrary task IDs are accepted by this method. */
  async migrationPlanChildren(id:string,worker:string,generation:number):Promise<{parent:SearchJob;children:SearchJob[]}|null> {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');const parent=await this.migrationPlanLease(c,id,worker,generation);
      if(!parent){await c.query('COMMIT');return null;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),progress=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      const round=migrationPlanRound(spec,progress);
      const children=(await c.query(`SELECT * FROM search_jobs WHERE actor=$1 AND kind='rebuild' AND payload->>'purpose'='reencode'
        AND payload->>'plan_id'=$2 AND payload->>'plan_round'=$3 AND COALESCE(payload->>'plan_switch_generation','0')=$4
        ORDER BY (payload->>'partition_index')::int LIMIT 133`,[parent.actor,parent.id,String(round.round),round.round===1?String(parent.generation):'0'])).rows as SearchJob[];
      if(children.length!==progress.next_partition||children.length>migrationPlanChildCount(round.spec,round.round===1))throw new SearchJobError('migration_plan_children_changed');
      await c.query('COMMIT');return {parent,children};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  /** The artifact resolver runs under this transaction only after its bounded
   * Native metadata read was frozen. It re-locks the real PG shard directory;
   * neither a browser boolean nor counts alone can complete a parent plan. */
  async completeMigrationPlan(id:string,worker:string,generation:number,sourceIds:readonly string[],
    expectedChildren:readonly {id:string;generation:number;progress:unknown}[],
    validate:(client:PoolClient,parent:SearchJob,children:SearchJob[])=>Promise<{aggregate_sha256:string;coverage_sha256:string;index_manifest_sha256:string}>) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');const parent=await this.migrationPlanLease(c,id,worker,generation);
      if(!parent){await c.query('COMMIT');return false;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),progress=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      const round=migrationPlanRound(spec,progress);
      if(progress.total_children!==migrationPlanChildCount(round.spec,round.round===1)||progress.next_partition!==progress.total_children||expectedChildren.length!==progress.total_children){await c.query('COMMIT');return false;}
      const children=(await c.query(`SELECT * FROM search_jobs WHERE actor=$1 AND kind='rebuild' AND payload->>'purpose'='reencode'
        AND payload->>'plan_id'=$2 AND payload->>'plan_round'=$3 AND COALESCE(payload->>'plan_switch_generation','0')=$4
        AND state='succeeded' ORDER BY (payload->>'partition_index')::int FOR SHARE`,[parent.actor,parent.id,String(round.round),round.round===1?String(parent.generation):'0'])).rows as SearchJob[];
      if(children.length!==progress.total_children){await c.query('COMMIT');return false;}
      for(let index=0;index<children.length;index++) {
        const child=children[index]!,expected=expectedChildren[index],payload=migrationPlanChild(parent.id,round.spec,sourceIds,index,round.round,round.after,parent.generation);
        if(!expected||child.state!=='succeeded'||child.expires_at.getTime()<=Date.now()||child.id!==expected.id||child.generation!==expected.generation||
          searchModelMigrationFingerprint(searchModelMigrationPayloadSchema.parse(child.payload))!==searchModelMigrationFingerprint(payload)||JSON.stringify(searchModelMigrationProgressSchema.parse(child.migration_progress))!==JSON.stringify(searchModelMigrationProgressSchema.parse(expected.progress))) {
          await c.query('COMMIT');return false;
        }
      }
      const proof=await validate(c,parent,children),hash=z.string().regex(/^[a-f0-9]{64}$/);
      hash.parse(proof.aggregate_sha256);hash.parse(proof.coverage_sha256);hash.parse(proof.index_manifest_sha256);
      if(round.round===1&&(!parent.migration_acceptance||!progress.pause?.drained_at_ms||!progress.switch_deadline_ms||progress.switch_deadline_ms<=Date.now())){await c.query('COMMIT');return false;}
      // Resolver returns frozen child/report references for transaction checks;
      // only the three bounded digests belong in durable control progress.
      const next=searchMigrationPlanProgressSchema.parse({...progress,aggregate_sha256:proof.aggregate_sha256,
        coverage_sha256:proof.coverage_sha256,index_manifest_sha256:proof.index_manifest_sha256,
        phase:round.round===1?'publishing':'awaiting_acceptance'});
      const applied=await c.query(`UPDATE search_jobs SET state=$4,migration_progress=$2,result_ref=$3,
        lease_owner=CASE WHEN $4='succeeded' THEN NULL ELSE lease_owner END,lease_until=CASE WHEN $4='succeeded' THEN NULL ELSE lease_until END
        WHERE id=$1 AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`,[parent.id,boundedMigrationJson(next,8192),`migration-plan:${proof.aggregate_sha256}`,round.round===1?'running':'succeeded']);
      if(applied.rowCount!==1){await c.query('ROLLBACK');return false;}
      await this.migrationAudit(c,parent.actor,'search-migration-plan-complete',parent.id,{payload_fingerprint:progress.payload_fingerprint,
        aggregate_sha256:proof.aggregate_sha256,coverage_sha256:proof.coverage_sha256,index_manifest_sha256:proof.index_manifest_sha256});
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async acceptMigrationPlan(id:string,actor:string,input:unknown) {
    uuid.parse(id);migrationActor(actor);const proof=searchMigrationPlanAcceptanceSchema.parse(input);
    if(proof.job_id!==id||proof.accepted_by!==actor)throw new SearchJobError('migration_acceptance_identity');
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');const job=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND kind='rebuild'
        AND payload->>'purpose'='reencode_plan' AND state='succeeded' AND expires_at>clock_timestamp() FOR UPDATE`,[id,actor])).rows[0] as SearchJob|undefined;
      if(!job){await c.query('COMMIT');return false;}
      const spec=searchMigrationPlanPayloadSchema.parse(job.payload),state=searchMigrationPlanProgressSchema.parse(job.migration_progress);
      if(!['awaiting_acceptance','ready'].includes(state.phase)||proof.base_generation!==job.generation||proof.payload_fingerprint!==searchMigrationPlanFingerprint(spec)||
        proof.criteria_sha256!==spec.acceptance_criteria_sha256||proof.base_aggregate_sha256!==state.aggregate_sha256||
        proof.base_coverage_sha256!==state.coverage_sha256||proof.base_index_manifest_sha256!==state.index_manifest_sha256){await c.query('COMMIT');return false;}
      if(job.migration_acceptance){await c.query('COMMIT');return JSON.stringify(searchMigrationPlanAcceptanceSchema.parse(job.migration_acceptance))===JSON.stringify(proof);}
      const next=searchMigrationPlanProgressSchema.parse({...state,phase:'ready',base_aggregate_sha256:state.aggregate_sha256,
        base_coverage_sha256:state.coverage_sha256,base_index_manifest_sha256:state.index_manifest_sha256});
      await c.query('UPDATE search_jobs SET migration_progress=$2,migration_acceptance=$3 WHERE id=$1',[id,boundedMigrationJson(next,8192),boundedMigrationJson(proof,4096)]);
      await this.migrationAudit(c,actor,'search-migration-plan-accept',id,proof);await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  /** Human quality acceptance happens with normal sampling. Only the explicit
   * switch request schedules a short finalization attempt in the same task. */
  async requestMigrationPlanSwitch(id:string,actor:string,generation:number,payloadFingerprint:string) {
    uuid.parse(id);migrationActor(actor);z.number().int().positive().parse(generation);const c=await this.pool.connect();
    try {
      await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      const job=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND payload->>'purpose'='reencode_plan'
        AND expires_at>clock_timestamp() FOR UPDATE`,[id,actor])).rows[0] as SearchJob|undefined;
      if(!job){await c.query('COMMIT');return false;}
      const spec=searchMigrationPlanPayloadSchema.parse(job.payload),state=searchMigrationPlanProgressSchema.parse(job.migration_progress);
      if(searchMigrationPlanFingerprint(spec)!==payloadFingerprint||!job.migration_acceptance){await c.query('COMMIT');return false;}
      const accepted=searchMigrationPlanAcceptanceSchema.parse(job.migration_acceptance);
      if(accepted.payload_fingerprint!==payloadFingerprint){await c.query('COMMIT');return false;}
      if(['quiescing','catching_up','publishing'].includes(state.phase)&&['pending','running'].includes(job.state)){await c.query('COMMIT');return true;}
      if(job.generation!==generation||job.state!=='succeeded'||state.phase!=='ready'){await c.query('COMMIT');return false;}
      const count=(await c.query(`SELECT count(*)::int AS n FROM search_jobs WHERE actor=$1 AND state IN ('pending','running') AND expires_at>clock_timestamp()`,[actor])).rows[0].n;
      if(count>=32)throw new SearchJobError('actor_queue_full');
      const next=searchMigrationPlanProgressSchema.parse({...state,phase:'quiescing',active_round:0,pause:null,switch_deadline_ms:null,switch_error:null,final_plan:null});
      await c.query(`UPDATE search_jobs SET state='pending',attempts=0,generation=generation+1,lease_owner=NULL,lease_until=NULL,
        migration_progress=$2,error_code=NULL WHERE id=$1`,[id,boundedMigrationJson(next,8192)]);
      await this.migrationAudit(c,actor,'search-migration-switch-request',id,{payload_fingerprint:payloadFingerprint,base_report_sha256:accepted.report_sha256});
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async requestMigrationPlanPause(id:string,worker:string,generation:number) {
    const c=await this.pool.connect();try{
      await c.query('BEGIN');const parent=await this.migrationPlanLease(c,id,worker,generation);if(!parent){await c.query('COMMIT');return null;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),state=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      if(state.phase!=='quiescing'||!parent.migration_acceptance){await c.query('COMMIT');return null;}
      const now=Date.now();if(state.switch_deadline_ms&&state.switch_deadline_ms<=now){await c.query('COMMIT');return null;}
      const next=state.pause?state:searchMigrationPlanProgressSchema.parse({...state,pause:{epoch:randomUUID(),requested_at_ms:now,drained_at_ms:null,observed_extent:null},
        switch_deadline_ms:state.switch_deadline_ms??now+120000});
      await c.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[id,boundedMigrationJson(next,8192)]);
      await c.query('COMMIT');return {epoch:next.pause!.epoch,expires_ms:Math.min(parent.expires_at.getTime(),parent.lease_until!.getTime(),next.switch_deadline_ms!)};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  /** Only the search-service identity may call the matching route. Native must
   * first close source-write admission and drain real in-flight writes. */
  async acknowledgeMigrationPlanPause(id:string,worker:string,generation:number,epoch:string,observed:unknown,
    context:{revision:string;storage_generation:string;source:SearchMigrationModel;channels:readonly string[]}) {
    uuid.parse(epoch);const extent=searchMigrationObservedExtentSchema.parse(observed),c=await this.pool.connect();
    try {
      await c.query('BEGIN');const parent=await this.migrationPlanLease(c,id,worker,generation);if(!parent){await c.query('COMMIT');return false;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),state=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      if(!['quiescing','catching_up'].includes(state.phase)||!state.pause||state.pause.epoch!==epoch||!state.switch_deadline_ms||state.switch_deadline_ms<=Date.now()||
        spec.config_revision!==context.revision||spec.storage_generation!==context.storage_generation||JSON.stringify(spec.source)!==JSON.stringify(searchMigrationModelSchema.parse(context.source))||
        spec.source_ids_sha256!==searchMigrationSourceIdsDigest(context.channels)){await c.query('COMMIT');return false;}
      if(state.pause.drained_at_ms!==null) {
        const final=migrationPlanRound(spec,state).spec;
        const safe=BigInt(extent.high_watermark)<=BigInt(final.extent.source_high_watermark)&&
          (extent.from_ms===null||(final.extent.from_ms!==null&&extent.from_ms>=final.extent.from_ms))&&
          (extent.to_ms===null||(final.extent.to_ms!==null&&extent.to_ms<=final.extent.to_ms));
        await c.query('COMMIT');return safe;
      }
      const final=migrationPlanFinalSpec(spec,extent),next=searchMigrationPlanProgressSchema.parse({...state,phase:'catching_up',active_round:1,final_plan:final,
        pause:{...state.pause,drained_at_ms:Date.now(),observed_extent:extent},next_partition:0,total_children:migrationPlanChildCount(final,true),
        aggregate_sha256:null,coverage_sha256:null,index_manifest_sha256:null});
      await c.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[id,boundedMigrationJson(next,8192)]);
      await this.migrationAudit(c,parent.actor,'search-migration-plan-drained',id,{epoch,generation,source_high_watermark:final.extent.source_high_watermark});
      await c.query('COMMIT');return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async abortMigrationPlanSwitch(id:string,worker:string,generation:number,errorCode='finalization_timeout',
    fence?:{expectedEpoch:string;unacknowledgedOnly:true}) {
    z.enum(['finalization_timeout','history_unavailable','storage_unavailable','artifact_invalid','capacity_exceeded']).or(searchMigrationPauseRejectionCodeSchema).parse(errorCode);
    if(fence)z.object({expectedEpoch:uuid,unacknowledgedOnly:z.literal(true)}).strict().parse(fence);
    const c=await this.pool.connect();try{
      await c.query('BEGIN');
      if(fence){
        uuid.parse(id);uuid.parse(worker);z.number().int().positive().parse(generation);
        const old=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND payload->>'purpose'='reencode_plan'
          AND expires_at>clock_timestamp() FOR UPDATE`,[id])).rows[0] as SearchJob|undefined;
        const prior=old&&searchMigrationPlanProgressSchema.parse(old.migration_progress),receipt=prior?.pause?.rejection;
        if(old?.state==='succeeded'&&old.generation===generation+1&&prior?.phase==='ready'&&prior.pause?.epoch===fence.expectedEpoch&&prior.pause.drained_at_ms===null&&
          receipt?.worker===worker&&receipt.generation===generation&&receipt.error_code===errorCode){await c.query('COMMIT');return true;}
      }
      const parent=await this.migrationPlanLease(c,id,worker,generation);if(!parent){await c.query('COMMIT');return false;}
      const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),state=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      if(!['quiescing','catching_up','publishing'].includes(state.phase)||!parent.migration_acceptance){await c.query('COMMIT');return false;}
      if(fence&&(state.phase!=='quiescing'||state.pause?.epoch!==fence.expectedEpoch||state.pause.drained_at_ms!==null)){
        await c.query('COMMIT');return false;
      }
      const next=searchMigrationPlanProgressSchema.parse({...state,phase:'ready',active_round:0,final_plan:null,
        ...(fence?{pause:{...state.pause!,rejection:{worker,generation,error_code:searchMigrationPauseRejectionCodeSchema.parse(errorCode)}}}:{}),
        next_partition:migrationPlanChildCount(spec),total_children:migrationPlanChildCount(spec),aggregate_sha256:state.base_aggregate_sha256,
        coverage_sha256:state.base_coverage_sha256,index_manifest_sha256:state.base_index_manifest_sha256,switch_error:errorCode});
      await c.query(`UPDATE search_jobs SET state='succeeded',generation=generation+1,migration_progress=$2,lease_owner=NULL,lease_until=NULL,error_code=$3 WHERE id=$1`,[id,boundedMigrationJson(next,8192),errorCode]);
      await this.migrationAudit(c,parent.actor,'search-migration-switch-abort',id,{generation,error_code:errorCode});await c.query('COMMIT');
      await this.reconcileMigrationPlanChildren(c,id);return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  async markMigrationPlanRestoreFailed(id:string,worker:string,generation:number) {
    uuid.parse(id);uuid.parse(worker);z.number().int().positive().parse(generation);
    // Preserve the rollback version/proof for a late real source Ready ACK and
    // restart recovery. Never relabel an already-completed target as failure.
    return (await this.pool.query(`UPDATE search_jobs SET error_code='source_restore_failed',
      migration_progress=jsonb_set(jsonb_set(migration_progress,'{phase}','"restore_failed"'),'{switch_error}','"source_restore_failed"')
      WHERE id=$1 AND generation=$3 AND lease_owner=$2 AND state='running' AND expires_at>clock_timestamp()
        AND migration_progress->>'phase' IN ('activated','restoring','restore_failed')`,[id,worker,generation])).rowCount===1;
  }
  private async reconcileMigrationPlanChildren(c:Pick<PoolClient,'query'>,id?:string) {
    await c.query(`UPDATE search_jobs child SET state='cancelled',generation=child.generation+1,lease_owner=NULL,lease_until=NULL,error_code='parent_attempt_retired'
      WHERE child.id IN(SELECT old.id FROM search_jobs old WHERE old.payload->>'purpose'='reencode' AND old.payload->>'plan_id' IS NOT NULL
        AND ($1::text IS NULL OR old.payload->>'plan_id'=$1) AND old.state IN ('pending','running') AND NOT EXISTS(
          SELECT 1 FROM search_jobs parent WHERE parent.id::text=old.payload->>'plan_id' AND parent.state='running' AND parent.expires_at>clock_timestamp()
            AND parent.migration_progress->>'phase' IN ('preparing','encoding','catching_up')
            AND COALESCE(parent.migration_progress->>'active_round','0')=old.payload->>'plan_round'
            AND (old.payload->>'plan_round'='0' OR old.payload->>'plan_switch_generation'=parent.generation::text))
        ORDER BY old.id FOR UPDATE SKIP LOCKED LIMIT 264)`,[id??null]);
  }
  async ingestionGate(current:{revision:string;source_ids:readonly string[];active_model:SearchMigrationModel|null;approved_transition?:import('./searchRuntimeStore.js').SearchApprovedModelTransition|null}):Promise<{gate:SearchMigrationIngestionGate|null}> {
    const rows=(await this.pool.query(`SELECT * FROM search_jobs WHERE payload->>'purpose'='reencode_plan' AND state='running'
      AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND migration_progress->>'phase' IN ('quiescing','catching_up','publishing','activated')
      ORDER BY created_at,id LIMIT 2`)).rows as SearchJob[];
    const gates=rows.map(row=>migrationPlanIngestionGate(row,current)).filter((gate):gate is SearchMigrationIngestionGate=>gate!==null);
    if(gates.length>1)throw new SearchJobError('migration_gate_conflict');return {gate:gates[0]??null};
  }
  async cancelMigrationPlan(id:string,actor:string) {
    uuid.parse(id);migrationActor(actor);const c=await this.pool.connect();
    try {
      await c.query('BEGIN');const parent=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND kind='rebuild'
        AND payload->>'purpose'='reencode_plan' FOR UPDATE`,[id,actor])).rows[0] as SearchJob|undefined;
      if(!parent){await c.query('COMMIT');return false;}
      if(parent.state==='cancelled'){await c.query('COMMIT');await this.reconcileMigrationPlanChildren(c,id);return true;}
      const progress=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
      if(['activated','restoring','restore_failed'].includes(progress.phase)||parent.state==='failed'){await c.query('COMMIT');return false;}
      // Revoking the parent fences every child without holding parent and child
      // write locks in opposite order to the active encoder transaction.
      await c.query(`UPDATE search_jobs SET state='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,
        migration_acceptance=NULL WHERE id=$1`,[id]);
      await this.migrationAudit(c,actor,'search-migration-plan-cancel',id,{payload_fingerprint:progress.payload_fingerprint});
      await c.query('COMMIT');await this.reconcileMigrationPlanChildren(c,id);return true;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  /** One global background reencoder; ordinary index workers cannot claim these
   * jobs even through an unscoped claim(). Human actor ownership is unchanged. */
  async claimMigration(worker: string, leaseMs = 30000,planId?:string): Promise<SearchJob | null> {
    uuid.parse(worker);if(planId!==undefined)uuid.parse(planId); z.number().int().min(1000).max(60000).parse(leaseMs);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-reencode-claim',0))");
      await c.query(`UPDATE search_jobs SET state='failed',error_code='attempts_exhausted',lease_owner=NULL,lease_until=NULL
        WHERE kind='rebuild' AND payload->>'purpose'='reencode' AND state='running' AND lease_until<=clock_timestamp() AND attempts>=3`);
      const live = await c.query(`SELECT count(*)::int AS n FROM search_jobs WHERE kind='rebuild' AND payload->>'purpose'='reencode'
        AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`);
      if (live.rows[0].n) { await c.query('COMMIT'); return null; }
      const result = await c.query(`WITH candidate AS (SELECT id FROM search_jobs child WHERE kind='rebuild' AND payload->>'purpose'='reencode'
        AND ($3::text IS NULL OR payload->>'plan_id'=$3)
        AND migration_progress IS NOT NULL AND expires_at>clock_timestamp() AND attempts<3
        AND (payload->>'plan_id' IS NULL OR EXISTS(SELECT 1 FROM search_jobs parent
          WHERE parent.id::text=child.payload->>'plan_id' AND parent.payload->>'purpose'='reencode_plan'
            AND parent.actor=child.actor AND parent.state='running' AND parent.lease_owner=$1
            AND parent.lease_until>clock_timestamp() AND parent.expires_at>clock_timestamp()
            AND parent.migration_progress->>'phase' IN ('preparing','encoding','catching_up')
            AND COALESCE(parent.migration_progress->>'active_round','0')=child.payload->>'plan_round'
            AND (child.payload->>'plan_round'='0' OR child.payload->>'plan_switch_generation'=parent.generation::text)))
        AND (state='pending' OR (state='running' AND lease_until<=clock_timestamp()))
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE search_jobs j SET state='running',lease_owner=$1,lease_until=LEAST(j.expires_at,clock_timestamp()+$2::int*interval '1 millisecond'),
          generation=j.generation+1,attempts=j.attempts+1,result_ref=NULL,error_code=NULL
        FROM candidate c WHERE j.id=c.id RETURNING j.*`, [worker, leaseMs,planId??null]);
      const job = result.rows[0] as SearchJob | undefined;
      if (job) {
        searchModelMigrationPayloadSchema.parse(job.payload);
        searchModelMigrationProgressSchema.parse(job.migration_progress);
      }
      await c.query('COMMIT'); return job ?? null;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async renewMigration(id: string, worker: string, generation: number, leaseMs = 30000) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    z.number().int().min(1000).max(60000).parse(leaseMs);
    const row = await this.pool.query(`UPDATE search_jobs SET lease_until=LEAST(expires_at,clock_timestamp()+$4::int*interval '1 millisecond')
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND kind='rebuild' AND payload->>'purpose'='reencode'
        AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`, [id, worker, generation, leaseMs]);
    return row.rowCount === 1;
  }
  /** Actual Native target writes ask before/after reading the original evidence.
   * This is the same PG lease, not a reusable producer key or alternate grant DB. */
  async authorizeMigrationWrite(id:string,worker:string,generation:number,actor:string,payloadFingerprint:string,
    context:{revision:string;storage_generation:string;desired_version:number;source:SearchMigrationModel},rawSource?:unknown):Promise<SearchMigrationWriteGrant|null> {
    return this.authorizeMigrationAction(id,worker,generation,actor,payloadFingerprint,context,['encoding'],rawSource);
  }
  async authorizeMigrationArtifacts(id:string,worker:string,generation:number,actor:string,payloadFingerprint:string,
    context:{revision:string;storage_generation:string;desired_version:number;source:SearchMigrationModel}):Promise<SearchMigrationWriteGrant|null> {
    return this.authorizeMigrationAction(id,worker,generation,actor,payloadFingerprint,context,['building_index','awaiting_acceptance']);
  }
  private async authorizeMigrationAction(id:string,worker:string,generation:number,actor:string,payloadFingerprint:string,
    context:{revision:string;storage_generation:string;desired_version:number;source:SearchMigrationModel},phases:readonly string[],rawSource?:unknown):Promise<SearchMigrationWriteGrant|null> {
    migrationActor(actor);z.string().regex(/^[a-f0-9]{64}$/).parse(payloadFingerprint);
    const source=rawSource===undefined?undefined:searchMigrationWriteSourceSchema.parse(rawSource);
    const currentSource=searchMigrationModelSchema.parse({package_id:context.source.package_id,package_sha256:context.source.package_sha256,
      model_version:context.source.model_version}),c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job=await this.migrationLease(c,id,worker,generation);
      if(!job||job.actor!==actor){await c.query('COMMIT');return null;}
      const payload=searchModelMigrationPayloadSchema.parse(job.payload),progress=searchModelMigrationProgressSchema.parse(job.migration_progress);
      if(!phases.includes(progress.phase)||searchModelMigrationFingerprint(payload)!==payloadFingerprint||progress.payload_fingerprint!==payloadFingerprint||
        payload.config_revision!==context.revision||payload.storage_generation!==context.storage_generation||
        JSON.stringify(payload.source)!==JSON.stringify(currentSource)) {await c.query('COMMIT');return null;}
      const state=(await c.query(`SELECT st.desired_version,st.applied_version,st.status,r.desired_version AS runtime_desired,
        r.revision,r.status AS runtime_status,to_jsonb(r)->'active_model' AS active_model
        FROM config_service_states st JOIN search_runtime_state r ON r.singleton=true
        WHERE st.service_name='search-service' FOR SHARE OF st,r`)).rows[0];
      const pin=state?.active_model?searchMigrationModelSchema.parse(state.active_model):null;
      if(!state||state.status!=='applied'||state.runtime_status!=='applied'||state.desired_version!==context.desired_version||
        state.applied_version!==context.desired_version||state.runtime_desired!==context.desired_version||state.revision!==payload.config_revision||
        (pin&&JSON.stringify(pin)!==JSON.stringify(payload.source))) {await c.query('COMMIT');return null;}
      if(source&&(!payload.scope.channel_ids.includes(source.channel_id)||source.captured_ms<Date.parse(payload.scope.from)||
        source.captured_ms>=Date.parse(payload.scope.to)||BigInt(source.ordinal)>BigInt(payload.source_high_watermark)||
        BigInt(source.ordinal)<=BigInt(payload.source_after_watermark??'0'))) {
        await c.query('COMMIT');return null;
      }
      const lease_until_ms=Math.min(job.lease_until!.getTime(),job.expires_at.getTime());
      if(!Number.isSafeInteger(lease_until_ms)||lease_until_ms-Date.now()<1000){await c.query('COMMIT');return null;}
      const grant:SearchMigrationWriteGrant={job_id:job.id,worker,generation,payload_fingerprint:payloadFingerprint,source:payload.source,
        target:payload.target,scope:{channel_ids:payload.scope.channel_ids,from_ms:Date.parse(payload.scope.from),to_ms:Date.parse(payload.scope.to)},
        source_high_watermark:payload.source_high_watermark,lease_until_ms,job_expires_ms:job.expires_at.getTime(),target_checkpoint:progress.target_checkpoint??'0'};
      await c.query('COMMIT');return grant;
    }catch(error){await c.query('ROLLBACK');throw error;}
    finally{c.release();}
  }
  /** Read authority for an immutable finalized report is deliberately not a
   * live writer lease. It cannot be passed to target writes or index builds. */
  async authorizeMigrationReportRead(id:string,generation:number,actor:string,payloadFingerprint:string,
    context:{revision:string;storage_generation:string;desired_version:number;source:SearchMigrationModel;channels:readonly string[]}):Promise<SearchMigrationReportReadGrant|null> {
    uuid.parse(id);z.number().int().positive().parse(generation);migrationActor(actor);z.string().regex(/^[a-f0-9]{64}$/).parse(payloadFingerprint);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND generation=$2 AND actor=$3 AND kind='rebuild'
        AND payload->>'purpose'='reencode' AND state IN ('running','succeeded') AND expires_at>clock_timestamp() FOR SHARE`,[id,generation,actor])).rows[0] as SearchJob|undefined;
      if(!job){await c.query('COMMIT');return null;}
      const payload=searchModelMigrationPayloadSchema.parse(job.payload),progress=searchModelMigrationProgressSchema.parse(job.migration_progress);
      if(!['building_index','awaiting_acceptance','ready','activated'].includes(progress.phase)||progress.payload_fingerprint!==payloadFingerprint||
        searchModelMigrationFingerprint(payload)!==payloadFingerprint||payload.storage_generation!==context.storage_generation||
        payload.scope.channel_ids.some(channel=>!context.channels.includes(channel))){await c.query('COMMIT');return null;}
      if(payload.plan_id) {
        const parent=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND payload->>'purpose'='reencode_plan'
          AND state NOT IN ('failed','cancelled') AND expires_at>clock_timestamp() FOR SHARE`,[payload.plan_id,actor])).rows[0] as SearchJob|undefined;
        if(!parent){await c.query('COMMIT');return null;}job.expires_at=new Date(Math.min(job.expires_at.getTime(),parent.expires_at.getTime()));
      }
      const sameSource=payload.config_revision===context.revision&&JSON.stringify(searchMigrationModelSchema.parse(context.source))===JSON.stringify(payload.source);
      let activated=false;
      if(!sameSource&&progress.phase==='activated'&&job.migration_acceptance) {
        const accepted=searchModelMigrationAcceptanceSchema.parse(job.migration_acceptance);
        const current=(await c.query(`SELECT d.config,r.active_model,st.desired_version,st.applied_version,st.status FROM config_documents d
          JOIN config_service_states st ON st.service_name=d.service JOIN search_runtime_state r ON r.singleton=true
          WHERE d.service='search-service' AND d."group"='system' AND d.name='settings' FOR SHARE OF d,st,r`)).rows[0];
        activated=accepted.payload_fingerprint===payloadFingerprint&&accepted.generation===generation&&
          current?.config?.model?.package_id===payload.target.package_id&&current.desired_version===context.desired_version&&
          current.applied_version===current.desired_version&&current.status==='applied'&&
          searchMigrationModelSchema.safeParse(current.active_model).success&&JSON.stringify(searchMigrationModelSchema.parse(current.active_model))===JSON.stringify(payload.target);
      }
      if(!sameSource&&!activated){await c.query('COMMIT');return null;}
      const grant:SearchMigrationReportReadGrant={mode:'report_read',job_id:id,generation,actor,payload_fingerprint:payloadFingerprint,
        source:payload.source,target:payload.target,scope:{channel_ids:payload.scope.channel_ids,from_ms:Date.parse(payload.scope.from),to_ms:Date.parse(payload.scope.to)},
        source_high_watermark:payload.source_high_watermark,job_expires_ms:job.expires_at.getTime(),target_checkpoint:progress.target_checkpoint??'0'};
      await c.query('COMMIT');return grant;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
  private async migrationLease(c: PoolClient, id: string, worker: string, generation: number): Promise<SearchJob | null> {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    const child=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3
      AND kind='rebuild' AND payload->>'purpose'='reencode' AND state='running'
      AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`, [id, worker, generation])).rows[0] as SearchJob|undefined;
    if(!child)return null;
    const payload=searchModelMigrationPayloadSchema.parse(child.payload);
    if(payload.plan_id) {
      const parent=(await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND payload->>'purpose'='reencode_plan'
        AND state='running' AND lease_owner=$3 AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE`,
        [payload.plan_id,child.actor,worker])).rows[0] as SearchJob|undefined;
      if(!parent)return null;
      const plan=searchMigrationPlanPayloadSchema.parse(parent.payload),state=searchMigrationPlanProgressSchema.parse(parent.migration_progress),round=migrationPlanRound(plan,state);
      if(!['preparing','encoding','catching_up'].includes(state.phase)||payload.plan_round!==round.round||
        (round.round===1&&(payload.plan_switch_generation!==parent.generation||!state.switch_deadline_ms||state.switch_deadline_ms<=Date.now()))||
        payload.source_high_watermark!==round.spec.extent.source_high_watermark||(payload.source_after_watermark??'0')!==round.after||
        payload.config_revision!==plan.config_revision||payload.storage_generation!==plan.storage_generation||
        payload.acceptance_criteria_sha256!==plan.acceptance_criteria_sha256||
        JSON.stringify(payload.source)!==JSON.stringify(plan.source)||JSON.stringify(payload.target)!==JSON.stringify(plan.target))return null;
      child.lease_until=new Date(Math.min(child.lease_until!.getTime(),parent.lease_until!.getTime(),round.round===1?state.switch_deadline_ms!:Number.MAX_SAFE_INTEGER));
      child.expires_at=new Date(Math.min(child.expires_at.getTime(),parent.expires_at.getTime()));
    }
    return child;
  }
  async checkpointMigration(id: string, worker: string, generation: number, expected: unknown, next: unknown) {
    const before = searchModelMigrationProgressSchema.parse(expected), after = searchModelMigrationProgressSchema.parse(next);
    if (!['encoding', 'building_index', 'awaiting_acceptance'].includes(after.phase))
      throw new SearchJobError('migration_administrator_transition_required');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job = await this.migrationLease(c, id, worker, generation);
      if (!job) { await c.query('COMMIT'); return false; }
      const payload = searchModelMigrationPayloadSchema.parse(job.payload);
      validateSearchMigrationCheckpoint(payload, before, after);
      const actual = searchModelMigrationProgressSchema.parse(job.migration_progress);
      if (JSON.stringify(actual) === JSON.stringify(after)) { await c.query('COMMIT'); return true; }
      if (JSON.stringify(actual) !== JSON.stringify(before)) { await c.query('COMMIT'); return false; }
      await c.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1', [id, boundedMigrationJson(after, 8192)]);
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async finishMigration(id: string, worker: string, generation: number, expected: unknown) {
    const final = searchModelMigrationProgressSchema.parse(expected);
    if (final.phase !== 'awaiting_acceptance') throw new SearchJobError('migration_artifacts_incomplete');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job = await this.migrationLease(c, id, worker, generation);
      if (!job) { await c.query('COMMIT'); return false; }
      const payload = searchModelMigrationPayloadSchema.parse(job.payload);
      if (final.payload_fingerprint !== searchModelMigrationFingerprint(payload) ||
          final.source_completed_through !== payload.source_high_watermark ||
          JSON.stringify(searchModelMigrationProgressSchema.parse(job.migration_progress)) !== JSON.stringify(final)) {
        await c.query('COMMIT'); return false;
      }
      await c.query(`UPDATE search_jobs SET state='succeeded',lease_owner=NULL,lease_until=NULL,
        result_ref=$2,error_code=NULL WHERE id=$1`, [id, `migration:${final.index_manifest_sha256}`]);
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async failMigration(id: string, worker: string, generation: number, errorCode: string) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    z.enum(['model_unavailable', 'history_unavailable', 'storage_unavailable', 'capacity_exceeded',
      'source_changed', 'encoding_failed', 'artifact_invalid']).parse(errorCode);
    const row = await this.pool.query(`UPDATE search_jobs SET state='failed',error_code=$4,lease_owner=NULL,lease_until=NULL
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND kind='rebuild' AND payload->>'purpose'='reencode'
        AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()`, [id, worker, generation, errorCode]);
    return row.rowCount === 1;
  }
  /** The route supplies authenticated actor and freshly constructed acceptance.
   * Server-side artifact/criteria checks precede this durable audited decision. */
  async acceptMigration(id: string, actor: string, input: unknown) {
    uuid.parse(id); migrationActor(actor);
    const proof = searchModelMigrationAcceptanceSchema.parse(input);
    if (proof.job_id !== id || proof.accepted_by !== actor) throw new SearchJobError('migration_acceptance_identity');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job = (await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND kind='rebuild'
        AND payload->>'purpose'='reencode' AND state='succeeded' AND expires_at>clock_timestamp() FOR UPDATE`, [id, actor])).rows[0] as SearchJob | undefined;
      if (!job || job.generation !== proof.generation) { await c.query('COMMIT'); return false; }
      const payload = searchModelMigrationPayloadSchema.parse(job.payload), progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
      if (!['awaiting_acceptance', 'ready'].includes(progress.phase) || proof.payload_fingerprint !== searchModelMigrationFingerprint(payload) ||
          progress.payload_fingerprint !== proof.payload_fingerprint || proof.criteria_sha256 !== payload.acceptance_criteria_sha256 ||
          proof.source_completed_through !== payload.source_high_watermark || proof.source_completed_through !== progress.source_completed_through ||
          proof.target_checkpoint !== progress.target_checkpoint || proof.coverage_sha256 !== progress.coverage_sha256 ||
          proof.index_manifest_sha256 !== progress.index_manifest_sha256) { await c.query('COMMIT'); return false; }
      if (job.migration_acceptance) {
        const saved = searchModelMigrationAcceptanceSchema.parse(job.migration_acceptance);
        await c.query('COMMIT'); return JSON.stringify(saved) === JSON.stringify(proof);
      }
      const next = { ...progress, phase: 'ready' as const };
      await c.query('UPDATE search_jobs SET migration_progress=$2,migration_acceptance=$3 WHERE id=$1',
        [id, boundedMigrationJson(next, 8192), boundedMigrationJson(proof, 4096)]);
      await this.migrationAudit(c, actor, 'search-migration-accept', id, proof);
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async cancelMigration(id: string, actor: string) {
    uuid.parse(id); migrationActor(actor);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const job = (await c.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND kind='rebuild'
        AND payload->>'purpose'='reencode' FOR UPDATE`, [id, actor])).rows[0] as SearchJob | undefined;
      if (!job) { await c.query('COMMIT'); return false; }
      if (job.state === 'cancelled') { await c.query('COMMIT'); return true; }
      const progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
      if (progress.phase === 'activated' || job.state === 'failed') { await c.query('COMMIT'); return false; }
      await c.query(`UPDATE search_jobs SET state='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,
        migration_acceptance=NULL WHERE id=$1`, [id]);
      await this.migrationAudit(c, actor, 'search-migration-cancel', id, { payload_fingerprint: progress.payload_fingerprint });
      await c.query('COMMIT'); return true;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  private async migrationAudit(c: PoolClient, actor: string, action: string, jobId: string, detail: unknown) {
    await c.query(`INSERT INTO config_audit_logs(actor,action,service,"group",config_name,detail)
      VALUES($1,$2,'search-service','system','settings',$3)`, [actor, action, JSON.stringify({ job_id: jobId, proof: detail })]);
    await c.query(CONFIG_HISTORY_RETENTION_SQL);
  }
  async get(id: string, actor: string, includeExpired = false): Promise<SearchJob | null> {
    uuid.parse(id);
    const r = await this.pool.query('SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND ($3 OR expires_at>clock_timestamp())', [id, actor, includeExpired]);
    return r.rows[0] ?? null;
  }
  async listMigrationPlans(actor:string,limit=8):Promise<SearchJob[]> {
    migrationActor(actor);z.number().int().min(1).max(8).parse(limit);
    return (await this.pool.query(`SELECT * FROM search_jobs WHERE actor=$1 AND kind='rebuild'
      AND payload->>'purpose'='reencode_plan' AND expires_at>clock_timestamp()
      ORDER BY (state IN ('pending','running')) DESC,created_at DESC,id DESC LIMIT $2`,[actor,limit])).rows as SearchJob[];
  }
}
