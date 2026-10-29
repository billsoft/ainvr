import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {SearchJobs,type SearchJob} from '../store/searchJobs.js';
import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,type SearchMigrationPlanPayload,type SearchMigrationPlanProgress} from '../services/searchModelMigrationPlan.js';
import {searchModelMigrationFingerprint,type SearchModelMigrationPayload,type SearchModelMigrationProgress} from '../services/searchModelMigrationContract.js';
const enabled=process.env.AINVR_SEARCH_TEST_PG==='1',id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`,hash=(s:string)=>s.repeat(64);
const ids=Array.from({length:1024},(_,n)=>id(n+1));
const spec:SearchMigrationPlanPayload={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',
 source:{package_id:'siglip2-base-full-int8',package_sha256:hash('a'),model_version:`search-v1-${hash('a')}`},
 target:{package_id:'siglip-so400m-i18n-full-int8',package_sha256:hash('b'),model_version:`search-v1-${hash('b')}`},
 config_revision:hash('c'),storage_generation:hash('d'),acceptance_criteria_sha256:hash('e'),source_count:1024,source_ids_sha256:searchMigrationSourceIdsDigest(ids),
 extent:{from_ms:Date.parse('2025-01-01T00:00:00Z'),to_ms:Date.parse('2026-01-01T00:00:00Z'),source_high_watermark:'9007199254740993'}};
async function isolated(run:(jobs:SearchJobs,pool:Pool)=>Promise<void>) {
 const schema='search_'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
 const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({...connection,options:`-c search_path=${schema}`,max:8});
 try {for(const name of ['001_initial_schema.sql','017_search.sql','019_search_shard_publication.sql','021_search_refresh_gc.sql','022_search_model_migration.sql','024_search_model_migration_plan.sql'])
 await pool.query(readFileSync(new URL('../store/migrations/'+name,import.meta.url),'utf8'));await run(new SearchJobs(pool),pool);}
 finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const create=(jobs:SearchJobs,actor='admin',key=randomUUID())=>jobs.enqueueMigrationPlan(actor,key,spec);
it.skipIf(!enabled)('024 is repeatable, preserves old kinds and bounds parent metadata without new tables',async()=>isolated(async(jobs,pool)=>{
 const old=await jobs.enqueue('old',randomUUID(),'rebuild',{old:true});
 const tables=(await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename')).rows;
 await pool.query(readFileSync(new URL('../store/migrations/024_search_model_migration_plan.sql',import.meta.url),'utf8'));
 expect((await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename')).rows).toEqual(tables);
 expect((await jobs.get(old.id,'old'))!.payload).toEqual({old:true});
 const plan=await create(jobs);expect(plan.actor).toBe('admin');
 expect(plan.expires_at.getTime()-Date.now()).toBeGreaterThan(6.9*86400000);
 expect((plan.migration_progress as SearchMigrationPlanProgress).total_children).toBe(132);
 await expect(pool.query('UPDATE search_jobs SET migration_progress=$2 WHERE id=$1',[plan.id,JSON.stringify({huge:'x'.repeat(8192)})])).rejects.toThrow();
}));
it.skipIf(!enabled)('ordinary task operations cannot claim, renew, finish or cancel parent plans',async()=>isolated(async(jobs)=>{
 const p=await create(jobs);await expect(jobs.enqueue('admin',randomUUID(),'rebuild',spec)).rejects.toThrow('migration_specific_operation_required');
 expect(await jobs.claim(randomUUID(),'rebuild')).toBeNull();expect(await jobs.claimMigration(randomUUID())).toBeNull();
 const worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;expect(lease.id).toBe(p.id);
 expect(await jobs.renew(lease.id,worker,lease.generation)).toBe(false);expect(await jobs.finish(lease.id,worker,lease.generation,{resultRef:'fake:success'})).toBe(false);
 expect(await jobs.cancel(lease.id,'admin')).toBe(false);
}));
it.skipIf(!enabled)('parent claims are globally serialized and preserve human ownership',async()=>isolated(async(jobs)=>{
 await create(jobs,'one');await create(jobs,'two');
 const leases=await Promise.all(Array.from({length:8},()=>jobs.claimMigrationPlan(randomUUID())));
 expect(leases.filter(Boolean)).toHaveLength(1);expect(['one','two']).toContain(leases.find(Boolean)!.actor);
}));
it.skipIf(!enabled)('incremental preparation creates at most eight children atomically and cannot drift catalog',async()=>isolated(async(jobs,pool)=>{
 const p=await create(jobs),worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;
 const first=(await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,ids))!;
 expect(first.created).toHaveLength(8);expect(first.progress.next_partition).toBe(8);
 expect(first.created.every(child=>child.actor==='admin'&&child.expires_at.getTime()===p.expires_at.getTime())).toBe(true);
 expect((await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,[...ids].reverse()))!.created).toHaveLength(0);
 await expect(jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,[...ids.slice(0,-1),id(2000)])).rejects.toThrow('migration_source_catalog_changed');
 await pool.query("UPDATE search_jobs SET state='succeeded' WHERE id=$1",[first.created[0]!.id]);
 const next=(await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,ids))!;expect(next.created).toHaveLength(1);expect(next.progress.next_partition).toBe(9);
 const snapshot=(await jobs.migrationPlanChildren(p.id,worker,lease.generation))!;expect(snapshot.children).toHaveLength(9);
 expect(snapshot.children.map(c=>(c.payload as SearchModelMigrationPayload).partition_index)).toEqual(Array.from({length:9},(_,n)=>n));
 const payload=first.created[0]!.payload as SearchModelMigrationPayload;
 await expect(jobs.enqueueMigration('admin',randomUUID(),payload)).rejects.toThrow('migration_plan_specific_operation_required');
}));
it.skipIf(!enabled)('parent cancellation fences already-claimed children and late checkpoints',async()=>isolated(async(jobs)=>{
 const p=await create(jobs),worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;
 await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,ids);
 expect(await jobs.claimMigration(randomUUID())).toBeNull();
 const child=(await jobs.claimMigration(worker))!,before=child.migration_progress as SearchModelMigrationProgress;
 expect(await jobs.cancelMigrationPlan(p.id,'other')).toBe(false);expect(await jobs.cancelMigrationPlan(p.id,'admin')).toBe(true);
 const next={...before,cursor:{ordinal:'1',sample_id:id(3000)},scanned:1,encoded:1};
 expect(await jobs.checkpointMigration(child.id,worker,child.generation,before,next)).toBe(false);
 expect(await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,ids)).toBeNull();expect(await jobs.claimMigration(worker)).toBeNull();
}));
it.skipIf(!enabled)('child proof retention follows an unexpired parent and cleanup resumes after parent expiry',async()=>isolated(async(jobs,pool)=>{
 const p=await create(jobs),worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;
 const children=(await jobs.prepareMigrationPlanChildren(p.id,worker,lease.generation,ids))!.created;
 await pool.query("UPDATE search_jobs SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day',state='succeeded' WHERE id=$1",[children[0]!.id]);
 await jobs.enqueue('new',randomUUID(),'verify',{});expect(await jobs.get(children[0]!.id,'admin',true)).not.toBeNull();
 await pool.query("UPDATE search_jobs SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' WHERE id=$1",[p.id]);
 await jobs.enqueue('new',randomUUID(),'verify',{});expect(await jobs.get(children[0]!.id,'admin',true)).toBeNull();
}));
it.skipIf(!enabled)('same-request plan retries are idempotent and changed immutable history is rejected',async()=>isolated(async(jobs)=>{
 const key=randomUUID(),a=await create(jobs,'admin',key),b=await create(jobs,'admin',key);expect(a.id).toBe(b.id);
 expect((a.migration_progress as SearchMigrationPlanProgress).payload_fingerprint).toBe(searchMigrationPlanFingerprint(spec));
 await expect(jobs.enqueueMigrationPlan('admin',key,{...spec,extent:{...spec.extent,source_high_watermark:'9007199254740994'}})).rejects.toThrow('idempotency_conflict');
}));

it.skipIf(!enabled)('completion requires every exact child proof and revalidates artifacts under the real PG transaction',async()=>isolated(async(jobs,pool)=>{
 const small={...spec,source_count:101,source_ids_sha256:searchMigrationSourceIdsDigest(ids.slice(0,101)),extent:{from_ms:0,to_ms:86400000,source_high_watermark:'999'}};
 const parent=await jobs.enqueueMigrationPlan('admin',randomUUID(),small),worker=randomUUID(),lease=(await jobs.claimMigrationPlan(worker))!;
 const children=(await jobs.prepareMigrationPlanChildren(parent.id,worker,lease.generation,ids.slice(0,101)))!.created;
 let validations=0;const validate=async()=>{validations++;return {aggregate_sha256:hash('1'),coverage_sha256:hash('2'),index_manifest_sha256:hash('3')};};
 const refs=()=>children.map(c=>({id:c.id,generation:c.generation,progress:c.migration_progress}));
 expect(await jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids.slice(0,101),refs(),validate)).toBe(false);expect(validations).toBe(0);
 for(const child of children){const p=child.payload as SearchModelMigrationPayload,prior=child.migration_progress as SearchModelMigrationProgress;
 child.migration_progress={...prior,phase:'awaiting_acceptance',source_completed_through:p.source_high_watermark,target_checkpoint:'1000',coverage_sha256:hash('2'),index_manifest_sha256:hash('3')};
 await pool.query("UPDATE search_jobs SET state='succeeded',migration_progress=$2 WHERE id=$1",[child.id,JSON.stringify(child.migration_progress)]);}
 expect(await jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids.slice(0,101),refs().map((r,n)=>n? r:{...r,generation:r.generation+1}),validate)).toBe(false);
 await expect(jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids.slice(0,101),refs(),async()=>{throw new Error('actual_target_artifact_changed');})).rejects.toThrow('actual_target_artifact_changed');
 expect((await jobs.get(parent.id,'admin'))!.state).toBe('running');
 expect(await jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids.slice(0,101),refs(),validate)).toBe(true);expect(validations).toBe(1);
 expect((await jobs.get(parent.id,'admin'))!).toMatchObject({state:'succeeded',migration_progress:{phase:'awaiting_acceptance',aggregate_sha256:hash('1')}});
}));

it.skipIf(!enabled)('source index claim cannot consume a target-space job in the shared queue',async()=>isolated(async(jobs)=>{
 const make=(model:string,pkg:string)=>({shard_id:randomUUID(),channel_id:id(1),model_version:`search-v1-${hash(model)}`,day:'2026-10-01',storage_generation:hash('c'),config_revision:hash('d'),package_id:pkg});
 const target=make('a','target'),source=make('b','source'),targetJob=await jobs.enqueue('internal-search-index',randomUUID(),'index',target),sourceJob=await jobs.enqueue('internal-search-index',randomUUID(),'index',source);
 const context={model_version:source.model_version,package_id:source.package_id,storage_generation:source.storage_generation,config_revision:source.config_revision};
 expect((await jobs.claim(randomUUID(),'index',30000,'internal-search-index',context))!.id).toBe(sourceJob.id);
 expect((await jobs.get(targetJob.id,'internal-search-index'))!.state).toBe('pending');
 expect(await jobs.claim(randomUUID(),'index',30000,'internal-search-index',context)).toBeNull();
}));
