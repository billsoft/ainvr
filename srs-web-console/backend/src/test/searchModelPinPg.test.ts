import {searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest} from '../services/searchModelMigrationPlan.js';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {PgConfigStore} from '../store/pgStore.js';
import {SearchRuntimeStore} from '../store/searchRuntimeStore.js';
import {SearchJobs} from '../store/searchJobs.js';
import {DEFAULT_SEARCH_SETTINGS} from '../store/searchConfigAdapter.js';
import {SearchModelMigrationArtifacts} from '../services/searchModelMigrationArtifacts.js';
import {prepareSearchModelMigrationActivation} from '../services/searchModelMigrationActivation.js';
import {searchModelMigrationFingerprint,type SearchModelMigrationPayload} from '../services/searchModelMigrationContract.js';
const enabled=process.env.AINVR_SEARCH_TEST_PG==='1';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const h=(s:string)=>s.repeat(64);
const source={package_id:'source',model_version:`search-v1-${h('a')}`,package_sha256:h('a')};
const target={package_id:'target',model_version:`search-v1-${h('b')}`,package_sha256:h('b')};
const revision=h('c'),storage=h('d');
const scope={channel_ids:[id(1)],from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'};
async function isolated(run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>){
  const schema='search_pin_'+randomUUID().replaceAll('-',''),connection={host:'127.0.0.1',port:25439,user:'alarm_test',database:'alarm_test'};
  const admin=new Pool(connection);await admin.query(`CREATE SCHEMA ${schema}`);
  const store=new PgConfigStore({poolConfig:{...connection,options:`-c search_path=${schema}`,max:8},masterKeyPath:'/nonexistent/unused-migration-test-key'});
  try{
    for(const name of ['001_initial_schema.sql','017_search.sql','018_search_runtime.sql','019_search_shard_publication.sql','021_search_refresh_gc.sql','022_search_model_migration.sql','023_search_active_model_pin.sql'])
      await store.pool.query(readFileSync(new URL('../store/migrations/'+name,import.meta.url),'utf8'));
    await run(await fixture(store));
  }finally{await store.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function fixture(store:PgConfigStore){
  const pool=store.pool,jobs=new SearchJobs(pool),runtime=new SearchRuntimeStore(pool);
  const settings={...structuredClone(DEFAULT_SEARCH_SETTINGS),enabled:true,model:{package_id:source.package_id},callers:[
    {name:'console',scope:'console',key:'c'.repeat(48)},{name:'producer',scope:'producer',key:'p'.repeat(48)}],index_storage:{volume_id:'fixture-disk',relative_path:'ainvr/search-index'}};
  await pool.query(`UPDATE config_documents SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);
  await pool.query(`UPDATE config_snapshots SET config=$1 WHERE service='search-service'`,[JSON.stringify(settings)]);
  await pool.query(`UPDATE config_service_states SET applied_version=1,desired_version=1,status='applied' WHERE service_name IN ('search-service','backend')`);
  const context={revision,storage_generation:storage,desired_version:1,source,channels:[id(1)],
    extent:{source_model:source.model_version,from_ms:Date.parse(scope.from),to_ms:Date.parse(scope.to),high_watermark:'100'}};
  async function seedShard(model=target.model_version,shard=id(3)){
    await pool.query(`INSERT INTO search_index_shards(id,channel_id,model_version,day,state,revision,directory_storage_generation,storage_generation,
      published_revision,published_storage_generation,manifest_key,manifest_sha256,checkpoint,record_count,byte_count)
      VALUES($1,$2,$3,'2026-10-01','ready',1,$4,$4,1,$4,$5,$6,200,2,256)`,[shard,id(1),model,storage,`${shard}/1.manifest.json`,h('e')]);
  }
  async function readyMigration(){
    const payload:SearchModelMigrationPayload={schema_version:'search-reencode-v1',purpose:'reencode',source,target,scope,config_revision:revision,storage_generation:storage,
      source_high_watermark:'100',batch_size:32,acceptance_criteria_sha256:h('1')};
    const created=await jobs.enqueueMigration('operator',randomUUID(),payload),worker=randomUUID(),lease=(await jobs.claimMigration(worker))!;
    const fp=searchModelMigrationFingerprint(payload);
    await seedShard();
    const indexHash=createHash('sha256').update(JSON.stringify(['ainvr-search-migration-index-v1',fp,'200',[
      [id(3),id(1),target.model_version,'2026-10-01','1',storage,h('e'),'200',2,'256']]])).digest('hex');
    const progress={...(lease.migration_progress as any),cursor:{ordinal:'100',sample_id:id(4)},scanned:2,encoded:2,unavailable:0};
    expect(await jobs.checkpointMigration(lease.id,worker,lease.generation,lease.migration_progress,progress)).toBe(true);
    const final={...progress,phase:'awaiting_acceptance',source_completed_through:'100',target_checkpoint:'200',coverage_sha256:h('2'),index_manifest_sha256:indexHash};
    expect(await jobs.checkpointMigration(lease.id,worker,lease.generation,progress,final)).toBe(true);
    expect(await jobs.finishMigration(lease.id,worker,lease.generation,final)).toBe(true);
    const acceptance={schema_version:'search-reencode-acceptance-v1',mode:'administrator_report_acceptance',job_id:created.id,generation:lease.generation,
      payload_fingerprint:fp,criteria_sha256:h('1'),report_sha256:h('3'),source_completed_through:'100',target_checkpoint:'200',coverage_sha256:h('2'),
      index_manifest_sha256:indexHash,accepted_by:'operator',accepted_at:new Date().toISOString()};
    expect(await jobs.acceptMigration(created.id,'operator',acceptance)).toBe(true);
    const job=(await jobs.get(created.id,'operator'))!;
    const report={schema_version:'search-reencode-artifacts-v1',payload_fingerprint:fp,source,target,scope,source_completed_through:'100',target_checkpoint:'200',
      scanned:2,encoded:2,unavailable:0,coverage_sha256:h('2'),partitions:[{channel_id:id(1),day:'2026-10-01',checkpoint:'200',records:2}]};
    const artifacts=new SearchModelMigrationArtifacts(pool,async()=>({...report,next_cursor:null}));
    const frozen=await artifacts.resolve(job);
    return {job,artifacts,frozen,payload};
  }
  return {store,pool,jobs,runtime,settings,context,seedShard,readyMigration};
}
it.skipIf(!enabled)('023 persists the actual Ready identity and disabled/pending reports never clear it',async()=>isolated(async f=>{
  expect(await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source})).toBe(true);
  expect((await f.runtime.read())!.active_model).toEqual(source);
  expect(await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:null})).toBe(true);
  expect(await f.runtime.acknowledge({desired_version:1,revision,status:'failed',error_code:'model_pending'})).toBe(true);
  expect((await f.runtime.read())!.active_model).toEqual(source);
  const authority=await f.runtime.modelAuthority();expect(authority.active_model_pin).toEqual(source);expect(authority.approved_model_transition).toBeNull();
  await expect(f.pool.query(`UPDATE search_runtime_state SET active_model=$1`,[JSON.stringify({...source,path:'/models/private'})])).rejects.toThrow();
}));
it.skipIf(!enabled)('same package ID with new HBM space is rejected without a migration proof',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});
  await expect(f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:{...target,package_id:source.package_id}})).rejects.toThrow('model_migration_required');
  expect((await f.runtime.read())!.active_model).toEqual(source);
}));
it.skipIf(!enabled)('first pin cannot ignore a conflicting published legacy space',async()=>isolated(async f=>{
  await f.seedShard(target.model_version);
  await expect(f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source})).rejects.toThrow('model_migration_required');
  expect(await f.runtime.read()).toBeNull();
}));
it.skipIf(!enabled)('accepted activation publishes only desired/full snapshot; the old actual pin changes only after real Ready ACK',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});
  const ready=await f.readyMigration();
  const result=await f.store.publish('test model migration','operator',{services:['search-service'],prepare:client=>prepareSearchModelMigrationActivation(client,{store:f.store,
    artifacts:ready.artifacts,job:ready.job,actor:'operator',context:f.context,frozen:ready.frozen})});
  expect(result.version).toBe(2);
  expect((await f.pool.query(`SELECT applied_version,desired_version,status FROM config_service_states WHERE service_name='search-service'`)).rows[0])
    .toEqual({applied_version:1,desired_version:2,status:'pending'});
  expect((await f.pool.query(`SELECT applied_version,desired_version FROM config_service_states WHERE service_name='backend'`)).rows[0]).toEqual({applied_version:1,desired_version:1});
  expect((await f.store.getVersionSnapshotForService(1,'search-service'))[0].config.model).toEqual({package_id:source.package_id});
  expect((await f.store.getVersionSnapshotForService(2,'search-service'))[0].config.model).toEqual({package_id:target.package_id});
  const before=await f.runtime.modelAuthority();expect(before.active_model_pin).toEqual(source);expect(before.approved_model_transition).toMatchObject({job_id:ready.job.id,source,target});
  expect(await f.runtime.acknowledge({desired_version:2,revision:h('4'),status:'applied',error_code:null,active_model:target})).toBe(true);
  expect((await f.runtime.modelAuthority()).active_model_pin).toEqual(target);expect((await f.runtime.modelAuthority()).approved_model_transition).toBeNull();
}));
it.skipIf(!enabled)('a valid activated target can establish a missing legacy pin even while old and new spaces coexist',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});
  const ready=await f.readyMigration();await f.seedShard(source.model_version,id(9));
  const result=await f.store.publish('test legacy transition','operator',{services:['search-service'],prepare:client=>prepareSearchModelMigrationActivation(client,{store:f.store,
    artifacts:ready.artifacts,job:ready.job,actor:'operator',context:f.context,frozen:ready.frozen})});
  await f.pool.query(`UPDATE search_runtime_state SET active_model=NULL`);
  expect((await f.runtime.modelAuthority()).approved_model_transition?.target).toEqual(target);
  expect(await f.runtime.acknowledge({desired_version:result.version,revision:h('5'),status:'applied',error_code:null,active_model:target})).toBe(true);
  expect((await f.runtime.read())!.active_model).toEqual(target);
}));
it.skipIf(!enabled)('a changed target manifest rolls back activation and cannot alter configuration or old pin',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});const ready=await f.readyMigration();
  await f.pool.query(`UPDATE search_index_shards SET manifest_sha256=$1 WHERE id=$2`,[h('6'),id(3)]);
  await expect(f.store.publish('must rollback','operator',{services:['search-service'],prepare:client=>prepareSearchModelMigrationActivation(client,{store:f.store,
    artifacts:ready.artifacts,job:ready.job,actor:'operator',context:f.context,frozen:ready.frozen})})).rejects.toThrow('migration_manifest_changed');
  expect((await f.store.getDocument('search-service','system','settings'))!.config.model).toEqual({package_id:source.package_id});
  expect((await f.runtime.read())!.active_model).toEqual(source);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM config_versions')).rows[0].n).toBe(1);
  expect((await f.jobs.get(ready.job.id,'operator'))!.migration_progress).toMatchObject({phase:'ready'});
}));
it.skipIf(!enabled)('new live-tail data or another configured source prevents a partial global switch',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});const ready=await f.readyMigration();
  const context={...f.context,channels:[id(1),id(99)],extent:{...f.context.extent,to_ms:Date.parse(scope.to)+1,high_watermark:'101'}};
  await expect(f.store.publish('must remain old','operator',{services:['search-service'],prepare:client=>prepareSearchModelMigrationActivation(client,{store:f.store,
    artifacts:ready.artifacts,job:ready.job,actor:'operator',context,frozen:ready.frozen})})).rejects.toThrow('migration_scope_incomplete');
  expect((await f.store.getServiceState('search-service'))!.desiredVersion).toBe(1);expect((await f.runtime.read())!.active_model).toEqual(source);
}));
it.skipIf(!enabled)('legacy source identity uses unique published space and retained package mapping rather than current weight files',async()=>isolated(async f=>{
  await f.seedShard(source.model_version);
  expect(await f.runtime.legacySourceModel(source.package_id)).toBeNull();
  const old=await f.jobs.enqueue('internal-search-index',randomUUID(),'index',{package_id:source.package_id});
  await f.pool.query('UPDATE search_index_shards SET build_job_id=$1 WHERE id=$2',[old.id,id(3)]);
  expect(await f.runtime.legacySourceModel(source.package_id)).toEqual(source);
  await f.seedShard(target.model_version,id(8));await f.pool.query('UPDATE search_index_shards SET build_job_id=$1 WHERE id=$2',[old.id,id(8)]);
  expect(await f.runtime.legacySourceModel(source.package_id)).toBeNull();
}));
it.skipIf(!enabled)('target write authority uses the actual running PG lease and exact source/config/storage fences',async()=>isolated(async f=>{
  await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});
  const payload:SearchModelMigrationPayload={schema_version:'search-reencode-v1',purpose:'reencode',source,target,scope,config_revision:revision,storage_generation:storage,
    source_high_watermark:'100',batch_size:32,acceptance_criteria_sha256:h('1')};
  await f.jobs.enqueueMigration('operator',randomUUID(),payload);const worker=randomUUID(),job=(await f.jobs.claimMigration(worker))!,fp=searchModelMigrationFingerprint(payload);
  const sample={sample_id:id(20),fingerprint:h('2'),channel_id:id(1),captured_ms:Date.parse(scope.from),ordinal:'100',jpeg_sha256:h('3')};
  const grant=await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context);
  expect(grant).toMatchObject({job_id:job.id,worker,generation:job.generation,payload_fingerprint:fp,source,target,source_high_watermark:'100'});
  expect(grant!.job_expires_ms).toBe(job.expires_at.getTime());expect(grant!.target_checkpoint).toBe('0');
  expect(Number.isSafeInteger(grant!.lease_until_ms)).toBe(true);expect(grant!.lease_until_ms).toBeGreaterThan(Date.now()+1000);
  expect(JSON.stringify(grant)).not.toMatch(/api_token|http:|password|path/);
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,sample)).toEqual(grant);
  for(const patch of [{channel_id:id(99)},{captured_ms:Date.parse(scope.to)},{ordinal:'101'}])
    expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,{...sample,...patch})).toBeNull();
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation+1,'operator',fp,f.context,sample)).toBeNull();
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'other',fp,f.context,sample)).toBeNull();
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',h('9'),f.context,sample)).toBeNull();
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,{...f.context,storage_generation:h('9')},sample)).toBeNull();
  await f.pool.query(`UPDATE config_service_states SET desired_version=2 WHERE service_name='search-service'`);
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,sample)).toBeNull();
  await f.pool.query(`UPDATE config_service_states SET desired_version=1 WHERE service_name='search-service'`);
  await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`,[job.id]);
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,sample)).toBeNull();
  await f.pool.query(`UPDATE search_jobs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`,[job.id]);
  const before=job.migration_progress as any,next={...before,phase:'building_index'};
  expect(await f.jobs.checkpointMigration(job.id,worker,job.generation,before,next)).toBe(true);
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,sample)).toBeNull();
  expect(await f.jobs.authorizeMigrationArtifacts(job.id,worker,job.generation,'operator',fp,f.context)).toMatchObject({target,job_expires_ms:job.expires_at.getTime(),target_checkpoint:'0'});
  expect(await f.jobs.cancelMigration(job.id,'operator')).toBe(true);
  expect(await f.jobs.authorizeMigrationWrite(job.id,worker,job.generation,'operator',fp,f.context,sample)).toBeNull();
}));

it.skipIf(!enabled)('final report read is owner-scoped metadata authority without a live writer lease',async()=>isolated(async f=>{
 await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});const ready=await f.readyMigration();
 const fp=searchModelMigrationFingerprint(ready.job.payload as SearchModelMigrationPayload);
 const grant=await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'operator',fp,f.context);
 expect(grant).toMatchObject({mode:'report_read',job_id:ready.job.id,generation:ready.job.generation,source,target,target_checkpoint:ready.frozen.report.target_checkpoint});
 expect(grant).not.toHaveProperty('worker');expect(grant).not.toHaveProperty('lease_until_ms');
 expect(await f.jobs.authorizeMigrationArtifacts(ready.job.id,randomUUID(),ready.job.generation,'operator',fp,f.context)).toBeNull();
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'other',fp,f.context)).toBeNull();
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation+1,'operator',fp,f.context)).toBeNull();
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'operator',fp,{...f.context,channels:[id(99)]})).toBeNull();
 expect(await f.jobs.cancelMigration(ready.job.id,'operator')).toBe(true);
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'operator',fp,f.context)).toBeNull();
}));
it.skipIf(!enabled)('activated report remains auditable after the actual model pin switches but never becomes write authority',async()=>isolated(async f=>{
 await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});const ready=await f.readyMigration();
 const version=await f.store.publish('test report audit','operator',{services:['search-service'],prepare:client=>prepareSearchModelMigrationActivation(client,{store:f.store,artifacts:ready.artifacts,job:ready.job,actor:'operator',context:f.context,frozen:ready.frozen})});
 await f.runtime.acknowledge({desired_version:version.version,revision:h('4'),status:'applied',error_code:null,active_model:target});
 const current={...f.context,source:target,revision:h('4'),desired_version:version.version},fp=searchModelMigrationFingerprint(ready.job.payload as SearchModelMigrationPayload);
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'operator',fp,current)).toMatchObject({mode:'report_read',source,target});
 expect(await f.jobs.authorizeMigrationWrite(ready.job.id,randomUUID(),ready.job.generation,'operator',fp,current)).toBeNull();
 expect(await f.jobs.authorizeMigrationReportRead(ready.job.id,ready.job.generation,'operator',fp,{...current,storage_generation:h('9')})).toBeNull();
}));

it.skipIf(!enabled)('accepted activated parent authorizes only its exact published version and terminates only on a synthetic Ready pin ACK',async()=>isolated(async f=>{
 // This PG fixture models a verified Native barrier/report; no hardware drain,
 // image encoding or model quality is claimed by these metadata assertions.
 await f.pool.query(readFileSync(new URL('../store/migrations/024_search_model_migration_plan.sql',import.meta.url),'utf8'));
 await f.runtime.acknowledge({desired_version:1,revision,status:'applied',error_code:null,active_model:source});
 const spec={schema_version:'search-reencode-plan-v1' as const,purpose:'reencode_plan' as const,source,target,config_revision:revision,storage_generation:storage,acceptance_criteria_sha256:h('1'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest([id(1)]),extent:{from_ms:Date.parse(scope.from),to_ms:Date.parse(scope.to),source_high_watermark:'100'}};
 const parent=await f.jobs.enqueueMigrationPlan('operator',randomUUID(),spec),worker=randomUUID(),lease=(await f.jobs.claimMigrationPlan(worker))!,fp=searchMigrationPlanFingerprint(spec),now=Date.now();
 const acceptance={schema_version:'search-reencode-plan-acceptance-v1',mode:'administrator_report_acceptance',job_id:parent.id,base_generation:lease.generation,payload_fingerprint:fp,criteria_sha256:h('1'),report_sha256:h('2'),base_aggregate_sha256:h('3'),base_coverage_sha256:h('4'),base_index_manifest_sha256:h('5'),accepted_by:'operator',accepted_at:new Date().toISOString()};
 const progress={...(lease.migration_progress as any),phase:'activated',active_round:1,published_version:2,next_partition:1,total_children:1,aggregate_sha256:h('6'),coverage_sha256:h('7'),index_manifest_sha256:h('8'),base_aggregate_sha256:h('3'),base_coverage_sha256:h('4'),base_index_manifest_sha256:h('5'),final_plan:spec,switch_deadline_ms:now+120000,pause:{epoch:id(40),requested_at_ms:now-10,drained_at_ms:now-5,observed_extent:{from_ms:Date.parse(scope.from),to_ms:Date.parse(scope.to),high_watermark:'100'}}};
 const version=await f.store.publish('parent transition fixture','operator',{services:['search-service'],prepare:async client=>{
 const doc=(await f.store.getDocument('search-service','system','settings'))!;
 await client.query(`UPDATE config_documents SET config=$1 WHERE id=$2`,[JSON.stringify({...doc.config,model:{package_id:target.package_id}}),doc.id]);
 await client.query('UPDATE search_jobs SET migration_progress=$2,migration_acceptance=$3 WHERE id=$1',[parent.id,JSON.stringify(progress),JSON.stringify(acceptance)]);
 }});
 expect(version.version).toBe(2);expect((await f.runtime.modelAuthority()).approved_model_transition).toMatchObject({job_id:parent.id,generation:lease.generation,source,target});
 await f.pool.query("UPDATE search_jobs SET migration_progress=jsonb_set(migration_progress,'{published_version}','3') WHERE id=$1",[parent.id]);
 expect((await f.runtime.modelAuthority()).approved_model_transition).toBeNull();
 await expect(f.runtime.acknowledge({desired_version:2,revision:h('9'),status:'applied',error_code:null,active_model:target})).rejects.toThrow('model_migration_required');
 await f.pool.query("UPDATE search_jobs SET migration_progress=jsonb_set(migration_progress,'{published_version}','2') WHERE id=$1",[parent.id]);
 expect(await f.runtime.acknowledge({desired_version:2,revision:h('9'),status:'applied',error_code:null})).toBe(true);
 expect((await f.runtime.read())!.active_model).toEqual(source);expect((await f.jobs.get(parent.id,'operator'))!.state).toBe('running');
 expect(await f.runtime.acknowledge({desired_version:2,revision:h('9'),status:'applied',error_code:null,active_model:target})).toBe(true);
 expect((await f.runtime.read())!.active_model).toEqual(target);expect((await f.jobs.get(parent.id,'operator'))!).toMatchObject({state:'succeeded',lease_owner:null,lease_until:null});
}));
