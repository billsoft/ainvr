import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {configRoutes} from '../routes/config.js';
import type {ConfigRoutesOptions} from '../routes/configPolicy.js';
import {prepareSearchModelMigrationPlanActivation,prepareSearchModelMigrationPlanRestore} from '../services/searchModelMigrationActivation.js';
vi.mock('../services/searchModelMigrationActivation.js',async original=>({...await original<typeof import('../services/searchModelMigrationActivation.js')>(),
 prepareSearchModelMigrationPlanActivation:vi.fn(async()=>undefined),prepareSearchModelMigrationPlanRestore:vi.fn(async()=>undefined)}));
type Bindings=Parameters<NonNullable<NonNullable<ConfigRoutesOptions['searchMigrations']>['onPlanApplyReady']>>[0];
const h=(s:string)=>s.repeat(64),id='00000000-0000-4000-8000-000000000001';
async function fixture(stall=false){
 const app=Fastify(),client={query:vi.fn()},calls:any[]=[];
 const store={getDocument:async()=>null,listServiceStates:async()=>[{serviceName:'search-service',desiredVersion:2,appliedVersion:2,status:'applied'}]};
 const publish=vi.fn(async(_summary:string,_actor:string,options:any)=>{calls.push(options);await options.prepare(client);
   if(stall&&calls.length===1)await new Promise<void>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
   return {version:{version:2},results:[{ok:true}]};});
 let bindings:Bindings|undefined;
 const migration={principal:async()=>null,internalPrincipal:async()=>false,jobs:{} as any,context:async()=>({revision:h('a'),storage_generation:h('b'),desired_version:1,source:{package_id:'source',package_sha256:h('c'),model_version:`search-v1-${h('c')}`},channels:[id],extent:{source_model:'source',from_ms:0,to_ms:1,high_watermark:'1'}}),
 native:{} as any,artifacts:{} as any,planArtifacts:{} as any,executionAvailable:()=>false,prepareActivation:vi.fn(),activationStore:{} as any,onPlanApplyReady:(value:Bindings)=>{bindings=value;}};
 await app.register(configRoutes,{pgStore:store as any,orchestrator:{publish} as any,searchMigrations:migration});await app.ready();
 const job:any={id,actor:'human',generation:1,state:'running',lease_owner:id,lease_until:new Date(Date.now()+30000),expires_at:new Date(Date.now()+3600000),
 migration_progress:{schema_version:'search-reencode-plan-progress-v1',payload_fingerprint:h('d'),phase:'publishing',active_round:1,next_partition:0,total_children:0,
 aggregate_sha256:h('e'),coverage_sha256:h('f'),index_manifest_sha256:h('1'),switch_deadline_ms:Date.now()+120000}};
 return {app,client,publish,calls,bindings:bindings!,job};
}
// Real PG prepare/COMMIT compensation is exercised separately by PublishPg.
// These fixtures isolate shared ConfigApply identity/lifetime, without service
// HTTP, model execution or a simulated alternate publisher.
it('provides the same ConfigApply publication to the in-process coordinator and human apply endpoint',async()=>{
 const f=await fixture();try{
 await f.bindings.publish(f.job,{} as never,new AbortController().signal);
 expect(f.publish).toHaveBeenCalledOnce();expect(f.calls[0].services).toEqual(['search-service']);
 expect(prepareSearchModelMigrationPlanActivation).toHaveBeenCalledWith(f.client,expect.objectContaining({job:f.job,worker:id}));
 const response=await f.app.inject({url:'/v1/config/apply'});expect(response.json().data.status).toBe('succeeded');
 }finally{await f.app.close();}
});
it('a cancelled migration releases the same apply operation before its independent restore starts',async()=>{
 const f=await fixture(true),stop=new AbortController();try{
 const pending=f.bindings.publish(f.job,{} as never,stop.signal),handled=expect(pending).rejects.toThrow();
 while(f.calls.length===0)await new Promise(resolve=>setTimeout(resolve,1));
 const overlap=await f.app.inject({method:'POST',url:'/v1/config/apply',payload:{changes:[{service:'search-service',group:'system',name:'settings',config:{}}]}});
 expect(overlap.statusCode).toBe(409);stop.abort();await handled;expect(f.calls[0].signal.aborted).toBe(true);
 await f.bindings.restore(f.job,AbortSignal.timeout(1000));expect(f.publish).toHaveBeenCalledTimes(2);
 expect(prepareSearchModelMigrationPlanRestore).toHaveBeenCalledWith(f.client,expect.objectContaining({job:f.job,worker:id}));
 }finally{stop.abort();await f.app.close();}
});
