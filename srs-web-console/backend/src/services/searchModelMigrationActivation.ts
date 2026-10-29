import type { PoolClient } from 'pg';
import type { PgConfigStore } from '../store/pgStore.js';
import { searchSettingsSchema } from '../store/searchConfigAdapter.js';
import { assertSearchMigrationActivation, searchMigrationModelSchema, searchModelMigrationPayloadSchema, searchModelMigrationProgressSchema,
  searchModelMigrationFingerprint, type SearchMigrationModel } from './searchModelMigrationContract.js';
import type { SearchJob } from '../store/searchJobs.js';
import type { NativeMigrationExtent } from './searchNativeClient.js';
import type { SearchModelMigrationArtifacts, SearchMigrationArtifacts } from './searchModelMigrationArtifacts.js';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanProgressSchema,searchMigrationPlanAcceptanceSchema,
  searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,migrationPlanRound} from './searchModelMigrationPlan.js';
import type {SearchModelMigrationPlanArtifacts,SearchMigrationPlanArtifacts} from './searchModelMigrationPlanArtifacts.js';

export interface SearchModelMigrationContext {
  revision: string; storage_generation: string; desired_version: number;
  source: SearchMigrationModel; channels: string[]; extent: NativeMigrationExtent;
}

type PlanContext=Omit<SearchModelMigrationContext,'extent'>;
const sameModel=(a:unknown,b:unknown)=>{
  const left=searchMigrationModelSchema.safeParse(a),right=searchMigrationModelSchema.safeParse(b);
  return left.success&&right.success&&left.data.package_id===right.data.package_id&&
    left.data.package_sha256===right.data.package_sha256&&left.data.model_version===right.data.model_version;
};
/** This is the existing config_publish transaction's prepare hook, not a
 * second publication authority. The Native epoch was ACKed only after sealing
 * and draining source writes; the final report covers 0..H, including prefix. */
export async function prepareSearchModelMigrationPlanActivation(client:PoolClient,options:{
  store:Pick<PgConfigStore,'addAuditLog'>;artifacts:SearchModelMigrationPlanArtifacts;
  job:SearchJob;worker:string;context:PlanContext;frozen:SearchMigrationPlanArtifacts;
}) {
  const {context,store}=options;
  const service=(await client.query("SELECT * FROM config_service_states WHERE service_name='search-service' FOR UPDATE")).rows[0];
  const ack=(await client.query('SELECT * FROM search_runtime_state WHERE singleton=true FOR UPDATE')).rows[0];
  const job=(await client.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND generation=$3
    AND lease_owner=$4 AND state='running' AND lease_until>clock_timestamp()+interval '1 second'
    AND expires_at>clock_timestamp() FOR UPDATE`,[options.job.id,options.job.actor,options.job.generation,options.worker])).rows[0] as SearchJob|undefined;
  if(!job)throw new SearchMigrationActivationError('migration_job_stale');
  const spec=searchMigrationPlanPayloadSchema.parse(job.payload),state=searchMigrationPlanProgressSchema.parse(job.migration_progress),
    accepted=searchMigrationPlanAcceptanceSchema.parse(job.migration_acceptance),fp=searchMigrationPlanFingerprint(spec);
  if(state.phase!=='publishing'||state.active_round!==1||!state.pause?.drained_at_ms||!state.pause.observed_extent||
    !state.switch_deadline_ms||state.switch_deadline_ms<=Date.now()+1000||state.payload_fingerprint!==fp||
    accepted.job_id!==job.id||accepted.payload_fingerprint!==fp||accepted.criteria_sha256!==spec.acceptance_criteria_sha256||
    accepted.accepted_by!==job.actor||accepted.base_aggregate_sha256!==state.base_aggregate_sha256||
    accepted.base_coverage_sha256!==state.base_coverage_sha256||accepted.base_index_manifest_sha256!==state.base_index_manifest_sha256||
    context.revision!==spec.config_revision||context.storage_generation!==spec.storage_generation||!sameModel(context.source,spec.source)||
    context.channels.length!==spec.source_count||searchMigrationSourceIdsDigest(context.channels)!==spec.source_ids_sha256)
    throw new SearchMigrationActivationError('migration_finalization_pending');
  migrationPlanRound(spec,state);
  if(!service||service.status!=='applied'||service.applied_version!==context.desired_version||service.desired_version!==context.desired_version||
    ack?.status!=='applied'||ack.desired_version!==context.desired_version||ack.revision!==context.revision||
    (ack.active_model&&!sameModel(ack.active_model,spec.source)))throw new SearchMigrationActivationError('migration_source_changed');
  const document=(await client.query(`SELECT d.id,d.config,d.config IS NOT DISTINCT FROM s.config AS matches_applied
    FROM config_documents d JOIN config_versions v ON v.version=$1 JOIN config_snapshots s ON s.version_id=v.id
    AND s.service=d.service AND s."group"=d."group" AND s.name=d.name
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings' FOR UPDATE OF d`,[context.desired_version])).rows[0];
  const config=searchSettingsSchema.safeParse(document?.config);
  if(!document?.matches_applied||!config.success||config.data.model.package_id!==spec.source.package_id)
    throw new SearchMigrationActivationError('migration_source_changed');
  const children=(await client.query(`SELECT * FROM search_jobs WHERE payload->>'plan_id'=$1 AND payload->>'plan_round'='1'
    AND payload->>'plan_switch_generation'=$2 ORDER BY (payload->>'partition_index')::int LIMIT 133 FOR SHARE`,[job.id,String(job.generation)])).rows as SearchJob[];
  const proof=await options.artifacts.resolve(job,children,context.channels,client,options.frozen,true);
  if(proof.aggregate_sha256!==state.aggregate_sha256||proof.coverage_sha256!==state.coverage_sha256||proof.index_manifest_sha256!==state.index_manifest_sha256||
    proof.children.some(child=>child.artifacts.report.unavailable!==0||child.artifacts.report.scanned!==child.artifacts.report.encoded))
    throw new SearchMigrationActivationError('migration_coverage_incomplete');
  const version=Number((await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM config_versions')).rows[0].version);
  const progress=searchMigrationPlanProgressSchema.parse({...state,phase:'activated',source_config_version:context.desired_version,published_version:version,rollback_version:null});
  await client.query('UPDATE config_documents SET config=$2,updated_at=now() WHERE id=$1',[document.id,JSON.stringify({...config.data,model:{package_id:spec.target.package_id}})]);
  await client.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[job.id,JSON.stringify(progress)]);
  await store.addAuditLog({actor:job.actor,action:'search-migration-plan-publish',service:'search-service',versionBefore:context.desired_version,versionAfter:version,
    detail:{job_id:job.id,generation:job.generation,payload_fingerprint:fp,epoch:state.pause.epoch,aggregate_sha256:proof.aggregate_sha256}},client);
}

/** Restore only the exact unpublished/failed target desired version. A target
 * Ready ACK racing this transaction wins: never roll a successful switch back.
 * Only the search document is restored; unrelated current edits stay intact. */
export async function prepareSearchModelMigrationPlanRestore(client:PoolClient,options:{
  store:Pick<PgConfigStore,'addAuditLog'>;job:SearchJob;worker:string;
}) {
  const service=(await client.query("SELECT * FROM config_service_states WHERE service_name='search-service' FOR UPDATE")).rows[0];
  const ack=(await client.query('SELECT * FROM search_runtime_state WHERE singleton=true FOR UPDATE')).rows[0];
  const job=(await client.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND generation=$3 AND lease_owner=$4
    AND state='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,
    [options.job.id,options.job.actor,options.job.generation,options.worker])).rows[0] as SearchJob|undefined;
  if(!job)throw new SearchMigrationActivationError('migration_job_stale');
  const spec=searchMigrationPlanPayloadSchema.parse(job.payload),state=searchMigrationPlanProgressSchema.parse(job.migration_progress);
  if(!['activated','restore_failed'].includes(state.phase)||!state.source_config_version||!state.published_version||state.rollback_version||service?.desired_version!==state.published_version||
    (ack?.active_model&&!sameModel(ack.active_model,spec.source)))throw new SearchMigrationActivationError('migration_restore_conflict');
  const row=(await client.query(`SELECT d.id,d.config IS NOT DISTINCT FROM published.config AS matches_target,original.config AS source_config
    FROM config_documents d JOIN config_versions pv ON pv.version=$1 JOIN config_snapshots published ON published.version_id=pv.id
    AND published.service=d.service AND published."group"=d."group" AND published.name=d.name
    JOIN config_versions ov ON ov.version=$2 JOIN config_snapshots original ON original.version_id=ov.id
    AND original.service=d.service AND original."group"=d."group" AND original.name=d.name
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings' FOR UPDATE OF d`,[state.published_version,state.source_config_version])).rows[0];
  const original=searchSettingsSchema.safeParse(row?.source_config);
  if(!row?.matches_target||!original.success||original.data.model.package_id!==spec.source.package_id)
    throw new SearchMigrationActivationError('migration_restore_conflict');
  const version=Number((await client.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM config_versions')).rows[0].version);
  const progress=searchMigrationPlanProgressSchema.parse({...state,phase:'restoring',rollback_version:version,restore_deadline_ms:Date.now()+30000,switch_error:'target_activation_failed'});
  await client.query('UPDATE config_documents SET config=$2,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(original.data)]);
  await client.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[job.id,JSON.stringify(progress)]);
  await options.store.addAuditLog({actor:job.actor,action:'search-migration-plan-restore',service:'search-service',versionBefore:state.published_version,versionAfter:version,
    detail:{job_id:job.id,generation:job.generation,source_config_version:state.source_config_version}},client);
}
export class SearchMigrationActivationError extends Error {
  constructor(readonly code: string) { super(code); }
}
/** One job may prepare a bounded range. A global model switch must not hide
 * other retained source/time ranges. Larger histories are prepared in multiple
 * jobs; until their aggregate proof is implemented, fail closed with a clear
 * continuation reason instead of pretending a partial migration is complete. */
export function assertSingleMigrationScope(job: SearchJob, context: SearchModelMigrationContext) {
  const payload = searchModelMigrationPayloadSchema.parse(job.payload), extent = context.extent;
  if (context.channels.some(id => !payload.scope.channel_ids.includes(id)) ||
      (extent.from_ms !== null && (Date.parse(payload.scope.from) > extent.from_ms ||
        extent.to_ms === null || Date.parse(payload.scope.to) < extent.to_ms ||
        BigInt(payload.source_high_watermark) < BigInt(extent.high_watermark))))
    throw new SearchMigrationActivationError('migration_scope_incomplete');
}

/** Called only by the existing PgConfigStore.publish.prepare, while that store
 * holds config_publish's advisory lock. It changes the desired document and
 * creates an audit entry; applied remains exclusively the service's ACK. */
export async function prepareSearchModelMigrationActivation(client: PoolClient, options: {
  store: Pick<PgConfigStore, 'addAuditLog'>; artifacts: SearchModelMigrationArtifacts;
  job: SearchJob; actor: string; context: SearchModelMigrationContext; frozen: SearchMigrationArtifacts;
}) {
  const { store, artifacts, actor, context } = options;
  const job = (await client.query(`SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND expires_at>clock_timestamp() FOR UPDATE`,
    [options.job.id, actor])).rows[0] as SearchJob | undefined;
  if (!job || job.generation !== options.job.generation) throw new SearchMigrationActivationError('migration_job_stale');
  const payload = searchModelMigrationPayloadSchema.parse(job.payload), progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
  assertSingleMigrationScope(job, context);
  assertSearchMigrationActivation({ job_id: job.id, generation: job.generation, state: job.state, payload, progress,
    acceptance: job.migration_acceptance as Parameters<typeof assertSearchMigrationActivation>[0]['acceptance'],
    current: { config_revision: context.revision, storage_generation: context.storage_generation,
      source: { package_id: context.source.package_id, package_sha256: context.source.package_sha256, model_version: context.source.model_version } } });
  const service = (await client.query(`SELECT * FROM config_service_states WHERE service_name='search-service' FOR UPDATE`)).rows[0];
  const ack = (await client.query(`SELECT * FROM search_runtime_state WHERE singleton=true FOR UPDATE`)).rows[0];
  if (!service || service.status !== 'applied' || service.applied_version !== context.desired_version ||
      service.desired_version !== context.desired_version || ack?.status !== 'applied' ||
      ack.desired_version !== context.desired_version || ack.revision !== context.revision)
    throw new SearchMigrationActivationError('migration_source_changed');
  const document = (await client.query(`SELECT d.id,d.config,d.config IS NOT DISTINCT FROM s.config AS matches_applied
    FROM config_documents d JOIN config_versions v ON v.version=$1
    JOIN config_snapshots s ON s.version_id=v.id AND s.service=d.service AND s."group"=d."group" AND s.name=d.name
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings' FOR UPDATE OF d`, [context.desired_version])).rows[0];
  const config = searchSettingsSchema.safeParse(document?.config);
  if (!document?.matches_applied || !config.success || config.data.model.package_id !== payload.source.package_id)
    throw new SearchMigrationActivationError('migration_source_changed');
  // Repeat the actual PG manifest authority under locks in the publication
  // transaction. The already-read Native report is immutable proof, not a new
  // network request while holding PG locks.
  await artifacts.resolve(job, client, options.frozen.report, true);
  const next = searchSettingsSchema.parse({ ...config.data, model: { package_id: payload.target.package_id } });
  await client.query('UPDATE config_documents SET config=$2,updated_at=now() WHERE id=$1', [document.id, JSON.stringify(next)]);
  await client.query(`UPDATE search_jobs SET migration_progress=$2 WHERE id=$1`, [job.id, JSON.stringify({ ...progress, phase: 'activated' })]);
  await store.addAuditLog({ actor, action: 'search-migration-activate', service: 'search-service', group: 'system', configName: 'settings',
    detail: { job_id: job.id, generation: job.generation, payload_fingerprint: searchModelMigrationFingerprint(payload),
      index_manifest_sha256: options.frozen.index_manifest_sha256, target_checkpoint: progress.target_checkpoint } }, client);
}
