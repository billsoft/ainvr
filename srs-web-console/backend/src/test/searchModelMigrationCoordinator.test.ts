import {setTimeout as delay} from 'node:timers/promises';
import {expect,it,vi} from 'vitest';
import {SearchModelMigrationCoordinator} from '../services/searchModelMigrationCoordinator.js';
import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest} from '../services/searchModelMigrationPlan.js';
const h=(s:string)=>s.repeat(64),id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
function fixture(){
 const source={package_id:'source',package_sha256:h('a'),model_version:`search-v1-${h('a')}`},target={package_id:'target',package_sha256:h('b'),model_version:`search-v1-${h('b')}`};
 const spec={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',source,target,config_revision:h('c'),storage_generation:h('d'),acceptance_criteria_sha256:h('e'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest([id(1)]),extent:{from_ms:0,to_ms:86400000,source_high_watermark:'100'}} as const;
 const progress:any={schema_version:'search-reencode-plan-progress-v1',payload_fingerprint:searchMigrationPlanFingerprint(spec),phase:'preparing',next_partition:0,total_children:1,aggregate_sha256:null,coverage_sha256:null,index_manifest_sha256:null};
 const parent:any={id:id(2),actor:'human',kind:'rebuild',payload:spec,state:'running',generation:1,attempts:1,lease_owner:null,lease_until:new Date(Date.now()+30000),expires_at:new Date(Date.now()+86400000),migration_progress:progress};
 let childOffered=false;const row:any={...parent,id:id(3),state:'pending',payload:{plan_id:parent.id},migration_progress:{}};
 const context=vi.fn(async()=>({revision:spec.config_revision,storage_generation:spec.storage_generation,desired_version:1,source,channels:[id(1)]}));
 const jobs={get:vi.fn(async(who:string)=>who===parent.id?parent:row),claimMigrationPlan:vi.fn(async(worker:string,_ms?:number,recovery=false)=>{if(recovery&&!['activated','restoring','restore_failed'].includes(progress.phase))return null;parent.lease_owner=worker;return parent;}),renewMigrationPlan:vi.fn(async()=>true),
 prepareMigrationPlanChildren:vi.fn(async()=>{progress.next_partition=1;return {created:childOffered?[]:[row],progress};}),
 claimMigration:vi.fn(async()=>{if(childOffered)return null;childOffered=true;row.state='running';return row;}),
 migrationPlanChildren:vi.fn(async()=>({parent,children:[row]})),completeMigrationPlan:vi.fn(async()=>{parent.state='succeeded';Object.assign(progress,{phase:'awaiting_acceptance',aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3')});return true;}),
 requestMigrationPlanPause:vi.fn(async()=>({epoch:id(9),expires_ms:Date.now()+30000})),abortMigrationPlanSwitch:vi.fn(async()=>{parent.state='succeeded';progress.phase='ready';return true;}),failMigrationPlan:vi.fn(async()=>{parent.state='failed';return true;}),markMigrationPlanRestoreFailed:vi.fn(async()=>{progress.phase='restore_failed';return true;})};
 const child={runClaimed:vi.fn(async()=>{row.state='succeeded';return 'finished' as const;})};
 const artifacts={resolve:vi.fn(async()=>({parent_id:parent.id,parent_generation:parent.generation,payload_fingerprint:progress.payload_fingerprint,children:[{id:row.id,generation:row.generation,progress:row.migration_progress}],aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3')}))};
 const options={jobs:jobs as any,child:child as any,artifacts:artifacts as any,context,retryMs:10,heartbeatMs:100};
 return {parent,progress,row,context,jobs,child,artifacts,options,coordinator:new SearchModelMigrationCoordinator(options)};
}
it('uses the same PG parent worker and exact planId child claim rather than a second queue',async()=>{
 const f=fixture();expect(await f.coordinator.step()).toBe('waiting_acceptance');
 const worker=f.jobs.claimMigrationPlan.mock.calls[0]![0];expect(f.jobs.claimMigration).toHaveBeenCalledWith(worker,30000,f.parent.id);
 expect(f.child.runClaimed).toHaveBeenCalledWith(f.row,worker,expect.any(AbortSignal));expect(f.jobs.completeMigrationPlan).toHaveBeenCalledOnce();
 expect(f.jobs.requestMigrationPlanPause).not.toHaveBeenCalled();
});
it('a published target timeout invokes real restore on an independent bounded signal, never flag-only abort',async()=>{
 const f=fixture();Object.assign(f.progress,{phase:'activated',published_version:2,source_config_version:1,switch_deadline_ms:Date.now()-1,next_partition:1,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3')});
 const restore=vi.fn(async(_parent:any,signal:AbortSignal)=>{expect(signal.aborted).toBe(false);f.progress.phase='restoring';});
 const coordinator=new SearchModelMigrationCoordinator({...f.options,restore});
 expect(await coordinator.step()).toBe('finalization_pending');expect(restore).toHaveBeenCalledOnce();expect(f.jobs.abortMigrationPlanSwitch).not.toHaveBeenCalled();
});
it('restarts can restore an already-published task even when target runtime is unavailable',async()=>{
 const f=fixture();Object.assign(f.progress,{phase:'activated',published_version:2,source_config_version:1,switch_deadline_ms:Date.now()-1,next_partition:1,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3')});f.context.mockResolvedValue(null as never);
 const restore=vi.fn(async()=>{throw new Error('fixture source missing');});
 await new SearchModelMigrationCoordinator({...f.options,restore}).step();
 expect(f.jobs.claimMigrationPlan).toHaveBeenCalledWith(expect.any(String),30000,true);expect(restore).toHaveBeenCalledOnce();
 expect(f.jobs.markMigrationPlanRestoreFailed).toHaveBeenCalledOnce();expect(f.progress.phase).toBe('restore_failed');
});
it('does not claim work before source authority is available and rejects context changes after claiming',async()=>{
 const f=fixture();f.context.mockResolvedValue(null as never);expect(await f.coordinator.step()).toBe('idle');expect(f.jobs.claimMigrationPlan).toHaveBeenCalledWith(expect.any(String),30000,true);
 const g=fixture();g.context.mockResolvedValueOnce(await fixture().context()).mockResolvedValue({...await fixture().context(),revision:h('f')});
 expect(await g.coordinator.step()).toBe('failed');expect(g.jobs.failMigrationPlan).toHaveBeenCalledWith(g.parent.id,expect.any(String),1,'source_changed');expect(g.child.runClaimed).not.toHaveBeenCalled();
});
it('keeps only one child call active and renews the actual parent while the child works',async()=>{
 const f=fixture();let release!:()=>void;
 f.child.runClaimed.mockImplementation(async()=>{await new Promise<void>(resolve=>{release=resolve;});f.row.state='succeeded';return 'finished';});
 const task=f.coordinator.step();await delay(130);expect(await f.coordinator.step()).toBe('busy');expect(f.jobs.renewMigrationPlan).toHaveBeenCalled();release();expect(await task).toBe('waiting_acceptance');
 const calls=f.jobs.renewMigrationPlan.mock.calls.length;await delay(120);expect(f.jobs.renewMigrationPlan).toHaveBeenCalledTimes(calls);
});
it('cancellation cannot produce a parent completion or configuration publication',async()=>{
 const f=fixture(),abort=new AbortController();
 f.child.runClaimed.mockImplementation(async(_row:any,_worker:any,signal:any)=>{await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return 'stale' as never;});
 const task=f.coordinator.step(abort.signal);await delay(15);abort.abort();expect(await task).toBe('stale');expect(f.jobs.completeMigrationPlan).not.toHaveBeenCalled();
});
it('a hard finalization deadline interrupts the in-flight child and restores only the old sampling state',async()=>{
 const f=fixture();Object.assign(f.progress,{phase:'catching_up',active_round:1,final_plan:f.parent.payload,pause:{epoch:id(9),requested_at_ms:Date.now()-1,drained_at_ms:Date.now(),observed_extent:{from_ms:0,to_ms:86400000,high_watermark:'100'}},switch_deadline_ms:Date.now()+40});
 f.child.runClaimed.mockImplementation(async(_row:any,_worker:any,signal:any)=>{await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return 'stale' as never;});
 expect(await f.coordinator.step()).toBe('finalization_pending');expect(f.jobs.abortMigrationPlanSwitch).toHaveBeenCalledWith(f.parent.id,expect.any(String),1,'finalization_timeout');expect(f.jobs.completeMigrationPlan).not.toHaveBeenCalled();
});
it('without a real publication port a ready final report never becomes a successful model switch',async()=>{
 const f=fixture();Object.assign(f.progress,{phase:'publishing',next_partition:1,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3'),switch_deadline_ms:Date.now()+10000});
 expect(await f.coordinator.step()).toBe('finalization_pending');expect(f.jobs.completeMigrationPlan).not.toHaveBeenCalled();expect(f.parent.state).toBe('running');
});
it('waits for Native epoch acknowledgement before claiming any delta child',async()=>{
 const f=fixture(),abort=new AbortController();Object.assign(f.progress,{phase:'quiescing',next_partition:1,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3'),switch_deadline_ms:Date.now()+1000});
 const task=f.coordinator.step(abort.signal);await delay(25);expect(f.jobs.requestMigrationPlanPause).toHaveBeenCalled();expect(f.jobs.claimMigration).not.toHaveBeenCalled();abort.abort();expect(await task).toBe('stale');
});

it('a transport exception without a PG terminal mutation remains retry_pending, not authoritative failed',async()=>{
 const f=fixture();f.jobs.get.mockRejectedValueOnce(new Error('private_pg_address'));expect(await f.coordinator.step()).toBe('retry_pending');
 expect(f.jobs.failMigrationPlan).not.toHaveBeenCalled();expect(f.parent.state).toBe('running');
});
