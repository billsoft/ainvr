import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SearchApprovedModelTransition} from '../store/searchRuntimeStore.js';
import {searchMigrationModelSchema,searchMigrationOrdinalSchema,searchModelMigrationPayloadSchema,
  type SearchModelMigrationPayload} from './searchModelMigrationContract.js';
import {searchControlRequestId} from './searchControlIdentity.js';
const day=86400000,hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const timestamp=z.number().int().min(0).max(253402300799999);
const sourceIds=z.array(uuid).min(1).max(1024).refine(ids=>new Set(ids).size===ids.length);
const planPayloadBase=z.object({schema_version:z.literal('search-reencode-plan-v1'),purpose:z.literal('reencode_plan'),
  source:searchMigrationModelSchema,target:searchMigrationModelSchema,config_revision:hash,storage_generation:hash,acceptance_criteria_sha256:hash,
  source_ids_sha256:hash,source_count:z.number().int().min(1).max(1024),
  extent:z.object({from_ms:timestamp.nullable(),to_ms:timestamp.nullable(),source_high_watermark:searchMigrationOrdinalSchema}).strict(),
}).strict();
const validatePlan=(value:z.infer<typeof planPayloadBase>,ctx:z.RefinementCtx,maximum:number,final=false)=>{
  const {from_ms:from,to_ms:to,source_high_watermark:through}=value.extent;
  const empty=from===null&&to===null;
  if(value.target.model_version===value.source.model_version||(from===null)!==(to===null)||
    (empty?!final&&through!=='0':from===null||to===null||to<=from||to-from>maximum||through==='0'))
    ctx.addIssue({code:'custom',message:'invalid_migration_plan_extent'});
};
export const searchMigrationPlanPayloadSchema=planPayloadBase.superRefine((value,ctx)=>validatePlan(value,ctx,365*day));
// The internal final fence may add at most its 120-second deadline to an exact
// 365-day initial extent. This does not enlarge the public retention setting.
const finalPlanPayloadSchema=planPayloadBase.superRefine((value,ctx)=>validatePlan(value,ctx,365*day+120000,true));
export type SearchMigrationPlanPayload=z.infer<typeof searchMigrationPlanPayloadSchema>;
export const searchMigrationObservedExtentSchema=z.object({from_ms:timestamp.nullable(),to_ms:timestamp.nullable(),high_watermark:searchMigrationOrdinalSchema}).strict().superRefine((v,c)=>{
  if((v.from_ms===null)!==(v.to_ms===null)||(v.from_ms!==null&&v.to_ms!==null&&v.to_ms<=v.from_ms))c.addIssue({code:'custom',message:'invalid_migration_observed_extent'});
});
export const searchMigrationPauseRejectionCodeSchema=z.enum(['legacy_bootstrap_required','source_writer_uncertain','source_writer_previous_unclean',
  'source_writer_topology_unverified','source_drain_timeout','source_admission_unavailable']);
const pauseSchema=z.object({epoch:uuid,requested_at_ms:timestamp,drained_at_ms:timestamp.nullable(),observed_extent:searchMigrationObservedExtentSchema.nullable(),
  rejection:z.object({worker:uuid,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),error_code:searchMigrationPauseRejectionCodeSchema}).strict().optional()}).strict();
export const searchMigrationPlanAcceptanceSchema=z.object({schema_version:z.literal('search-reencode-plan-acceptance-v1'),mode:z.literal('administrator_report_acceptance'),
  job_id:uuid,base_generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),payload_fingerprint:hash,criteria_sha256:hash,report_sha256:hash,
  base_aggregate_sha256:hash,base_coverage_sha256:hash,base_index_manifest_sha256:hash,accepted_by:z.string().min(1).max(64),accepted_at:z.string().datetime({offset:true})}).strict();
export const searchMigrationPlanProgressSchema=z.object({schema_version:z.literal('search-reencode-plan-progress-v1'),payload_fingerprint:hash,
  phase:z.enum(['preparing','encoding','awaiting_acceptance','ready','quiescing','catching_up','publishing','activated','restoring','restore_failed','restored']),
  published_version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  source_config_version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  rollback_version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  restore_deadline_ms:timestamp.nullable().optional(),
  active_round:z.union([z.literal(0),z.literal(1)]).optional(),
  base_aggregate_sha256:hash.nullable().optional(),base_coverage_sha256:hash.nullable().optional(),base_index_manifest_sha256:hash.nullable().optional(),
  pause:pauseSchema.nullable().optional(),switch_deadline_ms:timestamp.nullable().optional(),switch_error:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().optional(),
  final_plan:finalPlanPayloadSchema.nullable().optional(),
  next_partition:z.number().int().min(0).max(132),total_children:z.number().int().min(0).max(132),
  aggregate_sha256:hash.nullable(),coverage_sha256:hash.nullable(),index_manifest_sha256:hash.nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.next_partition>value.total_children||(['awaiting_acceptance','ready','activated'].includes(value.phase)&&
    (value.next_partition!==value.total_children||!value.aggregate_sha256||!value.coverage_sha256||!value.index_manifest_sha256)))
    ctx.addIssue({code:'custom',message:'migration_plan_incomplete'});
});
export type SearchMigrationPlanProgress=z.infer<typeof searchMigrationPlanProgressSchema>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
export function searchMigrationSourceIdsDigest(ids:readonly string[]) {return digest([...sourceIds.parse(ids)].sort());}
const parts=(model:z.infer<typeof searchMigrationModelSchema>)=>[model.package_id,model.package_sha256,model.model_version];
export function searchMigrationPlanFingerprint(raw:SearchMigrationPlanPayload,final=false) {
  const p=(final?finalPlanPayloadSchema:searchMigrationPlanPayloadSchema).parse(raw);
  return digest(['ainvr-search-reencode-plan-v1',parts(p.source),parts(p.target),p.config_revision,p.storage_generation,p.acceptance_criteria_sha256,
    p.source_ids_sha256,p.source_count,p.extent.from_ms,p.extent.to_ms,p.extent.source_high_watermark]);
}
export function migrationPlanWindows(from:number,to:number,final=false) {
  timestamp.parse(from);timestamp.parse(to);if(to<=from||to-from>365*day+(final?120000:0))throw new Error('migration_plan_capacity');
  const windows:{from:number;to:number}[]=[];
  let cursor=from;
  // Ending each page on UTC midnight prevents a 31-day duration from spanning
  // 32 full UTC shard dates. No local-time/DST arithmetic enters the plan.
  while(cursor<to){const end=Math.min(to,Math.floor(cursor/day)*day+31*day);windows.push({from:cursor,to:end});cursor=end;}
  if(windows.length>12)throw new Error('migration_plan_capacity');return windows;
}
export function migrationPlanChildCount(raw:SearchMigrationPlanPayload,final=false) {
  const plan=(final?finalPlanPayloadSchema:searchMigrationPlanPayloadSchema).parse(raw);
  if(plan.extent.from_ms===null||plan.extent.to_ms===null)return 0;
  return migrationPlanWindows(plan.extent.from_ms,plan.extent.to_ms,final).length*Math.ceil(plan.source_count/100);
}
export function migrationPlanChild(planId:string,raw:SearchMigrationPlanPayload,ids:readonly string[],partition:number,
  round:0|1=0,after='0',switchGeneration=1):SearchModelMigrationPayload {
  uuid.parse(planId);z.union([z.literal(0),z.literal(1)]).parse(round);searchMigrationOrdinalSchema.parse(after);
  const plan=(round===1?finalPlanPayloadSchema:searchMigrationPlanPayloadSchema).parse(raw),ordered=[...sourceIds.parse(ids)].sort();
  if(plan.extent.from_ms===null||plan.extent.to_ms===null)throw new Error('migration_empty_plan_has_no_children');
  if(ordered.length!==plan.source_count||searchMigrationSourceIdsDigest(ordered)!==plan.source_ids_sha256)throw new Error('migration_source_catalog_changed');
  const groups=Math.ceil(ordered.length/100),windows=migrationPlanWindows(plan.extent.from_ms,plan.extent.to_ms,round===1),total=groups*windows.length;
  z.number().int().min(0).max(total-1).parse(partition);const window=windows[Math.floor(partition/groups)]!;
  return searchModelMigrationPayloadSchema.parse({schema_version:'search-reencode-v1',purpose:'reencode',source:plan.source,target:plan.target,
    config_revision:plan.config_revision,storage_generation:plan.storage_generation,acceptance_criteria_sha256:plan.acceptance_criteria_sha256,
    source_high_watermark:plan.extent.source_high_watermark,source_after_watermark:after,batch_size:32,plan_id:planId,plan_round:round,partition_index:partition,
    ...(round===1?{plan_switch_generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(switchGeneration)}:{}),
    scope:{channel_ids:ordered.slice((partition%groups)*100,(partition%groups+1)*100),from:new Date(window.from).toISOString(),to:new Date(window.to).toISOString()}});
}
export function migrationPlanChildRequestId(planId:string,round:0|1,partition:number,switchGeneration=1) {
  uuid.parse(planId);z.union([z.literal(0),z.literal(1)]).parse(round);z.number().int().min(0).max(131).parse(partition);
  return searchControlRequestId('ainvr-search-reencode-child-v1',[planId,round,partition,...(round===1?[z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(switchGeneration)]:[])]);
}

export function migrationPlanRound(raw:SearchMigrationPlanPayload,progress:SearchMigrationPlanProgress) {
  const initial=searchMigrationPlanPayloadSchema.parse(raw),state=searchMigrationPlanProgressSchema.parse(progress),round=state.active_round??0;
  if(round===0)return {spec:initial,round:0 as const,after:'0'};
  const final=finalPlanPayloadSchema.parse(state.final_plan);
  if(!state.pause?.drained_at_ms||!state.pause.observed_extent||final.source_ids_sha256!==initial.source_ids_sha256||final.source_count!==initial.source_count||
    final.config_revision!==initial.config_revision||final.storage_generation!==initial.storage_generation||final.acceptance_criteria_sha256!==initial.acceptance_criteria_sha256||
    JSON.stringify(final.source)!==JSON.stringify(initial.source)||JSON.stringify(final.target)!==JSON.stringify(initial.target)||
    JSON.stringify(final)!==JSON.stringify(migrationPlanFinalSpec(initial,state.pause.observed_extent)))
    throw new Error('migration_finalization_invalid');
  return {spec:final,round:1 as const,after:initial.extent.source_high_watermark};
}
export function migrationPlanFinalSpec(raw:SearchMigrationPlanPayload,observed:unknown) {
  const plan=searchMigrationPlanPayloadSchema.parse(raw),extent=searchMigrationObservedExtentSchema.parse(observed);
  return finalPlanPayloadSchema.parse({...plan,extent:{from_ms:extent.from_ms,
    to_ms:extent.to_ms,source_high_watermark:BigInt(extent.high_watermark)>BigInt(plan.extent.source_high_watermark)?extent.high_watermark:plan.extent.source_high_watermark}});
}
export interface SearchMigrationIngestionGate {paused:true;plan_id:string;epoch:string;generation:number;worker:string;source:SearchMigrationPlanPayload['source'];source_ids_sha256:string;expires_ms:number}

/** Operational admission gate, deliberately outside the definition revision.
 * The Native process must enforce/drain it; a PG flag is not a drain proof. */
export function migrationPlanIngestionGate(job:{id:string;state:string;generation:number;lease_owner:string|null;lease_until:Date|null;expires_at:Date;payload:unknown;migration_progress?:unknown},
  current:{revision:string;source_ids:readonly string[];active_model:SearchMigrationPlanPayload['source']|null;approved_transition?:SearchApprovedModelTransition|null},now=Date.now()):SearchMigrationIngestionGate|null {
  const spec=searchMigrationPlanPayloadSchema.parse(job.payload),progress=searchMigrationPlanProgressSchema.parse(job.migration_progress);
  const approved=current.approved_transition;
  const switching=progress.phase==='activated'&&approved?.job_id===job.id&&approved.generation===job.generation&&
    approved.payload_fingerprint===searchMigrationPlanFingerprint(spec)&&JSON.stringify(approved.source)===JSON.stringify(spec.source)&&JSON.stringify(approved.target)===JSON.stringify(spec.target);
  if(job.state!=='running'||!job.lease_owner||!job.lease_until||!progress.pause||!progress.switch_deadline_ms||
    !['quiescing','catching_up','publishing','activated'].includes(progress.phase)||(current.revision!==spec.config_revision&&!switching)||
    (current.active_model&&JSON.stringify(current.active_model)!==JSON.stringify(spec.source))||
    searchMigrationSourceIdsDigest(current.source_ids)!==spec.source_ids_sha256)return null;
  const expires=Math.min(job.expires_at.getTime(),job.lease_until.getTime(),progress.switch_deadline_ms);
  if(!Number.isSafeInteger(expires)||expires<=now)return null;
  return {paused:true,plan_id:uuid.parse(job.id),epoch:progress.pause.epoch,generation:job.generation,worker:uuid.parse(job.lease_owner),source:spec.source,
    source_ids_sha256:spec.source_ids_sha256,expires_ms:expires};
}
