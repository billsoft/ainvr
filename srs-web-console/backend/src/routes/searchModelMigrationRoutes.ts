import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConfigApply, ApplyOperation } from '../services/configApply.js';
import type { SearchJobs, SearchJob } from '../store/searchJobs.js';
import type { SearchNativeClient } from '../services/searchNativeClient.js';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanProgressSchema,searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,searchMigrationPlanAcceptanceSchema,searchMigrationObservedExtentSchema,searchMigrationPauseRejectionCodeSchema} from '../services/searchModelMigrationPlan.js';
import type {SearchModelMigrationPlanArtifacts,SearchMigrationPlanArtifacts} from '../services/searchModelMigrationPlanArtifacts.js';
import { searchRangeSchema } from '../services/searchContract.js';
import { searchMigrationModelProfileSchema, searchModelMigrationPayloadSchema, searchModelMigrationProgressSchema,
  searchModelMigrationFingerprint, searchModelMigrationAcceptanceSchema, searchModelMigrationLeaseSchema,
  searchMigrationWriteSourceSchema,assertSearchMigrationActivation, type SearchMigrationModel } from '../services/searchModelMigrationContract.js';
import { SearchMigrationArtifactError, type SearchModelMigrationArtifacts, type SearchMigrationArtifacts } from '../services/searchModelMigrationArtifacts.js';
import { assertSingleMigrationScope, SearchMigrationActivationError, type SearchModelMigrationContext } from '../services/searchModelMigrationActivation.js';

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const params = z.object({ id: uuid }).strict();
const expected = { generation, payload_fingerprint: hash };
const createSchema = z.object({ request_id: uuid, target_package_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  scope: searchRangeSchema, acceptance_criteria_sha256: hash }).strict();
type Jobs = Pick<SearchJobs,'enqueueMigration'|'get'|'listMigrationPlans'|'cancelMigration'|'acceptMigration'|'claimMigration'|'renewMigration'|'checkpointMigration'|'finishMigration'|'failMigration'|'authorizeMigrationWrite'|'authorizeMigrationArtifacts'|'authorizeMigrationReportRead'|'enqueueMigrationPlan'|'claimMigrationPlan'|'renewMigrationPlan'|'prepareMigrationPlanChildren'|'migrationPlanChildren'|'completeMigrationPlan'|'cancelMigrationPlan'|'failMigrationPlan'|'acceptMigrationPlan'|'requestMigrationPlanSwitch'|'requestMigrationPlanPause'|'acknowledgeMigrationPlanPause'|'abortMigrationPlanSwitch'>;
export interface SearchModelMigrationRouteOptions {
  principal: (request: FastifyRequest) => Promise<string | null>;
  internalPrincipal: (request: FastifyRequest) => Promise<boolean>;
  jobs: Jobs;
  context: () => Promise<SearchModelMigrationContext | null>;
  internalContext?:()=>Promise<Omit<SearchModelMigrationContext,'extent'>|null>;
  native: Pick<SearchNativeClient,'verifyMigrationModel'|'migrationWatermark'>;
  artifacts: SearchModelMigrationArtifacts;
  planArtifacts:SearchModelMigrationPlanArtifacts;
  executionAvailable: () => boolean;
  activate: (input: { job: SearchJob; actor: string; context: SearchModelMigrationContext; frozen: SearchMigrationArtifacts }) => ApplyOperation;
  publishPlan?: (input:{job:SearchJob;worker:string;context:Omit<SearchModelMigrationContext,'extent'>;frozen:SearchMigrationPlanArtifacts})=>ApplyOperation;
  restorePlan?: (input:{job:SearchJob;worker:string})=>ApplyOperation;
  apply: Pick<ConfigApply,'busy'>;
}
class RouteError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const modelIdentity = (value: SearchMigrationModel) => ({ package_id: value.package_id, package_sha256: value.package_sha256, model_version: value.model_version });
function summary(job: SearchJob, executionAvailable: boolean) {
  if(searchMigrationPlanPayloadSchema.safeParse(job.payload).success) {
    const payload=searchMigrationPlanPayloadSchema.parse(job.payload),progress=searchMigrationPlanProgressSchema.parse(job.migration_progress);
    return {id:job.id,generation:job.generation,purpose:'reencode_plan',state:job.state,phase:progress.phase,
      payload_fingerprint:searchMigrationPlanFingerprint(payload),source:payload.source,target:payload.target,extent:payload.extent,source_count:payload.source_count,
      expires_at:job.expires_at,acceptance_criteria_sha256:payload.acceptance_criteria_sha256,
      progress:{next_partition:progress.next_partition,total_children:progress.total_children,round:progress.active_round??0,switch_deadline_ms:progress.switch_deadline_ms??null},
      reason:!executionAvailable&&['pending','running'].includes(job.state)?'migration_executor_pending':job.error_code??progress.switch_error??null,accepted_report_sha256:job.migration_acceptance?searchMigrationPlanAcceptanceSchema.parse(job.migration_acceptance).report_sha256:null};
  }
  const payload = searchModelMigrationPayloadSchema.parse(job.payload), progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
  return { id: job.id, generation: job.generation, state: job.state, phase: progress.phase,
    payload_fingerprint: searchModelMigrationFingerprint(payload), source: payload.source, target: payload.target,
    scope: payload.scope, expires_at: job.expires_at, acceptance_criteria_sha256: payload.acceptance_criteria_sha256,
    progress: { scanned: progress.scanned, encoded: progress.encoded, unavailable: progress.unavailable,
      source_completed_through: progress.source_completed_through, target_checkpoint: progress.target_checkpoint },
    reason: !executionAvailable && ['pending','running'].includes(job.state) ? 'migration_executor_pending' : job.error_code ?? null,
    accepted_report_sha256: job.migration_acceptance ? searchModelMigrationAcceptanceSchema.parse(job.migration_acceptance).report_sha256 : null };
}
/** Human management remains in the authenticated console. The separate fixed
 * worker endpoint grants no browser-supplied URL/path/key or unrestricted image
 * export: a lease is only a bounded work identity, not a producer credential. */
export async function searchModelMigrationRoutes(app: FastifyInstance, options: SearchModelMigrationRouteOptions) {
  const actor = async (r: FastifyRequest) => { const who = await options.principal(r); if (!who) throw new RouteError('unauthorized',401); return who; };
  const context = async () => { const value = await options.context(); if (!value) throw new RouteError('migration_not_ready',503); return value; };
  const owned = async (id: string, who: string) => {
    const job = await options.jobs.get(id,who,true);
    if (!job || (!searchModelMigrationPayloadSchema.safeParse(job.payload).success&&!searchMigrationPlanPayloadSchema.safeParse(job.payload).success)) throw new RouteError('migration_missing',404);
    if (job.expires_at.getTime() <= Date.now()) throw new RouteError('migration_expired',410);
    return job;
  };
  const sameContext = (job: SearchJob, current: Omit<SearchModelMigrationContext,'extent'>) => {
    const payload = searchModelMigrationPayloadSchema.parse(job.payload);
    if (payload.config_revision !== current.revision || payload.storage_generation !== current.storage_generation ||
        JSON.stringify(payload.source) !== JSON.stringify(modelIdentity(current.source)) ||
        payload.scope.channel_ids.some(id => !current.channels.includes(id))) throw new RouteError('migration_source_changed');
    return payload;
  };
  const samePlanContext=(job:SearchJob,current:Omit<SearchModelMigrationContext,'extent'>)=>{
    const payload=searchMigrationPlanPayloadSchema.parse(job.payload);
    if(payload.config_revision!==current.revision||payload.storage_generation!==current.storage_generation||
      JSON.stringify(payload.source)!==JSON.stringify(modelIdentity(current.source))||payload.source_count!==current.channels.length||
      payload.source_ids_sha256!==searchMigrationSourceIdsDigest(current.channels))throw new RouteError('migration_source_changed');
    return payload;
  };
  const checked = (job: SearchJob, input: z.infer<typeof expectedSchema>) => {
    if (job.generation !== input.generation || searchModelMigrationFingerprint(searchModelMigrationPayloadSchema.parse(job.payload)) !== input.payload_fingerprint)
      throw new RouteError('migration_job_stale');
  };
  const expectedSchema = z.object(expected).strict();
  const respond = (handler: (r: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('cache-control','no-store');
    try { return await handler(request); }
    catch(error) {
      if (error instanceof z.ZodError) return reply.code(400).send({error:{code:'invalid_migration_request',message:'迁移参数无效，请重新检查'}});
      const code = error instanceof RouteError || error instanceof SearchMigrationActivationError || error instanceof SearchMigrationArtifactError ? error.code : 'migration_unavailable';
      const message = ({ migration_scope_incomplete:'目标尚未覆盖全部留存历史，请继续迁移剩余范围；当前模型保持服务。',
        migration_source_changed:'当前模型、来源或存储已改变，请重新准备迁移。', migration_artifacts_pending:'目标模型的重编码与索引报告尚未齐全，当前模型保持服务。',
        migration_executor_pending:'后台迁移执行器尚未就绪，当前模型保持服务。', unauthorized:'需要管理员登录',
        migration_model_unapproved:'目标模型尚未通过包级验证或不支持正式迁移，请先完成模型验证；不会创建必失败的迁移任务。',
        migration_finalization_pending:'搜索采样排空与最终增量核验尚未完成；当前模型继续服务，暂不能切换。',
        migration_plan_required:'单任务迁移入口已停用，请从配置页创建覆盖全部留存历史的迁移计划。',
        migration_not_ready:'当前搜索配置与历史范围尚未确认，暂不能准备迁移。' } as Record<string,string>)[code] ?? '迁移暂不可用，请检查状态后重试；当前模型不会自动切换。';
      return reply.code(error instanceof RouteError ? error.status : code==='migration_scope_incomplete' || code==='migration_source_changed' ? 409 : 503).send({error:{code,message}});
    }
  };
  app.get('/search/model-migrations',respond(async request=>({items:(await options.jobs.listMigrationPlans(await actor(request),8)).map(job=>summary(job,options.executionAvailable()))})));
  app.get('/search/model-migrations/context',respond(async request=>{
    await actor(request);const current=options.internalContext?await options.internalContext():await options.context();
    return {source:current?modelIdentity(current.source):null,execution_available:options.executionAvailable(),
      reason:!current?'migration_not_ready':!options.executionAvailable()?'migration_executor_pending':null};
  }));
  app.post('/search/model-migrations',{bodyLimit:8192},respond(async request => {
    await actor(request);
    // New migrations use the whole-history parent/partition contract. Preserve
    // legacy identities and cancellation instead of deleting in-flight records.
    throw new RouteError('migration_plan_required',410);
  }));
  app.post('/search/model-migrations/plans',{bodyLimit:2048},respond(async request=>{
    const who=await actor(request),input=z.object({request_id:uuid,target_package_id:createSchema.shape.target_package_id,
      acceptance_criteria_sha256:hash}).strict().parse(request.body),current=await context();
    const target=searchMigrationModelProfileSchema.parse(await options.native.verifyMigrationModel(input.target_package_id));
    if(!target.files_verified)throw new RouteError('migration_model_unverified',503);
    if(!target.production_approval_declared||target.pruned)throw new RouteError('migration_model_unapproved',503);
    const payload=searchMigrationPlanPayloadSchema.parse({schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',source:modelIdentity(current.source),target:modelIdentity(target),
      config_revision:current.revision,storage_generation:current.storage_generation,acceptance_criteria_sha256:input.acceptance_criteria_sha256,
      source_count:current.channels.length,source_ids_sha256:searchMigrationSourceIdsDigest(current.channels),
      extent:{from_ms:current.extent.from_ms,to_ms:current.extent.to_ms,source_high_watermark:current.extent.high_watermark}});
    return summary(await options.jobs.enqueueMigrationPlan(who,input.request_id,payload),options.executionAvailable());
  }));
  app.get('/search/model-migrations/:id',respond(async request=>summary(await owned(params.parse(request.params).id,await actor(request)),options.executionAvailable())));
  app.post('/search/model-migrations/:id/cancel',{bodyLimit:1024},respond(async request=>{
    const who=await actor(request), job=await owned(params.parse(request.params).id,who);
    return {cancelled:searchMigrationPlanPayloadSchema.safeParse(job.payload).success?await options.jobs.cancelMigrationPlan(job.id,who):await options.jobs.cancelMigration(job.id,who)};
  }));
  app.post('/search/model-migrations/:id/accept',{bodyLimit:1024},respond(async request=>{
    const who=await actor(request), input=expectedSchema.extend({report_sha256:hash}).parse(request.body), job=await owned(params.parse(request.params).id,who);
    if(searchMigrationPlanPayloadSchema.safeParse(job.payload).success) {
      const current=await context(),payload=samePlanContext(job,current),progress=searchMigrationPlanProgressSchema.parse(job.migration_progress);
      if(job.generation!==input.generation||searchMigrationPlanFingerprint(payload)!==input.payload_fingerprint)throw new RouteError('migration_job_stale');
      const proof={schema_version:'search-reencode-plan-acceptance-v1',mode:'administrator_report_acceptance',job_id:job.id,base_generation:job.generation,
        payload_fingerprint:input.payload_fingerprint,criteria_sha256:payload.acceptance_criteria_sha256,report_sha256:input.report_sha256,
        base_aggregate_sha256:progress.aggregate_sha256,base_coverage_sha256:progress.coverage_sha256,base_index_manifest_sha256:progress.index_manifest_sha256,
        accepted_by:who,accepted_at:new Date().toISOString()};
      if(job.migration_acceptance) {
        const old=searchMigrationPlanAcceptanceSchema.parse(job.migration_acceptance);if(old.report_sha256!==input.report_sha256)throw new RouteError('migration_report_already_accepted');
        return summary(job,options.executionAvailable());
      }
      if(!await options.jobs.acceptMigrationPlan(job.id,who,proof))throw new RouteError('migration_job_stale');
      return summary(await owned(job.id,who),options.executionAvailable());
    }
    checked(job,input); sameContext(job,await context());
    const artifacts=await options.artifacts.resolve(job), payload=searchModelMigrationPayloadSchema.parse(job.payload), progress=searchModelMigrationProgressSchema.parse(job.migration_progress);
    if(job.migration_acceptance) {
      const previous=searchModelMigrationAcceptanceSchema.parse(job.migration_acceptance);
      if(previous.report_sha256!==input.report_sha256) throw new RouteError('migration_report_already_accepted');
      return summary(job,options.executionAvailable());
    }
    const proof={schema_version:'search-reencode-acceptance-v1',mode:'administrator_report_acceptance',job_id:job.id,generation:job.generation,
      payload_fingerprint:input.payload_fingerprint,criteria_sha256:payload.acceptance_criteria_sha256,report_sha256:input.report_sha256,
      source_completed_through:artifacts.report.source_completed_through,target_checkpoint:artifacts.report.target_checkpoint,
      coverage_sha256:artifacts.report.coverage_sha256,index_manifest_sha256:artifacts.index_manifest_sha256,accepted_by:who,accepted_at:new Date().toISOString()};
    if(progress.phase!=='awaiting_acceptance' && progress.phase!=='ready') throw new RouteError('migration_not_complete');
    if(!await options.jobs.acceptMigration(job.id,who,proof)) throw new RouteError('migration_job_stale');
    return summary(await owned(job.id,who),options.executionAvailable());
  }));
  app.post('/search/model-migrations/:id/activate',{bodyLimit:1024},respond(async request=>{
    const who=await actor(request), input=expectedSchema.parse(request.body), job=await owned(params.parse(request.params).id,who), current=await context();
    if(searchMigrationPlanPayloadSchema.safeParse(job.payload).success) {
      const payload=samePlanContext(job,current);
      if(job.generation!==input.generation||searchMigrationPlanFingerprint(payload)!==input.payload_fingerprint)throw new RouteError('migration_job_stale');
      if(!await options.jobs.requestMigrationPlanSwitch(job.id,who,input.generation,input.payload_fingerprint))throw new RouteError('migration_not_accepted');
      return {scheduled:true,migration:summary(await owned(job.id,who),options.executionAvailable())};
    }
    checked(job,input); sameContext(job,current); assertSingleMigrationScope(job,current);
    if(job.state!=='succeeded' || searchModelMigrationProgressSchema.parse(job.migration_progress).phase!=='ready' || !job.migration_acceptance)
      throw new RouteError('migration_not_accepted');
    assertSearchMigrationActivation({job_id:job.id,generation:job.generation,state:job.state,payload:searchModelMigrationPayloadSchema.parse(job.payload),
      progress:searchModelMigrationProgressSchema.parse(job.migration_progress),acceptance:searchModelMigrationAcceptanceSchema.parse(job.migration_acceptance),
      current:{config_revision:current.revision,storage_generation:current.storage_generation,source:modelIdentity(current.source)}});
    if(options.apply.busy) throw new RouteError('config_apply_busy');
    const payload=searchModelMigrationPayloadSchema.parse(job.payload), target=await options.native.verifyMigrationModel(payload.target.package_id);
    if(!target.files_verified || JSON.stringify(modelIdentity(target))!==JSON.stringify(payload.target)) throw new RouteError('migration_model_changed');
    const frozen=await options.artifacts.resolve(job);
    // Extent reads in two databases cannot prove no source write raced the PG
    // transaction. Only the forthcoming persisted Native ingress/drain barrier
    // may authorize the global switch, including a single small source.
    void frozen;throw new RouteError('migration_finalization_pending');
  }));
  const lease={job_id:uuid,worker:uuid,generation,actor:z.string().min(1).max(64)};
  const workerSchema=z.discriminatedUnion('action',[
    z.object({action:z.literal('claim'),worker:uuid}).strict(),
    z.object({action:z.literal('plan_claim'),worker:uuid}).strict(),
    z.object({...lease,action:z.literal('plan_renew')}).strict(),
    z.object({...lease,action:z.literal('plan_prepare')}).strict(),
    z.object({...lease,action:z.literal('plan_finalize')}).strict(),
    z.object({...lease,action:z.literal('plan_pause')}).strict(),
    z.object({...lease,action:z.literal('plan_publish')}).strict(),
    z.object({...lease,action:z.literal('plan_restore')}).strict(),
    z.object({...lease,action:z.literal('plan_abort'),error_code:z.enum(['finalization_timeout','history_unavailable','storage_unavailable','artifact_invalid','capacity_exceeded'])}).strict(),
    z.object({action:z.literal('acknowledge_pause'),plan_id:uuid,worker:uuid,generation,epoch:uuid,observed_extent:searchMigrationObservedExtentSchema}).strict(),
    z.object({action:z.literal('pause_rejected'),plan_id:uuid,worker:uuid,generation,epoch:uuid,
      error_code:searchMigrationPauseRejectionCodeSchema}).strict(),
    z.object({...lease,action:z.literal('renew')}).strict(),
    z.object({...lease,action:z.literal('checkpoint'),expected:searchModelMigrationProgressSchema,next:searchModelMigrationProgressSchema}).strict(),
    z.object({...lease,action:z.literal('complete'),expected:searchModelMigrationProgressSchema}).strict(),
    z.object({...lease,action:z.literal('fail'),error_code:z.enum(['model_unavailable','history_unavailable','storage_unavailable','capacity_exceeded','source_changed','encoding_failed','artifact_invalid'])}).strict(),
    z.object({...lease,action:z.literal('authorize_write'),payload_fingerprint:hash,source:searchMigrationWriteSourceSchema.optional()}).strict(),
    z.object({...lease,action:z.literal('authorize_artifacts'),payload_fingerprint:hash}).strict(),
    z.object({action:z.literal('authorize_report_read'),job_id:uuid,generation,actor:z.string().min(1).max(64),payload_fingerprint:hash}).strict(),
  ]);
  app.post('/internal/search/model-migrations',{bodyLimit:16384},respond(async request=>{
    if(!await options.internalPrincipal(request)) throw new RouteError('forbidden',403);
    const input=workerSchema.parse(request.body);
    if(input.action==='pause_rejected')return {rejected:await options.jobs.abortMigrationPlanSwitch(input.plan_id,input.worker,input.generation,input.error_code,
      {expectedEpoch:input.epoch,unacknowledgedOnly:true})};
    if(input.action==='plan_restore'){
      if(!options.restorePlan)throw new RouteError('migration_finalization_pending');
      if(options.apply.busy)throw new RouteError('config_apply_busy');
      const parent=await owned(input.job_id,input.actor);
      searchMigrationPlanPayloadSchema.parse(parent.payload);
      if(parent.generation!==input.generation)throw new RouteError('migration_job_stale');
      return {apply:options.restorePlan({job:parent,worker:input.worker})};
    }
    const current=options.internalContext?await options.internalContext():await context();
    if(!current)throw new RouteError('migration_not_ready',503);
    if(input.action==='plan_publish'){
      if(!options.publishPlan)throw new RouteError('migration_finalization_pending');
      if(options.apply.busy)throw new RouteError('config_apply_busy');
      const parent=await owned(input.job_id,input.actor);samePlanContext(parent,current);
      const snapshot=await options.jobs.migrationPlanChildren(parent.id,input.worker,input.generation);
      if(!snapshot)throw new RouteError('migration_job_stale');
      const frozen=await options.planArtifacts.resolve(snapshot.parent,snapshot.children,current.channels);
      return {apply:options.publishPlan({job:snapshot.parent,worker:input.worker,context:current,frozen})};
    }
    if(input.action==='acknowledge_pause')return {acknowledged:await options.jobs.acknowledgeMigrationPlanPause(input.plan_id,input.worker,input.generation,input.epoch,input.observed_extent,current)};
    if(input.action==='plan_claim') {
      const job=await options.jobs.claimMigrationPlan(input.worker);if(!job)return {lease:null};
      try{samePlanContext(job,current);}catch{await options.jobs.failMigrationPlan(job.id,input.worker,job.generation,'source_changed');return {lease:null};}
      return {lease:{job_id:job.id,worker:input.worker,generation:job.generation,expires_at:job.lease_until!.toISOString(),
        payload:searchMigrationPlanPayloadSchema.parse(job.payload),payload_fingerprint:searchMigrationPlanFingerprint(searchMigrationPlanPayloadSchema.parse(job.payload))},
        actor:job.actor,progress:searchMigrationPlanProgressSchema.parse(job.migration_progress)};
    }
    if(input.action==='plan_renew'||input.action==='plan_prepare'||input.action==='plan_finalize'||input.action==='plan_pause'||input.action==='plan_abort') {
      // The discriminated union narrows only exact comparisons; no caller may
      // supply catalog UUIDs or an artifact proof as worker input.
      if(input.action!=='plan_renew'&&input.action!=='plan_prepare'&&input.action!=='plan_finalize'&&input.action!=='plan_pause'&&input.action!=='plan_abort')throw new RouteError('invalid_migration_request',400);
      const parent=await owned(input.job_id,input.actor);samePlanContext(parent,current);
      if(input.action==='plan_pause')return {pause:await options.jobs.requestMigrationPlanPause(parent.id,input.worker,input.generation)};
      if(input.action==='plan_abort')return {aborted:await options.jobs.abortMigrationPlanSwitch(parent.id,input.worker,input.generation,input.error_code)};
      if(input.action==='plan_renew')return {renewed:await options.jobs.renewMigrationPlan(parent.id,input.worker,input.generation)};
      if(input.action==='plan_prepare') {
        const result=await options.jobs.prepareMigrationPlanChildren(parent.id,input.worker,input.generation,current.channels,8);
        return {prepared:result!==null,created_ids:result?.created.map(child=>child.id)??[],progress:result?.progress??null};
      }
      const snapshot=await options.jobs.migrationPlanChildren(parent.id,input.worker,input.generation);if(!snapshot)return {finished:false};
      const frozen=await options.planArtifacts.resolve(snapshot.parent,snapshot.children,current.channels);
      return {finished:await options.jobs.completeMigrationPlan(parent.id,input.worker,input.generation,current.channels,
        frozen.children.map(child=>({id:child.id,generation:child.generation,progress:child.progress})),
        (client,actual,children)=>options.planArtifacts.resolve(actual,children,current.channels,client,frozen,true))};
    }
    if(input.action==='claim') {
      const job=await options.jobs.claimMigration(input.worker);
      if(!job) return {lease:null};
      try{sameContext(job,current);}catch{await options.jobs.failMigration(job.id,input.worker,job.generation,'source_changed');return {lease:null};}
      return {lease:searchModelMigrationLeaseSchema.parse({job_id:job.id,worker:input.worker,generation:job.generation,
        expires_at:job.lease_until!.toISOString(),payload:job.payload,payload_fingerprint:searchModelMigrationFingerprint(searchModelMigrationPayloadSchema.parse(job.payload))}),
        actor:job.actor,progress:searchModelMigrationProgressSchema.parse(job.migration_progress)};
    }
    if(input.action==='authorize_report_read')return {grant:await options.jobs.authorizeMigrationReportRead(input.job_id,input.generation,input.actor,input.payload_fingerprint,current)};
    const job=await owned(input.job_id,input.actor);sameContext(job,current);
    if(input.action==='authorize_write')return {grant:await options.jobs.authorizeMigrationWrite(job.id,input.worker,input.generation,input.actor,
      input.payload_fingerprint,current,input.source)};
    if(input.action==='authorize_artifacts')return {grant:await options.jobs.authorizeMigrationArtifacts(job.id,input.worker,input.generation,input.actor,
      input.payload_fingerprint,current)};
    if(input.action==='renew') return {renewed:await options.jobs.renewMigration(job.id,input.worker,input.generation)};
    if(input.action==='fail') return {finished:await options.jobs.failMigration(job.id,input.worker,input.generation,input.error_code)};
    if(input.action==='checkpoint') return {stored:await options.jobs.checkpointMigration(job.id,input.worker,input.generation,input.expected,input.next)};
    await options.artifacts.resolve(job);
    return {finished:await options.jobs.finishMigration(job.id,input.worker,input.generation,input.expected)};
  }));
}
