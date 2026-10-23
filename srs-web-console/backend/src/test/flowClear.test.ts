import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {flowRoutes} from '../routes/flowRoutes.js';
import {countingPieces} from '../store/flowCounters.js';
afterEach(()=>vi.unstubAllGlobals());
it('clear validates ownership and forwards a frozen explicit scope with authenticated actor',async()=>{
 const app=Fastify(),fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({cleared:true}),{status:200,headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',fetcher);
 await app.register(flowRoutes,{store:{listCounters:async()=>[{counter_id:'ship'}],counterBindings:async()=>[{counter_id:'ship',binding_id:'old',active:false},{counter_id:'ship',binding_id:'new',active:true}],definitionHistory:async()=>[]} as any,principal:async()=> 'operator',catalog:async()=>null,synchronization:null,connection:async()=>({baseUrl:'http://127.0.0.1:8099',apiToken:'a'.repeat(32),timeoutMs:1000}) as any});
 const payload={binding_ids:['old'],from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z'},headers={'idempotency-key':'clear-1'};
 try{
  const invalid=await app.inject({method:'POST',url:'/flow/counters/ship/clear',headers,payload:{...payload,binding_ids:['foreign']}});expect(invalid.statusCode).toBe(422);expect(fetcher).not.toHaveBeenCalled();
  const valid=await app.inject({method:'POST',url:'/flow/counters/ship/clear',headers,payload});expect(valid.statusCode).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({counter_id:'ship',rule_ids:['old'],from:'2026-10-01T00:00:00.000Z',to:'2026-10-02T00:00:00.000Z'});
  expect(fetcher.mock.calls[0]![1].headers['x-ainvr-actor']).toBe('operator');
 }finally{await app.close()}
});
it('removed associations retain only their active historical interval; new bindings cannot backdate rows',()=>{
 const binding={created_at:'2026-10-02T00:00:00Z',updated_at:'2026-10-03T00:00:00Z',active:false};
 const versions=[{seq:1,direction:{kind:'line' as const,edge:'a',in_side:'inward' as const},reclassify:false,effective_from:binding.created_at}],defs=[{labels:[{label_id:'person'}],created_at:binding.created_at}];
 expect(countingPieces(binding,versions,defs,{from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z'})).toEqual([]);
 expect(countingPieces(binding,versions,defs,{from:'2026-10-03T00:00:00Z',to:'2026-10-04T00:00:00Z'})).toEqual([]);
 expect(countingPieces(binding,versions,defs,{from:'2026-10-01T00:00:00Z',to:'2026-10-04T00:00:00Z'})).toMatchObject([{from:'2026-10-02T00:00:00.000Z',to:'2026-10-03T00:00:00.000Z'}]);
});
