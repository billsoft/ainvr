import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {flowRoutes} from '../routes/flowRoutes.js';
afterEach(()=>vi.unstubAllGlobals());
it.each([
 [['unknown','unknown'],'unknown'],[['complete','unknown'],'unknown'],[['no_data','unknown'],'unknown'],
 [['partial','unknown'],'partial'],[['complete','complete'],'complete'],[['no_data','no_data'],'no_data'],[['complete','no_data'],'partial']
])('preserves coverage semantics across zone and counter aggregation: %j',async(states,expected)=>{
 const counter={counter_id:'ship',name:'ship',labels:[{label_id:'person',name:'person'}],method:'line',outputs:'in',names:{in:'in',out:'out'},occupancy:false,max_gap_ms:1000,state:'enabled',version:1};
 const rows=(states as string[]).map((_,i)=>({counter_id:'ship',binding_id:`b${i}`,active:true,counting:true,source_id:'camera',zone_name:`zone${i}`,created_at:new Date('2026-10-01T00:00:00Z'),updated_at:new Date('2026-10-01T00:00:00Z'),versions:[],document:{processor_id:'ai',zone_id:`z${i}`,direction:{kind:'line',edge:'edge',in_side:'inward'}}}));
 const app=Fastify();
 vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{
  const request=JSON.parse(opts.body);
  return new Response(JSON.stringify({items:request.series.map((s:any)=>({key:s.key,occurrences:3,tracked_targets:1,coverage:{state:states[Number(s.key.slice(1,2))],gaps:[]},buckets:[]}))}),{status:200,headers:{'content-type':'application/json'}});
 }));
 await app.register(flowRoutes,{store:{listCounters:async()=>[counter],counterBindings:async()=>rows,definitionHistory:async()=>[]} as any,principal:async()=> 'operator',catalog:async()=>null,synchronization:null,connection:async()=>({baseUrl:'http://127.0.0.1:8099',apiToken:'a'.repeat(32),timeoutMs:1000}) as any});
 try{
  const response=await app.inject({method:'POST',url:'/flow/query',payload:{counter_ids:['ship'],from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',totals_only:true}});
  expect(response.statusCode).toBe(200);const item=response.json().items[0];
  expect(item.in.occurrences).toBe(6);expect(item.in.coverage).toBe(expected);
  expect(item.zones.map((z:any)=>z.in.coverage.state)).toEqual(states);
 }finally{await app.close()}
});