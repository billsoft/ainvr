import test from 'node:test';
import assert from 'node:assert/strict';
import {AlarmRepository} from '../src/repository.mjs';
import {createApp} from '../src/http.mjs';

const input={from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',locations:[{channel_id:'a',zone_id:'x'},{channel_id:'b',zone_id:'y'},{channel_id:'a',zone_id:'x'}]};
const token='test-token-'.repeat(5);
test('range statistics builds one bounded aggregate with exact paired stage predicates',async()=>{
 let pipeline,options;
 const events={aggregate:(p,o)=>{pipeline=p;options=o;return {toArray:async()=>[{total:[{count:2}],handling:[{_id:'acknowledged',count:1},{_id:'unacknowledged',count:1}],review:[{_id:'queued',count:2}],unassociated:[{count:1}]}]}}};
 const repo=new AlarmRepository({collection:()=>events},{clock:()=> '2026-10-03T00:00:00.000Z'});
 const result=await repo.statistics(input);
 assert.deepEqual(result,{total:2,as_of:'2026-10-03T00:00:00.000Z',handling:{acknowledged:1,unacknowledged:1},review:{queued:2},association:{unassociated:1}});
 assert.equal(options.maxTimeMS,3000);
 assert.deepEqual(pipeline[0].$match, {ingested_at:{$lte:result.as_of},occurred_at:{$gte:'2026-10-01T00:00:00.000Z',$lt:'2026-10-02T00:00:00.000Z'},channel_id:{$in:['a','b']}});
 assert.deepEqual(pipeline[1].$facet.total[0].$match,{$or:[
  {channel_id:'a',$or:[{'rule.snapshot.zone_id':'x'},{'stages.zone_id':'x'}]},
  {channel_id:'b',$or:[{'rule.snapshot.zone_id':'y'},{'stages.zone_id':'y'}]}
 ]});
 assert.ok(pipeline.some(p=>p.$facet));
});
test('statistics rejects missing, invalid, oversized and unsupported scope',async()=>{
 const repo=new AlarmRepository({collection:()=>({})});
 for(const data of [{...input,from:'bad'},{...input,to:input.from},{...input,to:'2026-11-02T00:00:00Z'},{...input,locations:[]},{...input,locations:Array(101).fill(input.locations[0])},{...input,locations:[{channel_id:'a',zone_id:''}]},{...input,other:1},null]){
  await assert.rejects(()=>repo.statistics(data));
 }
});
test('statistics HTTP requires management auth and routes to statistics',async()=>{
 let seen;
 const app=createApp({apiToken:token,repository:{statistics:async x=>(seen=x,{total:3,as_of:'now'}),get:async()=>{throw Error('wrong route')}}});
 try{
  assert.equal((await app.inject({method:'POST',url:'/v1/events/statistics',payload:input})).statusCode,401);
  const r=await app.inject({method:'POST',url:'/v1/events/statistics',headers:{authorization:'Bearer '+token},payload:input});
  assert.equal(r.statusCode,200);assert.equal(r.json().total,3);assert.deepEqual(seen,input);
 }finally{await app.close()}
});


test('exactly 31 days is accepted and an empty aggregate returns zero',async()=>{
 let match;
 const events={aggregate:p=>{match=p[0].$match;return {toArray:async()=>[{total:[],handling:[],review:[]}]}}};
 const repo=new AlarmRepository({collection:()=>events},{clock:()=> '2026-12-01T00:00:00.000Z'});
 assert.deepEqual(await repo.statistics({...input,to:'2026-11-01T00:00:00Z'}),{total:0,as_of:'2026-12-01T00:00:00.000Z',handling:{},review:{},association:{unassociated:0}});
 assert.equal(match.occurred_at.$lt,'2026-11-01T00:00:00.000Z');
});
test('aggregation failure is propagated rather than reported as zero',async()=>{
 const repo=new AlarmRepository({collection:()=>({aggregate:()=>({toArray:async()=>{throw Error('database unavailable')}})})});
 await assert.rejects(()=>repo.statistics(input),/database unavailable/);
});
