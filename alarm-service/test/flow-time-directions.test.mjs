import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {FlowStatistics} from '../src/flow-statistics.mjs';
test('Mongo angle endpoints, unknown direction, local midnight and DST use the same series filters',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028');await client.connect();const db=client.db('ainvr_flow_boundaries_'+randomUUID().replaceAll('-',''));
 try{
  const service=new FlowStatistics(db);await service.initialize();
  const one=async(series,extra={})=>(await service.query({series:[series],...extra})).items[0];
  const series={key:'in',rule_id:'a',label_ids:['person'],filter:{kind:'angle',entry:{from:315,to:45},exit:{from:90,to:180}},from:'2026-10-21T00:00:00Z',to:'2026-10-21T01:00:00Z'};
  const fact=(id,time,entry)=>({event_id:id,rule_id:'a',rule_version:1,counter_id:'c',event_type:'region_traverse',label_id:'person',track_id:'same',stream_session_id:'s',occurred_at:time,quality:{trajectory_complete:true},direction:{entry_side_deg:entry,exit_side_deg:90}});
  await service.facts.insertMany([315,0,44.999,45,null].map((angle,i)=>fact(String(i),'2026-10-21T00:10:00.000Z',angle)));
  const wrap=await one(series);assert.equal(wrap.occurrences,3);assert.equal(wrap.tracked_targets,1);
  assert.equal((await one({...series,filter:{...series.filter,entry:{from:360,to:45}}})).occurrences,2);
  assert.equal((await one({...series,filter:{...series.filter,exit:{from:0,to:90}}})).occurrences,0);
  await service.facts.insertMany([fact('midnight-before','2026-10-20T15:59:00.000Z',0),fact('midnight-after','2026-10-20T16:01:00.000Z',0)]);
  const midnight=await one({...series,from:'2026-10-20T15:00:00Z',to:'2026-10-20T17:00:00Z'},{bucket:'day',timezone:'Asia/Shanghai'});
  assert.equal(midnight.buckets.length,2);assert.equal(midnight.buckets[0].to,'2026-10-20T16:00:00.000Z');
  await service.facts.insertMany([fact('dst-before','2026-11-01T05:30:00.000Z',0),fact('dst-after','2026-11-01T06:30:00.000Z',0)]);
  const dst={...series,from:'2026-11-01T04:00:00Z',to:'2026-11-02T05:00:00Z'};
  const hours=await one(dst,{bucket:'hour',timezone:'America/New_York'});
  assert.equal(hours.buckets.length,2);assert.notEqual(hours.buckets[0].from,hours.buckets[1].from);
  const day=await one(dst,{bucket:'day',timezone:'America/New_York'});
  assert.equal(day.occurrences,2);assert.equal(day.buckets.length,1);assert.equal(Date.parse(day.buckets[0].to)-Date.parse(day.buckets[0].from),25*3600000);
 }finally{await db.dropDatabase();await client.close();}
});
