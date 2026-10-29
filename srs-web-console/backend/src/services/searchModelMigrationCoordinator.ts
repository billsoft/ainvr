import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {SearchJob,SearchJobs} from '../store/searchJobs.js';
import type {SearchReencodeRunner} from './searchReencodeRunner.js';
import type {SearchModelMigrationContext} from './searchModelMigrationActivation.js';
import type {SearchModelMigrationPlanArtifacts,SearchMigrationPlanArtifacts} from './searchModelMigrationPlanArtifacts.js';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanProgressSchema,searchMigrationSourceIdsDigest,type SearchMigrationPlanProgress} from './searchModelMigrationPlan.js';

type Jobs=Pick<SearchJobs,'get'|'claimMigrationPlan'|'renewMigrationPlan'|'prepareMigrationPlanChildren'|'claimMigration'|'migrationPlanChildren'|'completeMigrationPlan'|'requestMigrationPlanPause'|'abortMigrationPlanSwitch'|'failMigrationPlan'|'markMigrationPlanRestoreFailed'>;
type Context=Omit<SearchModelMigrationContext,'extent'>;
export type SearchMigrationCoordinatorOutcome='idle'|'busy'|'waiting_acceptance'|'finished'|'stale'|'failed'|'retry_pending'|'finalization_pending';
interface Options {
 jobs:Jobs;child:Pick<SearchReencodeRunner,'runClaimed'>;artifacts:Pick<SearchModelMigrationPlanArtifacts,'resolve'>;
 context:()=>Promise<Context|null>;
 // Must perform the actual existing ConfigApply/PG final proof transaction.
 // Absence is deliberately not a simulated successful global model switch.
 publish?:(parent:SearchJob,proof:SearchMigrationPlanArtifacts,signal:AbortSignal)=>Promise<void>;
 restore?:(parent:SearchJob,signal:AbortSignal)=>Promise<void>;
 retryMs?:number;heartbeatMs?:number;now?:()=>number;
}
/** One leased PG plan coordinates the existing child executor. It stores no
 * separate task queue, image/vector, identity map, scheduler DB or model owner.
 * App lifecycle may call step(); production activation is wired separately only
 * once the real Native ingress barrier/publication callback is available. */
export class SearchModelMigrationCoordinator {
 private running=false;private readonly worker=randomUUID();private readonly now:()=>number;
 private readonly retryMs:number;private readonly heartbeatMs:number;
 constructor(private readonly options:Options){this.now=options.now??Date.now;
 this.retryMs=z.number().int().min(10).max(10000).parse(options.retryMs??1000);
 this.heartbeatMs=z.number().int().min(100).max(10000).parse(options.heartbeatMs??2000);}
 async step(signal?:AbortSignal,recoveryOnly=false):Promise<SearchMigrationCoordinatorOutcome>{
  if(this.running)return 'busy';this.running=true;const abort=new AbortController();
  const cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();
  let deadlineTimer:ReturnType<typeof setTimeout>|undefined,deadlineExpired=false;
  let parent:SearchJob|null=null,timer:ReturnType<typeof setTimeout>|undefined,renewing:Promise<void>|null=null;
  const wait=async()=>{try{await delay(this.retryMs,undefined,{signal:abort.signal});}catch{};};
  const renew=async()=>{if(!parent||abort.signal.aborted)return;
   if(!await this.options.jobs.renewMigrationPlan(parent.id,this.worker,parent.generation,30000))abort.abort();};
  const watch=()=>{timer=setTimeout(()=>{renewing=renew().catch(cancel).finally(()=>{renewing=null;if(!abort.signal.aborted)watch();});},this.heartbeatMs);timer.unref?.();};
  try{
   if(abort.signal.aborted)return 'stale';
   // A failed target may make applied runtime unavailable. Recovery must still
   // reclaim only already-published work; it cannot start new encoding blind.
   const initial=await this.options.context();
   parent=await this.options.jobs.claimMigrationPlan(this.worker,30000,recoveryOnly||!initial);if(!parent)return 'idle';watch();
   let frozen:SearchMigrationPlanArtifacts|undefined;
   for(;;){
    if(abort.signal.aborted)return deadlineExpired?'finalization_pending':'stale';
    const actual=await this.options.jobs.get(parent.id,parent.actor,true);
    if(!actual||actual.generation!==parent.generation||actual.expires_at.getTime()<=this.now()||actual.state==='cancelled')return 'stale';
    parent=actual;const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),state=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
    if(deadlineTimer){clearTimeout(deadlineTimer);deadlineTimer=undefined;}
    if(state.switch_deadline_ms&&['quiescing','catching_up','publishing','activated'].includes(state.phase)){
      deadlineTimer=setTimeout(()=>{deadlineExpired=true;abort.abort();},Math.max(0,state.switch_deadline_ms-this.now()));deadlineTimer.unref?.();
    }
    if(parent.state==='failed')return 'failed';
    if(parent.state==='succeeded')return state.phase==='activated'?'finished':'waiting_acceptance';
    if(state.switch_deadline_ms&&['quiescing','catching_up','publishing','activated'].includes(state.phase)&&state.switch_deadline_ms<=this.now()){
     deadlineExpired=true;abort.abort();
     if(state.phase!=='activated')await this.options.jobs.abortMigrationPlanSwitch(parent.id,this.worker,parent.generation,'finalization_timeout');
     return 'finalization_pending';
    }
    if(['restoring','restore_failed'].includes(state.phase)){
      if(state.phase==='restoring'&&state.restore_deadline_ms&&state.restore_deadline_ms<=this.now())
        await this.options.jobs.markMigrationPlanRestoreFailed(parent.id,this.worker,parent.generation);
      if(state.phase==='restore_failed'&&!state.rollback_version)deadlineExpired=true;
      return 'retry_pending';
    }
    if(state.phase==='activated'){await wait();continue;}
    const context=await this.options.context();
    if(!context||context.revision!==spec.config_revision||context.storage_generation!==spec.storage_generation||
      context.source.package_id!==spec.source.package_id||context.source.package_sha256!==spec.source.package_sha256||context.source.model_version!==spec.source.model_version||
      context.channels.length!==spec.source_count||searchMigrationSourceIdsDigest(context.channels)!==spec.source_ids_sha256){
     return await this.options.jobs.failMigrationPlan(parent.id,this.worker,parent.generation,'source_changed')?'failed':'stale';
    }
    if(state.phase==='quiescing'){
     if(!await this.options.jobs.requestMigrationPlanPause(parent.id,this.worker,parent.generation))return 'stale';
     // Native, never this Node coordinator, closes/drains source admission and
     // records the exact epoch's actual history extent in the existing PG row.
     await wait();continue;
    }
    if(state.phase==='publishing'){
     if(!this.options.publish)return 'finalization_pending';
     const snapshot=await this.options.jobs.migrationPlanChildren(parent.id,this.worker,parent.generation);if(!snapshot)return 'stale';
     frozen=await this.options.artifacts.resolve(snapshot.parent,snapshot.children,context.channels);
     await this.options.publish(parent,frozen,abort.signal);await wait();continue;
    }
    if(!['preparing','encoding','catching_up'].includes(state.phase))return 'stale';
    await this.options.jobs.prepareMigrationPlanChildren(parent.id,this.worker,parent.generation,context.channels,8);
    const child=await this.options.jobs.claimMigration(this.worker,30000,parent.id);
    if(child){
     const outcome=await this.options.child.runClaimed(child,this.worker,abort.signal);
     if(outcome==='busy'){await wait();continue;}
     if(outcome==='failed'){
      const latest=await this.options.jobs.get(child.id,child.actor,true),code=latest?.error_code;
      const safe=code&&['source_changed','history_unavailable','storage_unavailable','artifact_invalid','capacity_exceeded','model_unavailable','encoding_failed'].includes(code)?code:'artifact_invalid';
      return await this.options.jobs.failMigrationPlan(parent.id,this.worker,parent.generation,safe)?'failed':'stale';
     }
     if(outcome==='stale'&&abort.signal.aborted)return deadlineExpired?'finalization_pending':'stale';
     continue;
    }
    const snapshot=await this.options.jobs.migrationPlanChildren(parent.id,this.worker,parent.generation);if(!snapshot)return 'stale';
    const progress=searchMigrationPlanProgressSchema.parse(snapshot.parent.migration_progress);
    if(snapshot.children.some(child=>child.state==='failed'||child.state==='cancelled')){
     return await this.options.jobs.failMigrationPlan(parent.id,this.worker,parent.generation,'artifact_invalid')?'failed':'stale';
    }
    if(progress.next_partition===progress.total_children&&snapshot.children.length===progress.total_children&&snapshot.children.every(child=>child.state==='succeeded')){
     frozen=await this.options.artifacts.resolve(snapshot.parent,snapshot.children,context.channels);
     if(!await this.options.jobs.completeMigrationPlan(parent.id,this.worker,parent.generation,context.channels,
       frozen.children.map(child=>({id:child.id,generation:child.generation,progress:child.progress})),
       (client,row,children)=>this.options.artifacts.resolve(row,children,context.channels,client,frozen,true)))return 'stale';
     continue;
    }
    await wait();
   }
  }catch{return deadlineExpired?'finalization_pending':abort.signal.aborted?'stale':'retry_pending';}
  finally{abort.abort();if(timer)clearTimeout(timer);if(deadlineTimer)clearTimeout(deadlineTimer);if(renewing)await renewing;
    if(deadlineExpired&&parent){
      const latest=await this.options.jobs.get(parent.id,parent.actor,true).catch(()=>null);
      if(latest?.generation===parent.generation&&latest.state==='running'&&
        ['activated','restore_failed'].includes(searchMigrationPlanProgressSchema.parse(latest.migration_progress).phase)&&
        !searchMigrationPlanProgressSchema.parse(latest.migration_progress).rollback_version){
        // The switch's expired signal must not cancel its compensating restore.
        // ConfigApply/PG performs exact desired/document CAS before restoring.
        if(this.options.restore&&await this.options.jobs.renewMigrationPlan(parent.id,this.worker,parent.generation,60000).catch(()=>false)){
          try{await this.options.restore(latest,AbortSignal.timeout(30000));}
          catch{await this.options.jobs.markMigrationPlanRestoreFailed(parent.id,this.worker,parent.generation).catch(()=>false);}
        }
      }else await this.options.jobs.abortMigrationPlanSwitch(parent.id,this.worker,parent.generation,'finalization_timeout').catch(()=>false);
    }
    signal?.removeEventListener('abort',cancel);this.running=false;}
 }
}
