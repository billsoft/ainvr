import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {SearchJobs,type SearchJob} from '../store/searchJobs.js';
import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,type SearchMigrationPlanPayload,type SearchMigrationPlanProgress} from '../services/searchModelMigrationPlan.js';
import type {SearchModelMigrationPayload,SearchModelMigrationProgress} from '../services/searchModelMigrationContract.js';
const enabled=process.env.AINVR_SEARCH_TEST_PG==='1',id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`,hash=(s:string)=>s.repeat(64);
const ids=[id(1)],spec:SearchMigrationPlanPayload={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',
 source:{package_id:'source',package_sha256:hash('a'),model_version:`search-v1-${hash('a')}`},target:{package_id:'target',package_sha256:hash('b'),model_version:`search-v1-${hash('b')}`},
 config_revision:hash('c'),storage_generation:hash('d'),acceptance_criteria_sha256:hash('e'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest(ids),extent:{from_ms:0,to_ms:86400000,source_high_watermark:'100'}};
const current={revision:spec.config_revision,source_ids:ids,active_model:spec.source},context={revision:spec.config_revision,storage_generation:spec.storage_generation,source:spec.source,channels:ids};
async function isolated(run:(jobs:SearchJobs,pool:Pool)=>Promise<void>){
 const schema='search_'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'},admin=new Pool(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({...connection,options:`-c search_path=${schema}`,max:8});
 try{for(const name of ['001_initial_schema.sql','017_search.sql','019_search_shard_publication.sql','021_search_refresh_gc.sql','022_search_model_migration.sql','024_search_model_migration_plan.sql'])
 await pool.query(readFileSync(new URL('../store/migrations/'+name,import.meta.url),'utf8'));await run(new SearchJobs(pool),pool);}
 finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
// Synthetic artifact hashes exercise real PG state/lease control. They do not
// claim Native source admission/drain, image encoding or model quality passed.
async function ready(jobs:SearchJobs,pool:Pool){
 const parent=await jobs.enqueueMigrationPlan('admin',randomUUID(),spec),worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;
 const children=(await jobs.prepareMigrationPlanChildren(parent.id,worker,lease.generation,ids))!.created;
 for(const child of children){child.migration_progress={...(child.migration_progress as SearchModelMigrationProgress),phase:'awaiting_acceptance',source_completed_through:'100',target_checkpoint:'200',coverage_sha256:hash('1'),index_manifest_sha256:hash('2')};
 await pool.query("UPDATE search_jobs SET state='succeeded',migration_progress=$2 WHERE id=$1",[child.id,JSON.stringify(child.migration_progress)]);}
 expect(await jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids,children.map(c=>({id:c.id,generation:c.generation,progress:c.migration_progress})),async()=>({aggregate_sha256:hash('3'),coverage_sha256:hash('4'),index_manifest_sha256:hash('5')}))).toBe(true);
 const done=(await jobs.get(parent.id,'admin'))!,fp=searchMigrationPlanFingerprint(spec),proof={schema_version:'search-reencode-plan-acceptance-v1',mode:'administrator_report_acceptance',job_id:done.id,base_generation:done.generation,
 payload_fingerprint:fp,criteria_sha256:spec.acceptance_criteria_sha256,report_sha256:hash('6'),base_aggregate_sha256:hash('3'),base_coverage_sha256:hash('4'),base_index_manifest_sha256:hash('5'),accepted_by:'admin',accepted_at:new Date().toISOString()};
 return {parent:done,worker,proof,fp};
}
async function switching(jobs:SearchJobs,pool:Pool){const base=await ready(jobs,pool);expect(await jobs.acceptMigrationPlan(base.parent.id,'admin',base.proof)).toBe(true);
 expect(await jobs.requestMigrationPlanSwitch(base.parent.id,'admin',base.parent.generation,base.fp)).toBe(true);return {...base,lease:(await jobs.claimMigrationPlan(base.worker))!};}
it.skipIf(!enabled)('human report acceptance never pauses sampling; only explicit switching asks Native to drain',async()=>isolated(async(jobs,pool)=>{
 const b=await ready(jobs,pool);expect((await jobs.ingestionGate(current)).gate).toBeNull();
 expect(await jobs.requestMigrationPlanSwitch(b.parent.id,'admin',b.parent.generation,b.fp)).toBe(false);
 expect(await jobs.acceptMigrationPlan(b.parent.id,'other',{...b.proof,accepted_by:'other'})).toBe(false);
 expect(await jobs.acceptMigrationPlan(b.parent.id,'admin',{...b.proof,base_aggregate_sha256:hash('9')})).toBe(false);
 expect(await jobs.acceptMigrationPlan(b.parent.id,'admin',b.proof)).toBe(true);expect((await jobs.ingestionGate(current)).gate).toBeNull();
 expect(await jobs.requestMigrationPlanSwitch(b.parent.id,'admin',b.parent.generation,b.fp)).toBe(true);
 const lease=(await jobs.claimMigrationPlan(b.worker))!;expect((await jobs.ingestionGate(current)).gate).toBeNull();
 const pause=(await jobs.requestMigrationPlanPause(lease.id,b.worker,lease.generation))!;expect(pause.expires_ms).toBeLessThanOrEqual(Date.now()+120000);
 const gate=(await jobs.ingestionGate(current)).gate!;expect(gate.epoch).toBe(pause.epoch);expect(gate.source).toEqual(spec.source);
 expect((await jobs.ingestionGate({...current,active_model:spec.target})).gate).toBeNull();
}));
it.skipIf(!enabled)('only the exact current epoch can freeze actual H and create delta children with stable attempt identity',async()=>isolated(async(jobs,pool)=>{
 const b=await switching(jobs,pool),pause=(await jobs.requestMigrationPlanPause(b.lease.id,b.worker,b.lease.generation))!,observed={from_ms:10,to_ms:86400001,high_watermark:'110'};
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,id(90),observed,context)).toBe(false);
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,observed,{...context,channels:[id(9)]})).toBe(false);
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,observed,context)).toBe(true);
 const state=(await jobs.get(b.lease.id,'admin'))!.migration_progress as SearchMigrationPlanProgress;
 expect(state.phase).toBe('catching_up');expect(state.final_plan!.extent.source_high_watermark).toBe('110');expect(state.final_plan!.extent.from_ms).toBe(observed.from_ms);
 const children=(await jobs.prepareMigrationPlanChildren(b.lease.id,b.worker,b.lease.generation,ids))!.created;
 expect(children).toHaveLength(1);const p=children[0]!.payload as SearchModelMigrationPayload;
 expect(p).toMatchObject({plan_round:1,plan_switch_generation:b.lease.generation,source_after_watermark:'100',source_high_watermark:'110'});
 const child=(await jobs.claimMigration(b.worker))!;expect(child.id).toBe(children[0]!.id);
 const before=child.migration_progress as SearchModelMigrationProgress;
 expect(await jobs.checkpointMigration(child.id,b.worker,child.generation,before,{...before,cursor:{ordinal:'101',sample_id:id(20)},scanned:1,encoded:1})).toBe(true);
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{from_ms:null,to_ms:null,high_watermark:'0'},context)).toBe(true);
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{...observed,high_watermark:'111'},context)).toBe(false);
}));
it.skipIf(!enabled)('120-second expiry restores old sampling and retry retires obsolete round1 control jobs without deleting target outcomes',async()=>isolated(async(jobs,pool)=>{
 const b=await switching(jobs,pool),pause=(await jobs.requestMigrationPlanPause(b.lease.id,b.worker,b.lease.generation))!;
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{from_ms:0,to_ms:86400000,high_watermark:'110'},context)).toBe(true);
 const old=(await jobs.prepareMigrationPlanChildren(b.lease.id,b.worker,b.lease.generation,ids))!.created[0]!;
 await pool.query("UPDATE search_jobs SET migration_progress=jsonb_set(migration_progress,'{switch_deadline_ms}',to_jsonb(($2::bigint))) WHERE id=$1",[b.lease.id,Date.now()-1]);
 expect((await jobs.ingestionGate(current)).gate).toBeNull();expect(await jobs.abortMigrationPlanSwitch(b.lease.id,b.worker,b.lease.generation)).toBe(true);
 const restored=(await jobs.get(b.lease.id,'admin'))!;expect(restored.migration_progress).toMatchObject({phase:'ready',switch_error:'finalization_timeout'});expect(restored.migration_acceptance).toEqual(b.proof);
 expect((await jobs.get(old.id,'admin'))!.state).toBe('cancelled');
 expect(await jobs.requestMigrationPlanSwitch(restored.id,'admin',restored.generation,b.fp)).toBe(true);const retry=(await jobs.claimMigrationPlan(b.worker))!;
 const next=(await jobs.requestMigrationPlanPause(retry.id,b.worker,retry.generation))!;expect(next.epoch).not.toBe(pause.epoch);
 await jobs.acknowledgeMigrationPlanPause(retry.id,b.worker,retry.generation,next.epoch,{from_ms:0,to_ms:86400000,high_watermark:'120'},context);
 const fresh=(await jobs.prepareMigrationPlanChildren(retry.id,b.worker,retry.generation,ids))!.created[0]!;
 expect(fresh.id).not.toBe(old.id);expect((fresh.payload as SearchModelMigrationPayload).plan_switch_generation).not.toBe((old.payload as SearchModelMigrationPayload).plan_switch_generation);
 expect((await pool.query('SELECT count(*)::int AS n FROM config_versions')).rows[0].n).toBe(0);
}));
it.skipIf(!enabled)('lease recovery cannot reuse a drained epoch or extend the original finalization deadline',async()=>isolated(async(jobs,pool)=>{
 const b=await switching(jobs,pool),pause=(await jobs.requestMigrationPlanPause(b.lease.id,b.worker,b.lease.generation))!;
 await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{from_ms:0,to_ms:86400000,high_watermark:'110'},context);
 const old=(await jobs.prepareMigrationPlanChildren(b.lease.id,b.worker,b.lease.generation,ids))!.created[0]!;
 const deadline=((await jobs.get(b.lease.id,'admin'))!.migration_progress as SearchMigrationPlanProgress).switch_deadline_ms;
 await pool.query("UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[b.lease.id]);
 const worker=randomUUID(),retry=(await jobs.claimMigrationPlan(worker))!,state=retry.migration_progress as SearchMigrationPlanProgress;
 expect(state).toMatchObject({phase:'quiescing',pause:null,final_plan:null,switch_deadline_ms:deadline});expect((await jobs.get(old.id,'admin'))!.state).toBe('cancelled');
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{from_ms:0,to_ms:86400000,high_watermark:'999'},context)).toBe(false);
 const fresh=(await jobs.requestMigrationPlanPause(retry.id,worker,retry.generation))!;expect(fresh.epoch).not.toBe(pause.epoch);
 expect(((await jobs.get(retry.id,'admin'))!.migration_progress as SearchMigrationPlanProgress).switch_deadline_ms).toBe(deadline);
}));
it.skipIf(!enabled)('Native rejection records the exact failure without inventing H or declaring sampling resumed',async()=>isolated(async(jobs,pool)=>{
 const b=await switching(jobs,pool),pause=(await jobs.requestMigrationPlanPause(b.lease.id,b.worker,b.lease.generation))!;
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,b.worker,b.lease.generation,'legacy_bootstrap_required',{expectedEpoch:id(91),unacknowledgedOnly:true})).toBe(false);
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,id(92),b.lease.generation,'source_writer_uncertain',{expectedEpoch:pause.epoch,unacknowledgedOnly:true})).toBe(false);
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,b.worker,b.lease.generation,'source_writer_previous_unclean',{expectedEpoch:pause.epoch,unacknowledgedOnly:true})).toBe(true);
 const actual=(await jobs.get(b.lease.id,'admin'))!,state=actual.migration_progress as SearchMigrationPlanProgress;
 expect(actual.state).toBe('succeeded');expect(actual.generation).toBeGreaterThan(b.lease.generation);
 expect(state).toMatchObject({phase:'ready',switch_error:'source_writer_previous_unclean',pause:{epoch:pause.epoch,drained_at_ms:null,observed_extent:null},final_plan:null});
 expect((await jobs.ingestionGate(current)).gate).toBeNull();
 const audits=(await pool.query(`SELECT count(*)::int n FROM config_audit_logs WHERE action='search-migration-switch-abort'`)).rows[0].n;
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,b.worker,b.lease.generation,'source_writer_previous_unclean',{expectedEpoch:pause.epoch,unacknowledgedOnly:true})).toBe(true);
 expect((await jobs.get(b.lease.id,'admin'))!.generation).toBe(actual.generation);
 expect((await pool.query(`SELECT count(*)::int n FROM config_audit_logs WHERE action='search-migration-switch-abort'`)).rows[0].n).toBe(audits);
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,id(93),b.lease.generation,'source_writer_previous_unclean',{expectedEpoch:pause.epoch,unacknowledgedOnly:true})).toBe(false);
 // PG only withdrew the switch. Whether Native's unknown-writer latch can
 // reopen is deliberately not inferred from a missing operational gate.
 expect((await pool.query('SELECT count(*)::int n FROM config_versions')).rows[0].n).toBe(0);
}));
it.skipIf(!enabled)('a delayed negative ACK cannot overwrite a successful exact-epoch drain proof',async()=>isolated(async(jobs,pool)=>{
 const b=await switching(jobs,pool),pause=(await jobs.requestMigrationPlanPause(b.lease.id,b.worker,b.lease.generation))!;
 expect(await jobs.acknowledgeMigrationPlanPause(b.lease.id,b.worker,b.lease.generation,pause.epoch,{from_ms:0,to_ms:86400000,high_watermark:'110'},context)).toBe(true);
 expect(await jobs.abortMigrationPlanSwitch(b.lease.id,b.worker,b.lease.generation,'source_drain_timeout',{expectedEpoch:pause.epoch,unacknowledgedOnly:true})).toBe(false);
 expect((await jobs.get(b.lease.id,'admin'))!.migration_progress).toMatchObject({phase:'catching_up',final_plan:{extent:{source_high_watermark:'110'}},pause:{epoch:pause.epoch}});
}));
