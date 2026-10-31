import {afterEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {applicableCoverage,bindingApplicability,type DefinitionVersion,type ArmingMembershipVersion} from '../store/flowCounters.js';
import {flowRoutes} from '../routes/flowRoutes.js';
afterEach(()=>vi.unstubAllGlobals());
const at=(hour:number)=>new Date(Date.UTC(2026,9,1,hour)).toISOString();
const window={from:at(0),to:at(3)},labels=[{label_id:'person'}];
const definitions:DefinitionVersion[]=[
 {version:1,created_at:at(0),labels,document:{state:'enabled'}},
 {version:2,created_at:at(1),labels,document:{state:'paused'}},
 {version:3,created_at:at(2),labels,document:{state:'enabled'}},
];
const arming:ArmingMembershipVersion[]=[{source_id:'camera',revision:1,current_revision:1,created_at:at(0),binding_ids:['flow-door']}];
it('excludes proven pauses and unions overlapping observation segments without changing facts',()=>{
 const proof=bindingApplicability('flow-door',definitions,arming,window,3);
 expect(proof).toEqual({expected_intervals:[{from:at(0),to:at(1)},{from:at(2),to:at(3)}],unknown_ms:0,qualifier:'persisted_configuration'});
 const result=applicableCoverage({state:'partial',gaps:[],intervals:[window,{from:at(0),to:at(1)}]},proof);
 expect(result).toMatchObject({state:'partial',expected_ms:7200000,covered_ms:7200000,ratio:1,qualifier:'persisted_configuration'});
});
it('uses arming snapshots to exclude an earlier unbound interval after reactivation',()=>{
 const history=[{...arming[0],current_revision:3},{...arming[0],revision:2,current_revision:3,created_at:at(1),binding_ids:[]},
  {...arming[0],revision:3,current_revision:3,created_at:at(2)}];
 const proof=bindingApplicability('flow-door',[definitions[0]],history,window,1);
 expect(proof.expected_intervals).toEqual([{from:at(0),to:at(1)},{from:at(2),to:at(3)}]);
});
it('marks missing definitions, absent legacy membership and discontinuous history as unknown',()=>{
 for(const [defs,arms,current] of [
  [[],arming,1],[definitions,[{...arming[0],binding_ids:null}],3],
  [[definitions[0],definitions[2]],arming,3],
  [[definitions[0]],[{...arming[0],current_revision:3},{...arming[0],revision:3,current_revision:3,created_at:at(2)}],1],
 ] as [DefinitionVersion[],ArmingMembershipVersion[],number][]){
  const proof=bindingApplicability('flow-door',defs,arms,window,current);
  expect(proof.unknown_ms).toBeGreaterThan(0);
  expect(applicableCoverage({gaps:[],intervals:[window]},proof)).toMatchObject({expected_ms:null,covered_ms:null,ratio:null,qualifier:'applicability_history_incomplete'});
  expect(applicableCoverage({gaps:[],intervals:[window]},proof).expected_intervals).toBeUndefined();
 }
});
it('does not infer missing early history or unsupported schedules, and proves paused periods not applicable',()=>{
 const late=[{...definitions[0],created_at:at(1)}];
 expect(bindingApplicability('flow-door',late,arming,window,1).unknown_ms).toBe(3600000);
 const schedule=[{...definitions[0],document:{state:'enabled',schedule:{mode:'weekly'}}}];
 expect(bindingApplicability('flow-door',schedule,arming,window,1).unknown_ms).toBe(10800000);
 const paused=[{...definitions[0],document:{state:'paused'}}];
 const result=applicableCoverage({gaps:[],intervals:[window]},bindingApplicability('flow-door',paused,[],window,1));
 expect(result).toMatchObject({expected_ms:0,covered_ms:0,ratio:null,qualifier:'persisted_configuration'});
});
it('preserves raw count series through paused periods while correcting only measured coverage',async()=>{
 const counter={counter_id:'people',name:'People',labels:[{label_id:'person',name:'Person'}],method:'line',outputs:'in',names:{in:'In',out:'Out'},occupancy:false,max_gap_ms:1000,state:'enabled',version:3};
 const row={binding_id:'flow-door',counter_id:'people',source_id:'camera',active:true,counting:true,created_at:new Date(at(0)),updated_at:new Date(at(0)),versions:[],
  document:{zone_id:'zone',processor_id:'ai',direction:{kind:'line',edge:'edge',in_side:'inward'}}};
 const requests:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{
  const request=JSON.parse(opts.body);requests.push(request);
  return new Response(JSON.stringify({items:request.series.map((s:any)=>({key:s.key,occurrences:7,tracked_targets:1,buckets:[],
   coverage:{state:'complete',gaps:[],expected_ms:Date.parse(s.to)-Date.parse(s.from),covered_ms:Date.parse(s.to)-Date.parse(s.from),intervals:[{from:s.from,to:s.to}],expected_intervals:[{from:s.from,to:s.to}]}}))}),
   {headers:{'content-type':'application/json'}});
 }));
 const store={listCounters:async()=>[counter],counterBindings:async()=>[row],definitionHistory:async()=>definitions.map(v=>({...v,counter_id:'people'})),armingHistory:async()=>arming};
 const app=Fastify();await app.register(flowRoutes,{store:store as any,principal:async()=> 'operator',catalog:async()=>null,synchronization:null,
  connection:async()=>({baseUrl:'http://127.0.0.1:8099',apiToken:'x'.repeat(32),timeoutMs:1000})});
 try{
  const response=await app.inject({method:'POST',url:'/flow/query',payload:{counter_ids:['people'],...window,bucket:'hour'}});
  expect(response.statusCode,response.body).toBe(200);
  expect(requests[0].series.some((s:any)=>s.from===at(1)&&s.to===at(2))).toBe(true);
  const item=response.json().items[0];
  expect(item.in.occurrences).toBe(21);
  expect(item.in.coverage_details).toMatchObject({expected_ms:7200000,covered_ms:7200000,ratio:1,qualifier:'persisted_configuration'});
  expect(item.zones[0].in.coverage.expected_intervals).toEqual([{from:at(0),to:at(1)},{from:at(2),to:at(3)}]);
  store.armingHistory=async()=>[];
  const unknown=await app.inject({method:'POST',url:'/flow/query',payload:{counter_ids:['people'],...window,bucket:'hour'}});
  expect(unknown.json().items[0].in.occurrences).toBe(21);
  expect(unknown.json().items[0].in.coverage_details).toMatchObject({expected_ms:null,covered_ms:null,ratio:null,qualifier:'applicability_history_incomplete'});
 }finally{await app.close()}
});
