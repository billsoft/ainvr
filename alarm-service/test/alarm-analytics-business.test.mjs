import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {analyticsPipeline,analyticsFilter,businessKindExpression,normalizeAnalytics,queryAlarmAnalytics,BUSINESS_KINDS} from '../src/alarm-analytics.mjs';

const scope={from:'2026-11-12T00:00:00.000Z',to:'2026-11-13T00:00:00.000Z',timezone:'Asia/Shanghai',bucket:'hour'};
test('business facet uses the complete selected scope without unwinding stage associations',()=>{
 const q=normalizeAnalytics({...scope,event_kind:'fire_smoke',primary_type:'appearance',locations:[{channel_id:'camera',zone_id:'z'}],trigger_id:'t',audit:'pending',weekday:3,hour:8});
 const facet=analyticsPipeline(q,scope.to).at(-1).$facet;
 assert.deepEqual(facet.business_kinds,[{$match:analyticsFilter(q)},{$group:{_id:businessKindExpression(),total:{$sum:1}}},{$sort:{total:-1,_id:1}},{$limit:33}]);
 assert.deepEqual(facet.business_kinds[0],facet.summary[0]);
});

test('Mongo business facet counts each selected event once and preserves every filter', {skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27029',{serverSelectionTimeoutMS:3000});
 await client.connect();
 const db=client.db('ainvr_analytics_business_test_'+randomUUID().replaceAll('-',''));
 try{
  // Exercise the real pipeline with an isolated collection, without changing
  // or depending on another agent's repository implementation.
  const events=db.collection('events');
  await events.createIndex({occurred_at:-1,alarm_id:-1});
  const repo={clock:()=>scope.to,events,listRules:async()=>[]};
  const event=(id,extra={})=>({alarm_id:id,channel_id:'camera',occurred_at:scope.from,ingested_at:scope.from,behavior:'appearance',trigger_id:'t',rule:{id:'t',version:1,snapshot:{zone_id:'z'}},handling:{state:'unacknowledged'},...extra});
  await events.insertMany([
   ...BUSINESS_KINDS.map(kind=>event(kind,{event_kind:kind,stages:[{zone_id:'z',trigger_id:'t'},{zone_id:'z',trigger_id:'t'},{zone_id:'other',trigger_id:'other'}]})),
   event('legacy-spatial'),event('legacy-vehicle',{analysis_evidence:{vehicle:{reason:'watchlist_match'}}}),
   event('ocr',{analysis_evidence:{vehicle:{reason:'ocr_candidate'}}}),
   event('fire-human',{event_kind:'fire_smoke',handling:{state:'acknowledged',reviewed_by_kind:'human',disposition:'handled'}}),
   event('fire-other-channel',{event_kind:'fire_smoke',channel_id:'other'}),
   event('fire-enter',{event_kind:'fire_smoke',behavior:'region_enter'}),
   event('fire-cross-association',{event_kind:'fire_smoke',trigger_id:'other',stages:[{zone_id:'other',trigger_id:'t'}]}),
   event('fire-later',{event_kind:'fire_smoke',occurred_at:'2026-11-12T01:00:00.000Z'}),
   event('fire-no-zone',{event_kind:'fire_smoke',rule:{id:'t',version:1,snapshot:{}}}),
   event('before',{event_kind:'fire_smoke',occurred_at:'2026-11-11T23:59:59.999Z'}),
   event('end',{event_kind:'fire_smoke',occurred_at:scope.to}),
   event('late-ingest',{event_kind:'fire_smoke',ingested_at:'2026-11-13T00:00:00.001Z'}),
  ]);
  const all=await queryAlarmAnalytics(repo,scope);
  assert.equal(all.total,18);
  assert.equal(all.business_kinds.reduce((sum,r)=>sum+r.total,0),all.total);
  assert.equal(all.business_kinds.find(r=>r.id==='spatial').total,3);
  assert.equal(all.business_kinds.find(r=>r.id==='vehicle_watchlist').total,2);
  assert.equal(all.business_kinds.find(r=>r.id==='fire_smoke').total,7);
  const scopes=[scope,
   {...scope,locations:[{channel_id:'camera',zone_id:'z'}],trigger_id:'t',audit:'pending',primary_type:'appearance',weekday:3,hour:8},
   {...scope,association:'unassociated'},
   {...scope,from:'2026-11-12T01:00:00.000Z'},
   {...scope,weekday:4},
  ];
  for(const q of scopes){
   const r=await queryAlarmAnalytics(repo,q);
   assert.equal(r.business_kinds.reduce((sum,x)=>sum+x.total,0),r.total);
   for(const kind of BUSINESS_KINDS){
    const filter={...q,event_kind:kind},selected=await queryAlarmAnalytics(repo,filter);
    const expected=r.business_kinds.find(x=>x.id===kind)?.total??0;
    assert.equal(selected.total,expected,JSON.stringify(filter));
    assert.deepEqual(selected.business_kinds,expected?[{id:kind,total:expected}]:[]);
    assert.equal(await events.countDocuments(analyticsFilter(normalizeAnalytics(filter),scope.to)),expected);
   }
  }
  const selected=await queryAlarmAnalytics(repo,{...scopes[1],event_kind:'fire_smoke'});
  assert.equal(selected.total,1,'same-stage association, audit, time and primary type all apply');
  assert.deepEqual(selected.business_kinds,[{id:'fire_smoke',total:1}]);
  assert.deepEqual((await queryAlarmAnalytics(repo,{...scope,weekday:4})).business_kinds,[]);
 }finally{try{await db.dropDatabase()}finally{await client.close()}}
});
