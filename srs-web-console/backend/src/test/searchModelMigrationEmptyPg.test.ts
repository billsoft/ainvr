import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {PgConfigStore} from '../store/pgStore.js';
import {SearchJobs} from '../store/searchJobs.js';
import {SearchRuntimeStore} from '../store/searchRuntimeStore.js';
import {DEFAULT_SEARCH_SETTINGS} from '../store/searchConfigAdapter.js';
import {SearchModelMigrationPlanArtifacts} from '../services/searchModelMigrationPlanArtifacts.js';
import {prepareSearchModelMigrationPlanActivation} from '../services/searchModelMigrationActivation.js';
import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest} from '../services/searchModelMigrationPlan.js';
const enabled=process.env.AINVR_SEARCH_TEST_PG==='1',h=(s:string)=>s.repeat(64),id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const source={package_id:'source',package_sha256:h('a'),model_version:`search-v1-${h('a')}`},target={package_id:'target',package_sha256:h('b'),model_version:`search-v1-${h('b')}`},ids=[id(1)];
async function isolated(run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>){
 const schema='search_empty_'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'},admin=new Pool(connection);
 await admin.query(`CREATE SCHEMA ${schema}`);const store=new PgConfigStore({poolConfig:{...connection,options:`-c search_path=${schema}`,max:8},masterKeyPath:'/nonexistent/unused-empty-plan-test'});
 try{for(const name of ['001_initial_schema.sql','017_search.sql','018_search_runtime.sql','019_search_shard_publication.sql','021_search_refresh_gc.sql','022_search_model_migration.sql','023_search_active_model_pin.sql','024_search_model_migration_plan.sql'])
 await store.pool.query(readFileSync(new URL('../store/migrations/'+name,import.meta.url),'utf8'));await run(await fixture(store));}
 finally{await store.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function fixture(store:PgConfigStore){
 const pool=store.pool,jobs=new SearchJobs(pool),runtime=new SearchRuntimeStore(pool),worker=randomUUID();
 const settings={...structuredClone(DEFAULT_SEARCH_SETTINGS),enabled:true,model:{package_id:'source'},callers:[{name:'console',scope:'console',key:'c'.repeat(48)},{name:'producer',scope:'producer',key:'p'.repeat(48)}],index_storage:{volume_id:'fixture-ssd',relative_path:'ainvr/search-index'}};
 await pool.query(`UPDATE config_documents SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);await pool.query(`UPDATE config_snapshots SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);
 await runtime.acknowledge({desired_version:1,revision:h('c'),status:'applied',error_code:null,active_model:source});
 const context={revision:h('c'),storage_generation:h('d'),desired_version:1,source,channels:ids};
 const spec={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',source,target,config_revision:h('c'),storage_generation:h('d'),acceptance_criteria_sha256:h('e'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest(ids),extent:{from_ms:null,to_ms:null,source_high_watermark:'0'}} as const;
 // Empty plans contain no child Native report. The resolver still binds the
 // source catalog, model spaces and immutable empty extent. The final actual
 // Native drain ACK is simulated here only to test PG authority, not hardware.
 const artifacts=new SearchModelMigrationPlanArtifacts({resolve:async()=>{throw new Error('empty plan must not manufacture a child');}});
 const parent=await jobs.enqueueMigrationPlan('human',randomUUID(),spec),lease=(await jobs.claimMigrationPlan(worker))!;
 async function complete(){const snapshot=(await jobs.migrationPlanChildren(parent.id,worker,lease.generation))!,proof=await artifacts.resolve(snapshot.parent,snapshot.children,ids);
 expect(await jobs.completeMigrationPlan(parent.id,worker,lease.generation,ids,[],(client,row,children)=>artifacts.resolve(row,children,ids,client,proof,true))).toBe(true);return proof;}
 async function ready(){expect((await jobs.prepareMigrationPlanChildren(parent.id,worker,lease.generation,ids))!.created).toEqual([]);const proof=await complete();
 const done=(await jobs.get(parent.id,'human'))!,fp=searchMigrationPlanFingerprint(spec);
 expect(await jobs.acceptMigrationPlan(parent.id,'human',{schema_version:'search-reencode-plan-acceptance-v1',mode:'administrator_report_acceptance',job_id:parent.id,base_generation:done.generation,payload_fingerprint:fp,criteria_sha256:spec.acceptance_criteria_sha256,
 report_sha256:h('f'),base_aggregate_sha256:proof.aggregate_sha256,base_coverage_sha256:proof.coverage_sha256,base_index_manifest_sha256:proof.index_manifest_sha256,accepted_by:'human',accepted_at:new Date().toISOString()})).toBe(true);
 expect(await jobs.requestMigrationPlanSwitch(parent.id,'human',done.generation,fp)).toBe(true);Object.assign(lease,(await jobs.claimMigrationPlan(worker))!);return (await jobs.requestMigrationPlanPause(parent.id,worker,lease.generation))!;}
 return {store,pool,jobs,runtime,worker,parent,lease,spec,context,artifacts,ready,complete};
}
it.skipIf(!enabled)('empty retained history still requires real drain proof before its zero-child full publication',async()=>isolated(async f=>{
 const pause=await f.ready();expect((await f.jobs.get(f.parent.id,'human'))!.migration_progress).toMatchObject({phase:'quiescing'});
 await expect(f.store.publish('must reject before drain','human',{services:['search-service'],prepare:client=>prepareSearchModelMigrationPlanActivation(client,{store:f.store,artifacts:f.artifacts,job:f.lease,worker:f.worker,context:f.context,frozen:{} as never})})).rejects.toThrow('migration_finalization_pending');
 expect(await f.jobs.acknowledgeMigrationPlanPause(f.parent.id,f.worker,f.lease.generation,pause.epoch,{from_ms:null,to_ms:null,high_watermark:'0'},f.context)).toBe(true);
 expect((await f.jobs.prepareMigrationPlanChildren(f.parent.id,f.worker,f.lease.generation,ids))!.created).toEqual([]);const proof=await f.complete();
 const version=await f.store.publish('empty-history target','human',{services:['search-service'],prepare:client=>prepareSearchModelMigrationPlanActivation(client,{store:f.store,artifacts:f.artifacts,job:f.lease,worker:f.worker,context:f.context,frozen:proof})});
 expect(version.version).toBe(2);expect((await f.pool.query(`SELECT count(*)::int n FROM search_jobs WHERE payload->>'purpose'='reencode'`)).rows[0].n).toBe(0);
 expect((await f.runtime.read())!.active_model).toEqual(source);
 await f.runtime.acknowledge({desired_version:2,revision:h('9'),status:'applied',error_code:null,active_model:target});expect((await f.jobs.get(f.parent.id,'human'))!.state).toBe('succeeded');
}));
it.skipIf(!enabled)('new source evidence after an initially empty plan becomes a real delta child, not a falsely empty switch',async()=>isolated(async f=>{
 const pause=await f.ready();expect(await f.jobs.acknowledgeMigrationPlanPause(f.parent.id,f.worker,f.lease.generation,pause.epoch,{from_ms:1000,to_ms:2000,high_watermark:'5'},f.context)).toBe(true);
 const children=(await f.jobs.prepareMigrationPlanChildren(f.parent.id,f.worker,f.lease.generation,ids))!.created;
 expect(children).toHaveLength(1);expect(children[0]!.payload).toMatchObject({source_after_watermark:'0',source_high_watermark:'5',scope:{from:new Date(1000).toISOString(),to:new Date(2000).toISOString()}});
 expect(await f.jobs.completeMigrationPlan(f.parent.id,f.worker,f.lease.generation,ids,[],async()=>({aggregate_sha256:h('1'),coverage_sha256:h('2'),index_manifest_sha256:h('3')}))).toBe(false);
}));
