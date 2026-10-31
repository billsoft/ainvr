import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {flowRoutes} from '../routes/flowRoutes.js';
afterEach(()=>vi.unstubAllGlobals());
it('preserves measured time across multiple zones and binding version pieces without duplicating directions',async()=>{
 const counter={counter_id:'ship',name:'ship',labels:[{label_id:'person',name:'person'}],method:'line',outputs:'both',names:{in:'in',out:'out'},occupancy:false,max_gap_ms:1000,state:'enabled',version:1};
 const from='2026-10-01T00:00:00.000Z',mid='2026-10-01T01:00:00.000Z',to='2026-10-01T02:00:00.000Z';
 const direction={kind:'line',edge:'edge',in_side:'inward'};
 const row={counter_id:'ship',binding_id:'b0',active:true,counting:true,source_id:'camera',zone_name:'zone',created_at:new Date(from),updated_at:new Date(from),versions:[{seq:1,effective_from:from,direction,reclassify:false},{seq:2,effective_from:mid,direction,reclassify:false}],document:{processor_id:'ai',zone_id:'z',direction}};
 vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{
  const request=JSON.parse(opts.body);
  return new Response(JSON.stringify({items:request.series.map((s:any)=>({key:s.key,occurrences:1,tracked_targets:1,coverage:{state:'partial',gaps:[],expected_ms:3600000,covered_ms:1800000,ratio:.5,tolerated_ms:0,intervals:[{from:s.from,to:new Date(Date.parse(s.from)+1800000).toISOString()}],expected_intervals:[{from:s.from,to:s.to}]},buckets:[]}))}),{status:200,headers:{'content-type':'application/json'}});
 }));
 const app=Fastify();
 await app.register(flowRoutes,{store:{listCounters:async()=>[counter],counterBindings:async()=>[row,{...row,binding_id:'b1',document:{...row.document,zone_id:'z1'}}],definitionHistory:async()=>[{counter_id:'ship',version:1,labels:counter.labels,document:counter,created_at:new Date(from)}],armingHistory:async()=>[{source_id:'camera',revision:1,current_revision:1,created_at:new Date(from),binding_ids:['b0','b1']}]} as any,principal:async()=> 'operator',catalog:async()=>null,synchronization:null,connection:async()=>({baseUrl:'http://127.0.0.1:8099',apiToken:'a'.repeat(32),timeoutMs:1000}) as any});
 try{
  const response=await app.inject({method:'POST',url:'/flow/query',payload:{counter_ids:['ship'],from,to,bucket:'hour',timezone:'Asia/Shanghai'}});
  expect(response.statusCode).toBe(200);
  const item=response.json().items[0];
  expect(item.in.coverage).toBe('partial');
  expect(item.in.coverage_details).toMatchObject({expected_ms:14400000,covered_ms:7200000,ratio:.5,basis:'binding_time'});
  expect(item.zones).toHaveLength(2);
  const zone=item.zones[0];
  for(const output of ['in','out']){
   expect(zone[output].coverage).toMatchObject({state:'partial',expected_ms:7200000,covered_ms:3600000,ratio:.5,tolerated_ms:0});
   expect(zone[output].coverage.expected_intervals).toEqual([{from,to:mid},{from:mid,to}]);
   expect(zone[output].coverage.intervals).toHaveLength(2);
  }
 }finally{await app.close()}
});
