import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {queryAlarmAnalytics,ANALYTICS_LIMITS} from '../src/alarm-analytics.mjs';
test('Mongo: pending ages, sufficient percentile sample, invalid human times and exact capacity boundary',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27029',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 const now='2026-12-01T00:00:00.000Z',at='2026-11-30T01:00:00.000Z';
 try{
  const repo=new AlarmRepository(db,{clock:()=>now});await repo.initialize();
  const event=(id,occurred_at,handling)=>({alarm_id:id,dedup_key:id,channel_id:'a',occurred_at,ingested_at:now,behavior:'appearance',rule:{id:'r',version:1,snapshot:{zone_id:'x'}},handling});
  const rows=[599999,600000,3599999,3600000].map((age,i)=>event('age'+i,new Date(Date.parse(now)-age).toISOString(),{state:'unacknowledged'}));
  for(let i=1;i<=20;i++)rows.push(event('human'+i,at,{state:'acknowledged',reviewed_by_kind:'human',disposition:'handled',acknowledged_at:new Date(Date.parse(at)+i*1000).toISOString()}));
  for(const [i,bad] of [null,'bad','2026-12-02T00:00:00Z'].entries())rows.push(event('invalid'+i,at,{state:'acknowledged',reviewed_by_kind:'human',disposition:'handled',acknowledged_at:bad}));
  await repo.events.insertMany(rows);
  const q={from:'2026-11-30T00:00:00.000Z',to:now,timezone:'UTC',bucket:'hour'};
  const r=await queryAlarmAnalytics(repo,q,{limits:{...ANALYTICS_LIMITS,facts:rows.length}});
  assert.equal(r.total,27);assert.deepEqual(r.quality.pending_age,{lt10m:1,lt1h:2,gte1h:1});assert.deepEqual(r.quality.wait,{samples:20,unknown:3,median_ms:10500,p90_ms:18000});
  await assert.rejects(()=>queryAlarmAnalytics(repo,q,{limits:{...ANALYTICS_LIMITS,facts:rows.length-1}}),e=>e.code==='analytics_capacity');
 }finally{try{await db.dropDatabase()}finally{await client.close()}}
});
