import type { Pool, PoolClient } from 'pg';
import type {SearchJob} from './searchJobs.js';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanProgressSchema,searchMigrationPlanAcceptanceSchema,searchMigrationPlanFingerprint,migrationPlanRound,migrationPlanChildCount} from '../services/searchModelMigrationPlan.js';
import { searchMigrationModelSchema, searchModelMigrationPayloadSchema, searchModelMigrationProgressSchema,
  searchModelMigrationAcceptanceSchema, searchModelMigrationFingerprint, type SearchMigrationModel } from '../services/searchModelMigrationContract.js';
export interface SearchRuntimeState {
  desired_version: number; revision: string; status: 'applied' | 'failed'; error_code: string | null;
  active_model?: SearchMigrationModel | null;
}
export interface SearchApprovedModelTransition { job_id: string; generation: number; payload_fingerprint: string;
  source: SearchMigrationModel; target: SearchMigrationModel }
export interface SearchModelAuthority { active_model_pin: SearchMigrationModel | null;
  approved_model_transition: SearchApprovedModelTransition | null }
export class SearchModelPinError extends Error { constructor() { super('model_migration_required'); } }
const sameModel=(left: SearchMigrationModel,right: SearchMigrationModel)=>left.package_id===right.package_id&&left.package_sha256===right.package_sha256&&left.model_version===right.model_version;
const sameTransition=(left:SearchApprovedModelTransition|null,right:SearchApprovedModelTransition|null)=>left===null?right===null:
  right!==null&&left.job_id===right.job_id&&left.generation===right.generation&&left.payload_fingerprint===right.payload_fingerprint&&
  sameModel(left.source,right.source)&&sameModel(left.target,right.target);
function pin(value: unknown) {
  const parsed=searchMigrationModelSchema.parse(value);
  if(parsed.package_sha256!==parsed.model_version.slice(10)) throw new SearchModelPinError();
  return parsed;
}
/** One current dependency ACK, not another configuration store or history DB. */
export class SearchRuntimeStore {
  constructor(private readonly pool: Pool) {}
  async read(): Promise<SearchRuntimeState | null> {
    const result = await this.pool.query("SELECT desired_version,revision,status,error_code,to_jsonb(s)->'active_model' AS active_model FROM search_runtime_state s WHERE singleton=true");
    const row=result.rows[0];if(!row)return null;
    const {active_model,...base}=row;
    return active_model ? {...base,active_model:pin(active_model)} : base;
  }
  /** A current configuration may authorize a target, while the actual pin stays
   * on the old space until a real Ready ACK. Both fields enter runtime revision. */
  async modelAuthority(client: Pick<PoolClient,'query'> = this.pool): Promise<SearchModelAuthority> {
    const old=(await client.query("SELECT to_jsonb(s)->'active_model' AS active_model FROM search_runtime_state s WHERE singleton=true")).rows[0]?.active_model;
    const active_model_pin=old?pin(old):null;
    const desired=(await client.query(`SELECT st.desired_version,s.config->'model'->>'package_id' AS package_id
      FROM config_service_states st JOIN config_versions v ON v.version=st.desired_version
      JOIN config_snapshots s ON s.version_id=v.id AND s.service='search-service' AND s."group"='system' AND s.name='settings'
      WHERE st.service_name='search-service'`)).rows[0];
    if(!desired?.package_id)return {active_model_pin,approved_model_transition:null};
    const rows=(await client.query(`SELECT * FROM search_jobs WHERE kind='rebuild' AND payload->>'purpose' IN ('reencode','reencode_plan')
      AND (state='succeeded' OR (payload->>'purpose'='reencode_plan' AND state='running' AND lease_until>clock_timestamp())) AND migration_progress->>'phase'='activated' AND migration_acceptance IS NOT NULL
      AND payload->'target'->>'package_id'=$1 AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT 4`,[desired.package_id])).rows;
    for(const row of rows) {
      if(row.payload?.purpose==='reencode_plan') {
        const p=searchMigrationPlanPayloadSchema.safeParse(row.payload),v=searchMigrationPlanProgressSchema.safeParse(row.migration_progress),a=searchMigrationPlanAcceptanceSchema.safeParse(row.migration_acceptance);
        if(!p.success||!v.success||!a.success)continue;
        const payload=p.data,progress=v.data,acceptance=a.data,fp=searchMigrationPlanFingerprint(payload);
        if(row.state!=='running'||!row.lease_until||new Date(row.lease_until).getTime()<=Date.now()||
          !progress.switch_deadline_ms||progress.switch_deadline_ms<=Date.now()||progress.published_version!==desired.desired_version||
          progress.active_round!==1||progress.phase!=='activated'||!progress.pause?.drained_at_ms||
          acceptance.job_id!==row.id||acceptance.payload_fingerprint!==fp||progress.payload_fingerprint!==fp||
          acceptance.criteria_sha256!==payload.acceptance_criteria_sha256||acceptance.base_aggregate_sha256!==progress.base_aggregate_sha256||
          acceptance.base_coverage_sha256!==progress.base_coverage_sha256||acceptance.base_index_manifest_sha256!==progress.base_index_manifest_sha256||
          !progress.aggregate_sha256||!progress.coverage_sha256||!progress.index_manifest_sha256||
          (active_model_pin&&!sameModel(active_model_pin,payload.source)))continue;
        try{migrationPlanRound(payload,progress);}catch{continue;}
        return {active_model_pin,approved_model_transition:{job_id:row.id,generation:row.generation,payload_fingerprint:fp,source:payload.source,target:payload.target}};
      }

      const p=searchModelMigrationPayloadSchema.safeParse(row.payload),v=searchModelMigrationProgressSchema.safeParse(row.migration_progress),a=searchModelMigrationAcceptanceSchema.safeParse(row.migration_acceptance);
      if(!p.success||!v.success||!a.success)continue;
      const payload=p.data,progress=v.data,acceptance=a.data,fp=searchModelMigrationFingerprint(payload);
      if((active_model_pin && !sameModel(active_model_pin,payload.source))||acceptance.job_id!==row.id||acceptance.generation!==row.generation||
        acceptance.payload_fingerprint!==fp||progress.payload_fingerprint!==fp||acceptance.criteria_sha256!==payload.acceptance_criteria_sha256||
        acceptance.source_completed_through!==payload.source_high_watermark||acceptance.source_completed_through!==progress.source_completed_through||
        acceptance.target_checkpoint!==progress.target_checkpoint||acceptance.coverage_sha256!==progress.coverage_sha256||
        acceptance.index_manifest_sha256!==progress.index_manifest_sha256)continue;
      return {active_model_pin,approved_model_transition:{job_id:row.id,generation:row.generation,payload_fingerprint:fp,source:payload.source,target:payload.target}};
    }
    return {active_model_pin,approved_model_transition:null};
  }
  /** Legacy source identity comes only from actual published PG history plus its
   * retained index job's package mapping, never from today's mutable HBM bytes. */
  async legacySourceModel(packageId: string): Promise<SearchMigrationModel|null> {
    const rows=(await this.pool.query(`SELECT DISTINCT s.model_version FROM search_index_shards s JOIN search_jobs j ON j.id=s.build_job_id
      WHERE s.published_revision IS NOT NULL AND s.manifest_sha256 IS NOT NULL AND s.record_count>0 AND s.state<>'deleting'
        AND j.payload->>'package_id'=$1 LIMIT 2`,[packageId])).rows;
    if(rows.length!==1||!/^search-v1-[a-f0-9]{64}$/.test(rows[0].model_version))return null;
    return pin({package_id:packageId,model_version:rows[0].model_version,package_sha256:rows[0].model_version.slice(10)});
  }
  async acknowledge(state: SearchRuntimeState,verified?:{expected_transition:SearchApprovedModelTransition|null}): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query("SELECT desired_version FROM config_service_states WHERE service_name='search-service' FOR UPDATE");
      if (current.rows[0]?.desired_version !== state.desired_version) { await client.query('ROLLBACK'); return false; }
      // Same service -> runtime -> authority-job order as publish/restore.
      // The service row serializes inserts when the first runtime row is absent.
      await client.query('SELECT singleton FROM search_runtime_state WHERE singleton=true FOR UPDATE');
      let validatedTransition:SearchApprovedModelTransition|null=null;
      if(state.active_model) {
        if(state.status!=='applied')throw new SearchModelPinError();
        const candidate=pin(state.active_model),authority=await this.modelAuthority(client);
        if(verified&&!sameTransition(verified.expected_transition,authority.approved_model_transition))throw new SearchModelPinError();
        const desired=(await client.query(`SELECT s.config->'model'->>'package_id' AS package_id FROM config_versions v
          JOIN config_snapshots s ON s.version_id=v.id AND s.service='search-service' AND s."group"='system' AND s.name='settings'
          WHERE v.version=$1`,[state.desired_version])).rows[0]?.package_id;
        if(desired!==candidate.package_id)throw new SearchModelPinError();
        const approved=authority.approved_model_transition && sameModel(authority.approved_model_transition.target,candidate);
        if(approved&&(!authority.active_model_pin||!sameModel(authority.active_model_pin,candidate)))validatedTransition=authority.approved_model_transition;
        if(authority.active_model_pin ? !sameModel(authority.active_model_pin,candidate)&&!approved : !approved) {
          if(authority.active_model_pin)throw new SearchModelPinError();
          // Native additionally verifies all actual Mongo spaces before Load;
          // PG empty alone is never a substitute for that hardware-side check.
          const history=await client.query(`SELECT DISTINCT model_version FROM search_index_shards
            WHERE published_revision IS NOT NULL AND record_count>0 AND state<>'deleting' LIMIT 2`);
          if(history.rows.some(row=>row.model_version!==candidate.model_version))throw new SearchModelPinError();
        }
      }
      await client.query(`INSERT INTO search_runtime_state(singleton,desired_version,revision,status,error_code)
        VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO UPDATE SET desired_version=EXCLUDED.desired_version,
        revision=EXCLUDED.revision,status=EXCLUDED.status,error_code=EXCLUDED.error_code,updated_at=now()`,
      [state.desired_version, state.revision, state.status, state.error_code]);
      if(state.active_model) {
        const actual=pin(state.active_model);
        let locked:SearchJob|undefined;
        if(validatedTransition){
          // Old read-authorizers can hold a job SHARE lock before service SHARE.
          // Never wait in the opposite direction: rollback and retry the ACK.
          locked=(await client.query('SELECT * FROM search_jobs WHERE id=$1 AND generation=$2 FOR UPDATE NOWAIT',
            [validatedTransition.job_id,validatedTransition.generation])).rows[0];
          if(!locked)throw new SearchModelPinError();
        }
        const approval=(await this.modelAuthority(client)).approved_model_transition;
        if(verified&&!sameTransition(verified.expected_transition,approval))throw new SearchModelPinError();
        if(validatedTransition&&(!approval||approval.job_id!==validatedTransition.job_id||approval.generation!==validatedTransition.generation||
          approval.payload_fingerprint!==validatedTransition.payload_fingerprint||!sameModel(approval.target,actual)))throw new SearchModelPinError();
        if(validatedTransition&&locked&&searchMigrationPlanPayloadSchema.safeParse(locked.payload).success){
          const spec=searchMigrationPlanPayloadSchema.parse(locked.payload),progress=searchMigrationPlanProgressSchema.parse(locked.migration_progress);
          if(!locked.lease_owner||!sameModel(spec.source,validatedTransition.source)||!sameModel(spec.target,actual)||
            progress.published_version!==state.desired_version||progress.payload_fingerprint!==validatedTransition.payload_fingerprint)
            throw new SearchModelPinError();
          const cas=await client.query(`UPDATE search_jobs SET state='succeeded',lease_owner=NULL,lease_until=NULL
            WHERE id=$1 AND generation=$2 AND lease_owner=$3 AND state='running'
              AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
              AND migration_progress->>'phase'='activated' AND migration_progress->>'published_version'=$4
              AND (migration_progress->>'switch_deadline_ms')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`,
            [locked.id,locked.generation,locked.lease_owner,String(state.desired_version)]);
          if(cas.rowCount!==1)throw new SearchModelPinError();
        }
        await client.query('UPDATE search_runtime_state SET active_model=$1 WHERE singleton=true',[JSON.stringify(actual)]);
        // Restoring a desired document is not evidence that its original space
        // is serving again. Only this real source Ready ACK completes recovery.
        const restoring=(await client.query(`SELECT * FROM search_jobs WHERE payload->>'purpose'='reencode_plan'
          AND state='running' AND migration_progress->>'phase' IN ('restoring','restore_failed')
          AND migration_progress->>'rollback_version'=$1 AND expires_at>clock_timestamp() LIMIT 2 FOR UPDATE NOWAIT`,[String(state.desired_version)])).rows;
        for(const job of restoring){
          const spec=searchMigrationPlanPayloadSchema.parse(job.payload),progress=searchMigrationPlanProgressSchema.parse(job.migration_progress);
          if(!sameModel(actual,spec.source))continue;
          const restored=searchMigrationPlanProgressSchema.parse({...progress,phase:'restored',active_round:0,final_plan:null,pause:null,switch_deadline_ms:null,
            next_partition:migrationPlanChildCount(spec),total_children:migrationPlanChildCount(spec),aggregate_sha256:progress.base_aggregate_sha256,
            coverage_sha256:progress.base_coverage_sha256,index_manifest_sha256:progress.base_index_manifest_sha256,switch_error:'target_activation_failed'});
          await client.query(`UPDATE search_jobs SET state='succeeded',lease_owner=NULL,lease_until=NULL,error_code=NULL,migration_progress=$2 WHERE id=$1`,[job.id,JSON.stringify(restored)]);
        }
      }
      await client.query(`UPDATE config_service_states SET status=$2::text,restart_required=false,error_message=$3,
        applied_version=CASE WHEN $2::text='applied' THEN $1 ELSE applied_version END,
        applied_at=CASE WHEN $2::text='applied' THEN now() ELSE applied_at END,last_check_at=now()
        WHERE service_name='search-service' AND desired_version=$1`,
      [state.desired_version, state.status, state.error_code ?? '']);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
