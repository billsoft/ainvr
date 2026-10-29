import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool,type PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {PgConfigStore} from '../store/pgStore.js';
import {SearchJobs} from '../store/searchJobs.js';
import {SearchRuntimeStore} from '../store/searchRuntimeStore.js';
import {DEFAULT_SEARCH_SETTINGS} from '../store/searchConfigAdapter.js';
import {CONFIG_HISTORY_RETENTION_SQL} from '../store/configRetention.js';
import {prepareSearchModelMigrationPlanActivation,prepareSearchModelMigrationPlanRestore} from '../services/searchModelMigrationActivation.js';
import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest} from '../services/searchModelMigrationPlan.js';
import type {SearchModelMigrationPlanArtifacts,SearchMigrationPlanArtifacts} from '../services/searchModelMigrationPlanArtifacts.js';
const enabled=process.env.AINVR_SEARCH_TEST_PG==='1',h=(s:string)=>s.repeat(64),id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const source={package_id:'source',package_sha256:h('a'),model_version:`search-v1-${h('a')}`},target={package_id:'target',package_sha256:h('b'),model_version:`search-v1-${h('b')}`};
async function isolated(run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,basic=false,old=false){
 const schema='search_publish_'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'},admin=new Pool(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);const store=new PgConfigStore({poolConfig:{...connection,options:`-c search_path=${schema}`,max:8},masterKeyPath:'/nonexistent/unused-search-publish-test'});
 try{const names=basic?['001_initial_schema.sql']:old?['001_initial_schema.sql','017_search.sql']:['001_initial_schema.sql','017_search.sql','018_search_runtime.sql','019_search_shard_publication.sql','021_search_refresh_gc.sql','022_search_model_migration.sql','023_search_active_model_pin.sql','024_search_model_migration_plan.sql'];
 for(const name of names)await store.pool.query(readFileSync(new URL('../store/migrations/'+name,import.meta.url),'utf8'));
 await run(basic||old?{store,pool:store.pool} as Awaited<ReturnType<typeof fixture>>:await fixture(store));
 }finally{await store.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function fixture(store:PgConfigStore){
 const pool=store.pool,jobs=new SearchJobs(pool),runtime=new SearchRuntimeStore(pool),worker=randomUUID(),channels=[id(1)];
 const settings={...structuredClone(DEFAULT_SEARCH_SETTINGS),enabled:true,model:{package_id:'source'},index_storage:{volume_id:'fixture-ssd',relative_path:'ainvr/search-index'},callers:[{name:'console',scope:'console',key:'c'.repeat(48)},{name:'producer',scope:'producer',key:'p'.repeat(48)}]};
 await pool.query(`UPDATE config_documents SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);
 await pool.query(`UPDATE config_snapshots SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);
 await runtime.acknowledge({desired_version:1,revision:h('c'),status:'applied',error_code:null,active_model:source});
 const spec={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',source,target,config_revision:h('c'),storage_generation:h('d'),acceptance_criteria_sha256:h('e'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest(channels),extent:{from_ms:0,to_ms:86400000,source_high_watermark:'100'}} as const;
 const parent=await jobs.enqueueMigrationPlan('human',randomUUID(),spec),job=(await jobs.claimMigrationPlan(worker))!,fp=searchMigrationPlanFingerprint(spec);
 const state={...(job.migration_progress as object),phase:'publishing',active_round:1,next_partition:1,total_children:1,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3'),
 base_aggregate_sha256:h('4'),base_coverage_sha256:h('5'),base_index_manifest_sha256:h('6'),switch_deadline_ms:Date.now()+120000,
 pause:{epoch:id(9),requested_at_ms:Date.now(),drained_at_ms:Date.now(),observed_extent:{from_ms:0,to_ms:86400000,high_watermark:'100'}},final_plan:spec};
 const acceptance={schema_version:'search-reencode-plan-acceptance-v1',mode:'administrator_report_acceptance',job_id:job.id,base_generation:1,payload_fingerprint:fp,criteria_sha256:spec.acceptance_criteria_sha256,
 report_sha256:h('7'),base_aggregate_sha256:h('4'),base_coverage_sha256:h('5'),base_index_manifest_sha256:h('6'),accepted_by:'human',accepted_at:new Date().toISOString()};
 await pool.query('UPDATE search_jobs SET migration_progress=$2,migration_acceptance=$3 WHERE id=$1',[job.id,JSON.stringify(state),JSON.stringify(acceptance)]);
 // This fixture's report resolver is an explicit software oracle. Production
 // uses real Native provenance plus PG shard/file manifests; no BPU assertion.
 const frozen={parent_id:parent.id,parent_generation:job.generation,payload_fingerprint:fp,aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3'),children:[{artifacts:{report:{scanned:2,encoded:2,unavailable:0}}}]} as unknown as SearchMigrationPlanArtifacts;
 const artifacts={resolve:async()=>frozen} as unknown as SearchModelMigrationPlanArtifacts;
 const context={revision:h('c'),storage_generation:h('d'),desired_version:1,source,channels};
 const actual=async()=>(await jobs.get(parent.id,'human'))!;
 const publish=(signal?:AbortSignal)=>store.publish('fixture target','human',{services:['search-service'],signal,prepare:client=>prepareSearchModelMigrationPlanActivation(client,{store,artifacts,job,worker,context,frozen})});
 const restore=async()=>store.publish('fixture restore','human',{services:['search-service'],prepare:client=>prepareSearchModelMigrationPlanRestore(client,{store,job:job,worker})});
 return {pool,store,jobs,runtime,worker,job,settings,spec,state,frozen,publish,restore,actual};
}
it.skipIf(!enabled)('plan publication is a normal full snapshot; actual source stays pinned until target Ready ACK',async()=>isolated(async f=>{
 const version=await f.publish();expect(version.version).toBe(2);
 expect((await f.actual()).migration_progress).toMatchObject({phase:'activated',published_version:2,source_config_version:1});
 expect((await f.runtime.read())!.active_model).toEqual(source);
 expect((await f.pool.query("SELECT desired_version,applied_version,status FROM config_service_states WHERE service_name='search-service'")).rows[0]).toMatchObject({desired_version:2,applied_version:1,status:'pending'});
 await f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null});
 expect((await f.actual()).state).toBe('running');
 await f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target});
 expect((await f.actual()).state).toBe('succeeded');expect((await f.runtime.read())!.active_model).toEqual(target);
 await expect(f.restore()).rejects.toThrow('migration_job_stale');
}));
it.skipIf(!enabled)('failed target rolls desired back through a new snapshot and completes only after real old-model Ready ACK',async()=>isolated(async f=>{
 await f.publish();await f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null});
 await f.pool.query(`INSERT INTO config_documents(service,"group",name,config) VALUES('backend','system','fixture','{"untouched":true}')`);
 const restored=await f.restore();expect(restored.version).toBe(3);
 expect((await f.actual()).migration_progress).toMatchObject({phase:'restoring',source_config_version:1,published_version:2,rollback_version:3});
 expect((await f.store.getDocument('search-service','system','settings'))!.config).toEqual(f.settings);
 expect((await f.store.getVersionSnapshot(3))!.find(d=>d.name==='fixture')!.config).toEqual({untouched:true});
 await f.runtime.acknowledge({desired_version:3,revision:h('8'),status:'applied',error_code:null});
 expect((await f.actual()).state).toBe('running');
 await f.runtime.acknowledge({desired_version:3,revision:h('8'),status:'applied',error_code:null,active_model:source});
 expect((await f.actual()).migration_progress).toMatchObject({phase:'restored',pause:null,switch_deadline_ms:null});
 expect((await f.actual()).state).toBe('succeeded');
}));
it.skipIf(!enabled)('changed desired/current document refuses rollback without overwriting newer human edits',async()=>isolated(async f=>{
 await f.publish();await f.pool.query(`UPDATE config_documents SET config=jsonb_set(config,'{limits,retention_days}','20') WHERE service='search-service'`);
 await expect(f.restore()).rejects.toThrow('migration_restore_conflict');
 expect((await f.store.getDocument('search-service','system','settings'))!.config.limits).toMatchObject({retention_days:20});
 expect((await f.pool.query('SELECT count(*)::int n FROM config_versions')).rows[0].n).toBe(2);
}));
it.skipIf(!enabled)('a published recovery survives worker restart/attempt cap and never cancels away a desired target',async()=>isolated(async f=>{
 await f.publish();expect(await f.jobs.cancelMigrationPlan(f.job.id,'human')).toBe(false);
 expect(await f.jobs.failMigrationPlan(f.job.id,f.worker,f.job.generation,'source_changed')).toBe(false);
 await f.pool.query(`UPDATE search_jobs SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.job.id]);
 const next=randomUUID(),recovered=(await f.jobs.claimMigrationPlan(next,30000,true))!;
 expect(recovered.id).toBe(f.job.id);expect(recovered.generation).toBeGreaterThan(f.job.generation);
 const version=await f.store.publish('recover source after restart','human',{services:['search-service'],prepare:client=>prepareSearchModelMigrationPlanRestore(client,{store:f.store,job:recovered,worker:next})});
 expect(version.version).toBe(3);expect(await f.jobs.markMigrationPlanRestoreFailed(recovered.id,next,recovered.generation)).toBe(true);
 expect((await f.actual()).migration_progress).toMatchObject({phase:'restore_failed',rollback_version:3});
 expect((await f.runtime.read())!.active_model).toEqual(source);
 await f.runtime.acknowledge({desired_version:3,revision:h('9'),status:'applied',error_code:null,active_model:source});
 expect((await f.actual()).state).toBe('succeeded');expect((await f.actual()).error_code).toBeNull();
}));
it.skipIf(!enabled)('final missing evidence or expired drain deadline cannot publish a global switch',async()=>isolated(async f=>{
 f.frozen.children[0]!.artifacts.report.unavailable=1;f.frozen.children[0]!.artifacts.report.scanned=3;
 await expect(f.publish()).rejects.toThrow('migration_coverage_incomplete');
 f.frozen.children[0]!.artifacts.report.unavailable=0;f.frozen.children[0]!.artifacts.report.scanned=2;
 await f.pool.query(`UPDATE search_jobs SET migration_progress=jsonb_set(migration_progress,'{switch_deadline_ms}',to_jsonb($2::bigint)) WHERE id=$1`,[f.job.id,Date.now()-1]);
 await expect(f.publish()).rejects.toThrow('migration_finalization_pending');
 expect((await f.store.getDocument('search-service','system','settings'))!.config.model).toEqual({package_id:'source'});
}));
for(const [name,basic,old] of [['config-only 001',true,false],['search 017 before progress columns',false,true]] as const)
it.skipIf(!enabled)(`bounded history SQL stays executable on ${name}`,async()=>isolated(async f=>{
 const version=await f.store.publish('compatible basic publish','human');expect(version.version).toBe(1);
 await f.pool.query(CONFIG_HISTORY_RETENTION_SQL);
},basic,old));
it.skipIf(!enabled)('pending switch source snapshot survives normal history pruning, then expires with its bounded task',async()=>isolated(async f=>{
 await f.publish();await f.pool.query(`INSERT INTO config_versions(version,status) SELECT generate_series(3,1006),'published'`);
 await f.pool.query(`UPDATE config_service_states SET applied_version=1006,desired_version=1006 WHERE service_name='search-service'`);
 await f.pool.query(CONFIG_HISTORY_RETENTION_SQL);
 expect((await f.pool.query('SELECT version FROM config_versions WHERE version=1')).rowCount).toBe(1);
 await f.pool.query(`UPDATE search_jobs SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.job.id]);
 await f.pool.query(CONFIG_HISTORY_RETENTION_SQL);
 expect((await f.pool.query('SELECT version FROM config_versions WHERE version=1')).rowCount).toBe(0);
}));
it.skipIf(!enabled)('aborted delayed prepare cannot commit after the migration deadline or overwrite restoration',async()=>isolated(async f=>{
 const stop=new AbortController();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const pending=f.store.publish('delayed software fixture','human',{services:['search-service'],signal:stop.signal,prepare:async client=>{
   entered();await gate;await client.query(`UPDATE config_documents SET config=jsonb_set(config,'{model,package_id}','"target"') WHERE service='search-service'`);
 }});await started;stop.abort();release();await expect(pending).rejects.toThrow();
 expect((await f.store.getDocument('search-service','system','settings'))!.config).toEqual(f.settings);
 expect((await f.pool.query('SELECT count(*)::int n FROM config_versions')).rows[0].n).toBe(1);
}));
it.skipIf(!enabled)('an already-inflight COMMIT is recovered by exact durable published-version compensation',async()=>isolated(async f=>{
 const stop=new AbortController();let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const connect=f.pool.connect.bind(f.pool),hook=vi.spyOn(f.pool,'connect');
 hook.mockImplementation((async()=>{
   const client=await connect(),query=client.query.bind(client);
   client.query=(async(...args:any[])=>{
     if(args[0]==='COMMIT'){entered();await gate;}
     return (query as any)(...args);
   }) as typeof client.query;
   return client;
 }) as any);
 const pending=f.publish(stop.signal);await started;stop.abort();release();
 const committed=await pending;hook.mockRestore();expect(committed.version).toBe(2);
 // The server accepted COMMIT before cancellation: cancellation cannot prove
 // non-publication. The existing durable parent/snapshot is the recovery key.
 expect((await f.actual()).migration_progress).toMatchObject({phase:'activated',published_version:2});
 await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.job.id]);
 const worker=randomUUID(),recovered=(await f.jobs.claimMigrationPlan(worker,30000,true))!;
 const restored=await f.store.publish('recover inflight commit','human',{services:['search-service'],prepare:client=>prepareSearchModelMigrationPlanRestore(client,{store:f.store,job:recovered,worker})});
 expect(restored.version).toBe(3);expect((await f.store.getDocument('search-service','system','settings'))!.config).toEqual(f.settings);
}));
it.skipIf(!enabled)('Ready ACK fails closed on an expired parent lease or an explicitly verified missing transition',async()=>isolated(async f=>{
 await f.publish();const approval=(await f.runtime.modelAuthority()).approved_model_transition!;
 await expect(f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target},{expected_transition:null})).rejects.toThrow('model_migration_required');
 await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.job.id]);
 await expect(f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target},{expected_transition:approval})).rejects.toThrow('model_migration_required');
 expect((await f.runtime.read())!.active_model).toEqual(source);expect((await f.actual()).state).toBe('running');
}));
it.skipIf(!enabled)('Ready ACK uses NOWAIT on the authority parent and never deadlocks against a parent-first reader',async()=>isolated(async f=>{
 await f.publish();const expected=(await f.runtime.modelAuthority()).approved_model_transition!,blocker=await f.pool.connect();
 try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM search_jobs WHERE id=$1 FOR UPDATE',[f.job.id]);
 await expect(f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target},{expected_transition:expected})).rejects.toMatchObject({code:'55P03'});
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 expect((await f.runtime.read())!.active_model).toEqual(source);
}));
it.skipIf(!enabled)('an authority CAS returning zero rows cannot commit a target pin or a new runtime acknowledgment',async()=>isolated(async f=>{
 await f.publish();const expected=(await f.runtime.modelAuthority()).approved_model_transition!;
 await f.pool.query(`CREATE FUNCTION reject_ready_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state='running' AND NEW.state='succeeded' AND OLD.payload->>'purpose'='reencode_plan' THEN RETURN NULL;END IF;RETURN NEW;END $$;
 CREATE TRIGGER reject_ready_fixture BEFORE UPDATE ON search_jobs FOR EACH ROW EXECUTE FUNCTION reject_ready_fixture()`);
 await expect(f.runtime.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target},{expected_transition:expected})).rejects.toThrow('model_migration_required');
 expect((await f.runtime.read())!).toMatchObject({desired_version:1,active_model:source});expect((await f.actual()).state).toBe('running');
}));
it.skipIf(!enabled)('a delayed ACK cannot borrow a replacement worker generation after its route verified the old transition',async()=>isolated(async f=>{
 await f.publish();const expected=(await f.runtime.modelAuthority()).approved_model_transition!,blocker=await f.pool.connect();
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve);
 const delayed=new SearchRuntimeStore({connect:async()=>{
   const client=await f.pool.connect();return {query:async(sql:string,args?:unknown[])=>{
     if(sql.startsWith('SELECT desired_version FROM config_service_states'))entered();return client.query(sql,args);
   },release:()=>client.release()} as unknown as PoolClient;
 }} as unknown as Pool);
 try{await blocker.query('BEGIN');await blocker.query(`SELECT service_name FROM config_service_states WHERE service_name='search-service' FOR UPDATE`);
 const pending=delayed.acknowledge({desired_version:2,revision:h('f'),status:'applied',error_code:null,active_model:target},{expected_transition:expected});
 const rejected=expect(pending).rejects.toThrow('model_migration_required');await waiting;
 await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[f.job.id]);
 const next=(await f.jobs.claimMigrationPlan(randomUUID(),30000,true))!;expect(next.generation).toBeGreaterThan(expected.generation);
 await blocker.query('COMMIT');await rejected;
 expect((await f.runtime.read())!.active_model).toEqual(source);expect((await f.actual()).generation).toBe(next.generation);expect((await f.actual()).state).toBe('running');
 }finally{await blocker.query('ROLLBACK').catch(()=>undefined);blocker.release();}
}));
