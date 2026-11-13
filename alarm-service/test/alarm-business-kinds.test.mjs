import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {normalizeAnalytics} from '../src/alarm-analytics.mjs';
const scope={from:'2026-11-12T00:00:00.000Z',to:'2026-11-13T00:00:00.000Z',timezone:'Asia/Shanghai',bucket:'hour'};
test('business categories are independent from trigger stages and reject unknown filters',()=>{
 assert.equal(normalizeAnalytics({...scope,event_kind:'fire_smoke',primary_type:'appearance'}).event_kind,'fire_smoke');
 assert.throws(()=>normalizeAnalytics({...scope,event_kind:'random'}));
});
test('Mongo business filter, aggregation, catalog and list agree including legacy vehicle hits',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});
 await client.connect();const db=client.db('ainvr_business_test_'+randomUUID().replaceAll('-',''));
 try{
  const repository=new AlarmRepository(db,{clock:()=>scope.to});await repository.initialize();
  const record=(id,extra={})=>({alarm_id:id,dedup_key:id,channel_id:'camera',occurred_at:scope.from,ingested_at:scope.from,behavior:'appearance',rule:{id:'r',version:1,snapshot:{zone_id:'z'}},handling:{state:'unacknowledged',revision:0},...extra});
  await repository.events.insertMany([record('legacy'),record('fire',{event_kind:'fire_smoke'}),record('helmet',{event_kind:'helmet_violation'}),record('plate',{analysis_evidence:{vehicle:{reason:'watchlist_match'}}}),record('ocr-only',{analysis_evidence:{vehicle:{reason:'ocr_candidate'}}})]);
  for(const [kind,expected]of [['spatial',2],['fire_smoke',1],['helmet_violation',1],['vehicle_watchlist',1],['face_watchlist',0]]){
   const query={...scope,event_kind:kind};const stats=await repository.analytics(query);const list=await repository.list({status:'all',analytics:JSON.stringify(query)});
   assert.equal(stats.total,expected);assert.equal(stats.event_kind,kind);assert.equal(list.items.length,expected);
   assert.ok(list.items.every(item=>item.event_kind===kind));
   assert.ok(list.items.every(item=>!Object.hasOwn(item,'analysis_evidence')));
   const ordinary=await repository.list({status:'all',event_kind:kind});
   assert.equal(ordinary.items.length,expected);assert.ok(ordinary.items.every(item=>item.event_kind===kind));
   assert.ok(stats.catalog.event_kinds.includes('fire_smoke'));
  }
  assert.equal((await repository.analytics(scope)).total,5);
  await assert.rejects(repository.list({event_kind:'unknown'}));
 }finally{await db.dropDatabase();await client.close();}
});
