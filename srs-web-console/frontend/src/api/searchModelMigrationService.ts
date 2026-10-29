import {request} from './httpClient'
export interface SearchMigrationModel {package_id:string;package_sha256:string;model_version:string}
export interface SearchMigrationContext {source:SearchMigrationModel|null;execution_available:boolean;reason:'migration_not_ready'|'migration_executor_pending'|null}
export interface SearchMigrationPlan {
 id:string;generation:number;purpose:'reencode_plan';state:'pending'|'running'|'succeeded'|'failed'|'cancelled'
 phase:'preparing'|'encoding'|'awaiting_acceptance'|'ready'|'quiescing'|'catching_up'|'publishing'|'activated'|'restoring'|'restore_failed'|'restored'
 payload_fingerprint:string;source:SearchMigrationModel;target:SearchMigrationModel
 extent:{from_ms:number|null;to_ms:number|null;source_high_watermark:string};source_count:number;expires_at:string
 acceptance_criteria_sha256:string;progress:{next_partition:number;total_children:number;round:0|1;switch_deadline_ms:number|null}
 reason:string|null;accepted_report_sha256:string|null
}
const prefix='/search/model-migrations',bounded=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)
const owned=(id:string)=>`${prefix}/${encodeURIComponent(id)}`
export const searchModelMigrationService={
 context:(signal?:AbortSignal)=>request<SearchMigrationContext>(`${prefix}/context`,{signal:bounded(signal)}),
 list:(signal?:AbortSignal)=>request<{items:SearchMigrationPlan[]}>(prefix,{signal:bounded(signal)}),
 create:(input:{request_id:string;target_package_id:string;acceptance_criteria_sha256:string})=>request<SearchMigrationPlan>(`${prefix}/plans`,{method:'POST',body:JSON.stringify(input),signal:bounded()}),
 accept:(plan:SearchMigrationPlan,report_sha256:string)=>request<SearchMigrationPlan>(`${owned(plan.id)}/accept`,{method:'POST',body:JSON.stringify({generation:plan.generation,payload_fingerprint:plan.payload_fingerprint,report_sha256}),signal:bounded()}),
 activate:(plan:SearchMigrationPlan)=>request<{scheduled:boolean}>(`${owned(plan.id)}/activate`,{method:'POST',body:JSON.stringify({generation:plan.generation,payload_fingerprint:plan.payload_fingerprint}),signal:bounded()}),
 cancel:(id:string)=>request<{cancelled:boolean}>(`${owned(id)}/cancel`,{method:'POST',signal:bounded()}),
}
