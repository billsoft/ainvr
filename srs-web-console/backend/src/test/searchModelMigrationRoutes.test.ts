import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { searchModelMigrationRoutes } from '../routes/searchModelMigrationRoutes.js';
import {searchMigrationPlanFingerprint,migrationPlanChildCount} from '../services/searchModelMigrationPlan.js';
import { searchModelMigrationFingerprint } from '../services/searchModelMigrationContract.js';
import type { SearchModelMigrationArtifacts } from '../services/searchModelMigrationArtifacts.js';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const h=(n:number)=>n.toString(16).repeat(64);
const scope={channel_ids:[id(1)],from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'};
const source={package_id:'source',package_sha256:h(1),model_version:`search-v1-${h(1)}`};
const target={package_id:'target',package_sha256:h(2),model_version:`search-v1-${h(2)}`};
const profile=(model:typeof source)=>({...model,dimensions:768,input_spec_version:'RGB;area;squash256',files_verified:true,production_approval_declared:true,pruned:false,runtime_ready:false as const});
const payload={schema_version:'search-reencode-v1' as const,purpose:'reencode' as const,source,target,scope,config_revision:h(3),storage_generation:h(4),
  source_high_watermark:'100',batch_size:32,acceptance_criteria_sha256:h(5)};
const fp=searchModelMigrationFingerprint(payload);
const progress={schema_version:'search-reencode-progress-v1',payload_fingerprint:fp,phase:'encoding',cursor:null,
  scanned:0,encoded:0,unavailable:0,source_completed_through:null,target_checkpoint:null,coverage_sha256:null,index_manifest_sha256:null};
const job=()=>({id:id(2),actor:'operator',kind:'rebuild',payload,state:'pending',generation:0,attempts:0,lease_owner:null,lease_until:null,
  expires_at:new Date(Date.now()+60000),migration_progress:{...progress},migration_acceptance:null});
const admin={'x-test-admin':'operator'};
async function fixture(){
  const app=Fastify();let row:any=job();
  const jobs={get:vi.fn(async(_id:string,actor:string)=>actor===row.actor?row:null),listMigrationPlans:vi.fn(async()=>row.payload.purpose==='reencode_plan'?[row]:[]),
    enqueueMigration:vi.fn(async(actor:string,_key:string,p:any)=>{row={...job(),actor,payload:p};row.migration_progress.payload_fingerprint=searchModelMigrationFingerprint(p);return row;}),
    cancelMigration:vi.fn(async()=>true),acceptMigration:vi.fn(async(_id:string,_actor:string,proof:any)=>{row.migration_acceptance=proof;row.migration_progress.phase='ready';return true;}),
    claimMigration:vi.fn(async()=>null),renewMigration:vi.fn(async()=>false),checkpointMigration:vi.fn(async()=>false),finishMigration:vi.fn(async()=>false),failMigration:vi.fn(async()=>false),authorizeMigrationWrite:vi.fn(async()=>null),authorizeMigrationArtifacts:vi.fn(async()=>null),authorizeMigrationReportRead:vi.fn(async()=>null),enqueueMigrationPlan:vi.fn(async(actor:string,_key:string,p:any)=>{row={...job(),actor,payload:p,migration_progress:{schema_version:'search-reencode-plan-progress-v1',payload_fingerprint:searchMigrationPlanFingerprint(p),phase:'preparing',next_partition:0,total_children:migrationPlanChildCount(p),aggregate_sha256:null,coverage_sha256:null,index_manifest_sha256:null}};return row;}),claimMigrationPlan:vi.fn(async()=>null),renewMigrationPlan:vi.fn(async()=>false),prepareMigrationPlanChildren:vi.fn(async()=>null),migrationPlanChildren:vi.fn(async()=>null),completeMigrationPlan:vi.fn(async()=>false),cancelMigrationPlan:vi.fn(async()=>true),failMigrationPlan:vi.fn(async()=>false),acceptMigrationPlan:vi.fn(async()=>false),requestMigrationPlanSwitch:vi.fn(async()=>false),requestMigrationPlanPause:vi.fn(async()=>null),acknowledgeMigrationPlanPause:vi.fn(async()=>false),abortMigrationPlanSwitch:vi.fn(async()=>false)};
  const native={verifyMigrationModel:vi.fn(async()=>profile(target)),migrationWatermark:vi.fn(async()=> '100')};
  const context:any={revision:h(3),storage_generation:h(4),desired_version:8,source:profile(source),channels:[id(1)],
    extent:{source_model:source.model_version,from_ms:Date.parse(scope.from),to_ms:Date.parse(scope.to),high_watermark:'100'}};
  const frozen:any={report:{source_completed_through:'100',target_checkpoint:'200',coverage_sha256:h(6)},index_manifest_sha256:h(7)};
  const artifacts={resolve:vi.fn(async()=>frozen)};
  const activate=vi.fn(()=>({id:id(10),status:'running' as const,stage:'正在应用',startedAt:Date.now(),deadline:Date.now()+60000,services:['search-service']}));
  const options={jobs:jobs as any,native,context:vi.fn(async()=>context),artifacts:artifacts as unknown as SearchModelMigrationArtifacts,planArtifacts:{resolve:vi.fn()} as any,
    executionAvailable:()=>false,activate,apply:{busy:false},
    principal:async(r:any)=>r.headers['x-test-admin']==='operator'?'operator':null,
    internalPrincipal:async(r:any)=>r.headers['x-test-service']==='search'};
  await searchModelMigrationRoutes(app,options);
  const complete=()=>{row.state='succeeded';row.generation=2;row.migration_progress={...progress,phase:'awaiting_acceptance',
    scanned:2,encoded:2,unavailable:0,source_completed_through:'100',target_checkpoint:'200',coverage_sha256:h(6),index_manifest_sha256:h(7)};};
  const accepted=()=>{complete();row.migration_progress.phase='ready';row.migration_acceptance={schema_version:'search-reencode-acceptance-v1',mode:'administrator_report_acceptance',
    job_id:row.id,generation:2,payload_fingerprint:fp,criteria_sha256:h(5),report_sha256:h(8),source_completed_through:'100',target_checkpoint:'200',
    coverage_sha256:h(6),index_manifest_sha256:h(7),accepted_by:'operator',accepted_at:new Date().toISOString()};};
  return {app,jobs,native,options,context,artifacts,activate,complete,accepted,get row(){return row;}};
}
const create={request_id:id(3),target_package_id:'target',scope,acceptance_criteria_sha256:h(5)};
it('public migration management requires the human principal; internal service cannot impersonate it',async()=>{
  const f=await fixture();try{
    expect((await f.app.inject({method:'POST',url:'/search/model-migrations',payload:create})).statusCode).toBe(401);
    expect((await f.app.inject({method:'POST',url:'/search/model-migrations',headers:{'x-test-service':'search'},payload:create})).statusCode).toBe(401);
    expect(f.jobs.enqueueMigration).not.toHaveBeenCalled();
  }finally{await f.app.close();}
});
it('retires legacy creation with a clear 410 before any model, history or job side effect',async()=>{
  const f=await fixture();try{
    const response=await f.app.inject({method:'POST',url:'/search/model-migrations',headers:admin,payload:create});
    expect(response.statusCode).toBe(410);expect(response.json()).toMatchObject({error:{code:'migration_plan_required'}});
    expect(f.jobs.enqueueMigration).not.toHaveBeenCalled();expect(f.activate).not.toHaveBeenCalled();
    expect(f.native.migrationWatermark).not.toHaveBeenCalled();expect(f.native.verifyMigrationModel).not.toHaveBeenCalled();
    expect(f.options.context).not.toHaveBeenCalled();
  }finally{await f.app.close();}
});
it('legacy creation cannot be revived by foreign scopes or arbitrary URLs',async()=>{
  const f=await fixture();try{
    expect((await f.app.inject({method:'POST',url:'/search/model-migrations',headers:admin,payload:{...create,scope:{...scope,channel_ids:[id(99)]}}})).statusCode).toBe(410);
    expect((await f.app.inject({method:'POST',url:'/search/model-migrations',headers:admin,payload:{...create,url:'http://private'}})).statusCode).toBe(410);
    expect(f.jobs.enqueueMigration).not.toHaveBeenCalled();
  }finally{await f.app.close();}
});
it('status and cancellation preserve human ownership without exposing a worker key',async()=>{
  const f=await fixture();try{
    const result=await f.app.inject({url:`/search/model-migrations/${id(2)}`,headers:admin});
    expect(result.statusCode).toBe(200);expect(JSON.stringify(result.json())).not.toMatch(/api_token|lease_owner|lease_until/);
    expect((await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/cancel`,headers:admin})).json()).toEqual({cancelled:true});
    expect(f.jobs.cancelMigration).toHaveBeenCalledWith(id(2),'operator');
  }finally{await f.app.close();}
});
it('accepts an explicit report only after the actual artifact resolver succeeds and supplies actor/time itself',async()=>{
  const f=await fixture();try{
    f.complete();const request={method:'POST' as const,url:`/search/model-migrations/${id(2)}/accept`,headers:admin,
      payload:{generation:2,payload_fingerprint:fp,report_sha256:h(8)}};
    const result=await f.app.inject(request);expect(result.statusCode).toBe(200);expect(f.artifacts.resolve).toHaveBeenCalled();
    const proof=f.jobs.acceptMigration.mock.calls[0]![2];expect(proof).toMatchObject({accepted_by:'operator',target_checkpoint:'200',criteria_sha256:h(5),report_sha256:h(8)});
    expect(Number.isFinite(Date.parse(proof.accepted_at))).toBe(true);
    expect((await f.app.inject(request)).statusCode).toBe(200);expect(f.jobs.acceptMigration).toHaveBeenCalledTimes(1);
    expect((await f.app.inject({...request,payload:{...request.payload,report_sha256:h(9)}})).statusCode).toBe(409);
  }finally{await f.app.close();}
});
it('fails closed when Native artifact support is absent; no bare UI boolean can accept it',async()=>{
  const f=await fixture();try{
    f.complete();f.artifacts.resolve.mockRejectedValue(new Error('missing native report'));
    const request={method:'POST' as const,url:`/search/model-migrations/${id(2)}/accept`,headers:admin,payload:{generation:2,payload_fingerprint:fp,report_sha256:h(8)}};
    expect((await f.app.inject(request)).statusCode).toBe(503);expect(f.jobs.acceptMigration).not.toHaveBeenCalled();
    expect((await f.app.inject({...request,payload:{...request.payload,validated:true}})).statusCode).toBe(400);
  }finally{await f.app.close();}
});
it('single-job activation refuses missing retained ranges or unaccepted reports before publishing',async()=>{
  const f=await fixture();try{
    const request={method:'POST' as const,url:`/search/model-migrations/${id(2)}/activate`,headers:admin,payload:{generation:2,payload_fingerprint:fp}};
    expect((await f.app.inject(request)).statusCode).toBe(409);expect(f.activate).not.toHaveBeenCalled();
    f.accepted();f.context.channels.push(id(99));
    const incomplete=await f.app.inject(request);expect(incomplete.statusCode).toBe(409);expect(incomplete.json().error.message).toContain('继续迁移剩余范围');
    expect(f.activate).not.toHaveBeenCalled();
  }finally{await f.app.close();}
});
it('does not globally activate even a complete small scope before the real ingress barrier exists',async()=>{
  const f=await fixture();try{
    f.accepted();
    const result=await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/activate`,headers:admin,payload:{generation:2,payload_fingerprint:fp}});
    expect(result.statusCode).toBe(409);expect(result.json()).toMatchObject({error:{code:'migration_finalization_pending'}});
    expect(f.activate).not.toHaveBeenCalled();
  }finally{await f.app.close();}
});
it('worker claim is a distinct fixed management capability; console users cannot claim it',async()=>{
  const f=await fixture();try{
    const request={method:'POST' as const,url:'/internal/search/model-migrations',payload:{action:'claim',worker:id(11)}};
    expect((await f.app.inject({...request,headers:admin})).statusCode).toBe(403);expect(f.jobs.claimMigration).not.toHaveBeenCalled();
    expect((await f.app.inject({...request,headers:{'x-test-service':'search'}})).json()).toEqual({lease:null});
  }finally{await f.app.close();}
});
it('authorize_write forwards only frozen source metadata to the actual lease authority and never accepts a caller URL',async()=>{
  const f=await fixture();try{
    const sample={sample_id:id(9),fingerprint:h(8),channel_id:id(1),captured_ms:Date.parse(scope.from),ordinal:'100',jpeg_sha256:h(9)};
    const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},
      payload:{action:'authorize_write',job_id:id(2),worker:id(11),generation:1,actor:'operator',payload_fingerprint:fp,source:sample}};
    expect((await f.app.inject(request)).json()).toEqual({grant:null});
    expect(f.jobs.authorizeMigrationWrite).toHaveBeenCalledWith(id(2),id(11),1,'operator',fp,f.context,sample);
    expect((await f.app.inject({...request,payload:{...request.payload,url:'http://foreign'}})).statusCode).toBe(400);
    expect((await f.app.inject({...request,payload:{...request.payload,source:{...sample,fp:h(1)}}})).statusCode).toBe(400);
  }finally{await f.app.close();}
});

it('artifact writes and finalized report reads use distinct strict authority actions',async()=>{
 const f=await fixture();try{
 const common={job_id:id(2),generation:1,actor:'operator',payload_fingerprint:fp},headers={'x-test-service':'search'};
 const read={method:'POST' as const,url:'/internal/search/model-migrations',headers,payload:{...common,action:'authorize_report_read'}};
 expect((await f.app.inject(read)).json()).toEqual({grant:null});expect(f.jobs.authorizeMigrationReportRead).toHaveBeenCalledWith(id(2),1,'operator',fp,f.context);
 expect(f.jobs.authorizeMigrationWrite).not.toHaveBeenCalled();
 expect((await f.app.inject({...read,payload:{...read.payload,worker:id(11)}})).statusCode).toBe(400);
 const artifacts={...read,payload:{...common,action:'authorize_artifacts',worker:id(11)}};
 expect((await f.app.inject(artifacts)).json()).toEqual({grant:null});expect(f.jobs.authorizeMigrationArtifacts).toHaveBeenCalledWith(id(2),id(11),1,'operator',fp,f.context);
 expect((await f.app.inject({...artifacts,payload:{...artifacts.payload,source:{sample_id:id(9)}}})).statusCode).toBe(400);
 }finally{await f.app.close();}
});

it('whole-history plans derive all sources and actual extent on the server without a browser scope or URL',async()=>{
 const f=await fixture();try{
 f.context.channels=Array.from({length:101},(_,n)=>id(n+1));f.context.extent.to_ms=f.context.extent.from_ms+60*86400000;
 const input={request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)},request={method:'POST' as const,url:'/search/model-migrations/plans',headers:admin,payload:input};
 const result=await f.app.inject(request);expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({purpose:'reencode_plan',source_count:101,progress:{total_children:4,next_partition:0}});
 const payload=f.jobs.enqueueMigrationPlan.mock.calls[0]![2];expect(payload.extent).toEqual({from_ms:f.context.extent.from_ms,to_ms:f.context.extent.to_ms,source_high_watermark:'100'});
 expect(payload).not.toHaveProperty('channel_ids');expect(JSON.stringify(payload)).not.toMatch(/http:|api_token|password/);
 expect((await f.app.inject({...request,payload:{...input,scope}})).statusCode).toBe(400);
 expect((await f.app.inject({...request,payload:{...input,url:'http://private'}})).statusCode).toBe(400);
 expect((await f.app.inject({method:'GET',url:`/search/model-migrations/${id(2)}`,headers:admin})).json().purpose).toBe('reencode_plan');
 expect((await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/cancel`,headers:admin})).json()).toEqual({cancelled:true});
 expect(f.jobs.cancelMigrationPlan).toHaveBeenCalledWith(id(2),'operator');expect(f.jobs.cancelMigration).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
it('internal plan preparation uses current catalog identities and rejects caller supplied sources',async()=>{
 const f=await fixture();try{
 await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 f.row.generation=1;
 const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},payload:{action:'plan_prepare',job_id:id(2),worker:id(11),generation:1,actor:'operator'}};
 expect((await f.app.inject(request)).json()).toEqual({prepared:false,created_ids:[],progress:null});
 expect(f.jobs.prepareMigrationPlanChildren).toHaveBeenCalledWith(id(2),id(11),1,f.context.channels,8);
 expect((await f.app.inject({...request,payload:{...request.payload,source_ids:[id(99)]}})).statusCode).toBe(400);
 const input={generation:1,payload_fingerprint:searchMigrationPlanFingerprint(f.row.payload)};
 expect((await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/activate`,headers:admin,payload:input})).json()).toMatchObject({error:{code:'migration_not_accepted'}});
 }finally{await f.app.close();}
});

it('human accepts the frozen base report while sampling stays normal, then schedules finalization without publishing',async()=>{
 const f=await fixture();try{
 await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 const parentfp=searchMigrationPlanFingerprint(f.row.payload);f.row.state='succeeded';f.row.generation=1;
 Object.assign(f.row.migration_progress,{phase:'awaiting_acceptance',next_partition:1,total_children:1,aggregate_sha256:h(6),coverage_sha256:h(7),index_manifest_sha256:h(8)});
 f.jobs.acceptMigrationPlan.mockImplementation(async(_id:any,_actor:any,proof:any)=>{f.row.migration_acceptance=proof;f.row.migration_progress.phase='ready';return true;});
 const accepted=await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/accept`,headers:admin,payload:{generation:1,payload_fingerprint:parentfp,report_sha256:h(9)}});
 expect(accepted.statusCode).toBe(200);expect(accepted.json()).toMatchObject({phase:'ready',accepted_report_sha256:h(9)});
 expect(f.jobs.requestMigrationPlanSwitch).not.toHaveBeenCalled();expect(f.jobs.requestMigrationPlanPause).not.toHaveBeenCalled();expect(f.activate).not.toHaveBeenCalled();
 f.jobs.requestMigrationPlanSwitch.mockResolvedValue(true);
 const scheduled=await f.app.inject({method:'POST',url:`/search/model-migrations/${id(2)}/activate`,headers:admin,payload:{generation:1,payload_fingerprint:parentfp}});
 expect(scheduled.json()).toMatchObject({scheduled:true});expect(f.jobs.requestMigrationPlanSwitch).toHaveBeenCalledWith(id(2),'operator',1,parentfp);expect(f.activate).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
it('a Native drain ACK uses the service identity and exact epoch proof, not a browser flag or supplied catalog',async()=>{
 const f=await fixture();try{
 const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},payload:{action:'acknowledge_pause',plan_id:id(2),worker:id(11),generation:3,epoch:id(12),observed_extent:{from_ms:Date.parse(scope.from),to_ms:Date.parse(scope.to),high_watermark:'110'}}};
 expect((await f.app.inject({...request,headers:admin})).statusCode).toBe(403);
 expect((await f.app.inject(request)).json()).toEqual({acknowledged:false});
 expect(f.jobs.acknowledgeMigrationPlanPause).toHaveBeenCalledWith(id(2),id(11),3,id(12),request.payload.observed_extent,f.context);
 expect((await f.app.inject({...request,payload:{...request.payload,drained:true}})).statusCode).toBe(400);
 expect((await f.app.inject({...request,payload:{...request.payload,source_ids:[id(1)]}})).statusCode).toBe(400);
 }finally{await f.app.close();}
});

it('rejects unapproved or pruned model packages at creation instead of enqueueing a predictably failed migration',async()=>{
 const f=await fixture();try{
 for(const patch of [{production_approval_declared:false},{pruned:true}]) {
 f.native.verifyMigrationModel.mockResolvedValueOnce({...profile(target),...patch});
 const result=await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 expect(result.statusCode).toBe(503);expect(result.json()).toMatchObject({error:{code:'migration_model_unapproved'}});expect(result.json().error.message).toContain('包级验证');
 }
 expect(f.jobs.enqueueMigrationPlan).not.toHaveBeenCalled();expect(f.jobs.enqueueMigration).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
it('only the internal service can request plan publication and its proof comes from current server artifacts',async()=>{
 const f=await fixture();try{
 await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 f.row.generation=1;const proof={aggregate_sha256:h(6)};
 f.jobs.migrationPlanChildren.mockResolvedValue({parent:f.row,children:[]} as never);f.options.planArtifacts.resolve.mockResolvedValue(proof);
 const publishPlan=vi.fn(()=>f.activate());Object.assign(f.options,{publishPlan});
 const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},payload:{action:'plan_publish',job_id:id(2),worker:id(11),generation:1,actor:'operator'}};
 expect((await f.app.inject({...request,headers:admin})).statusCode).toBe(403);expect(publishPlan).not.toHaveBeenCalled();
 expect((await f.app.inject(request)).json()).toHaveProperty('apply.id');expect(publishPlan).toHaveBeenCalledWith({job:f.row,worker:id(11),context:f.context,frozen:proof});
 expect((await f.app.inject({...request,payload:{...request.payload,frozen:proof}})).statusCode).toBe(400);
 }finally{await f.app.close();}
});
it('source restoration remains reachable when failed target runtime cannot provide an applied context',async()=>{
 const f=await fixture();try{
 await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 const restorePlan=vi.fn(()=>f.activate());Object.assign(f.options,{restorePlan,internalContext:async()=>null});
 const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},payload:{action:'plan_restore',job_id:id(2),worker:id(11),generation:0,actor:'operator'}};
 // All management generations are positive and a caller cannot inject a
 // snapshot or source address to bypass the transaction's desired CAS.
 expect((await f.app.inject(request)).statusCode).toBe(400);f.row.generation=1;request.payload.generation=1;
 expect((await f.app.inject(request)).json()).toHaveProperty('apply.id');expect(restorePlan).toHaveBeenCalledWith({job:f.row,worker:id(11)});
 expect((await f.app.inject({...request,payload:{...request.payload,source_config_version:1}})).statusCode).toBe(400);
 }finally{await f.app.close();}
});
it('an actual empty retained extent creates a zero-child plan instead of guessing a fresh model pin',async()=>{
 const f=await fixture();try{
 Object.assign(f.context.extent,{from_ms:null,to_ms:null,high_watermark:'0'});
 const response=await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({purpose:'reencode_plan',phase:'preparing',extent:{from_ms:null,to_ms:null,source_high_watermark:'0'},progress:{total_children:0,next_partition:0}});
 expect(f.activate).not.toHaveBeenCalled();expect(f.jobs.requestMigrationPlanPause).not.toHaveBeenCalled();
 }finally{await f.app.close();}
});
it('migration list/context are bounded human-only metadata and keep implementation readiness separate from the source pin',async()=>{
 const f=await fixture();try{
 expect((await f.app.inject({url:'/search/model-migrations',headers:{'x-test-service':'search'}})).statusCode).toBe(401);
 const context=await f.app.inject({url:'/search/model-migrations/context',headers:admin});
 expect(context.json()).toEqual({source,execution_available:false,reason:'migration_executor_pending'});
 await f.app.inject({method:'POST',url:'/search/model-migrations/plans',headers:admin,payload:{request_id:id(30),target_package_id:'target',acceptance_criteria_sha256:h(5)}});
 const response=await f.app.inject({url:'/search/model-migrations',headers:admin});expect(response.json().items).toHaveLength(1);
 expect(f.jobs.listMigrationPlans).toHaveBeenCalledWith('operator',8);expect(JSON.stringify(response.json())).not.toMatch(/lease_owner|lease_until|api_token|password|resolved_path/);
 }finally{await f.app.close();}
});
it('Native can reject an exact pause epoch without inventing a waterline or needing an applied model',async()=>{
 const f=await fixture();try{
 Object.assign(f.options,{internalContext:async()=>null});
 const input={action:'pause_rejected',plan_id:id(2),worker:id(11),generation:3,epoch:id(12),error_code:'source_writer_uncertain'};
 const request={method:'POST' as const,url:'/internal/search/model-migrations',headers:{'x-test-service':'search'},payload:input};
 expect((await f.app.inject({...request,headers:admin})).statusCode).toBe(403);
 expect((await f.app.inject(request)).json()).toEqual({rejected:false});
 expect(f.jobs.abortMigrationPlanSwitch).toHaveBeenCalledWith(id(2),id(11),3,'source_writer_uncertain',{expectedEpoch:id(12),unacknowledgedOnly:true});
 expect((await f.app.inject({...request,payload:{...input,observed_extent:{from_ms:null,to_ms:null,high_watermark:'0'}}})).statusCode).toBe(400);
 expect((await f.app.inject({...request,payload:{...input,error_code:'source_write_unknown'}})).statusCode).toBe(400);
 }finally{await f.app.close();}
});
