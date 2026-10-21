import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {BehaviorEvents} from '../src/behavior-events.mjs';

test('bucket limits reject unbounded or invalid queries before database access',async()=>{
 const facts=new BehaviorEvents({collection:()=>({aggregate(){throw Error('unexpected database call');}})});
 for(const bucket of ['week','constructor','',[],{}]) await assert.rejects(facts.statistics({from:'2026-10-19',to:'2026-10-20',bucket}),e=>e.code==='invalid_bucket');
 await assert.rejects(facts.statistics({from:'2026-10-01',to:'2026-10-10',bucket:'minute'}),e=>e.code==='invalid_bucket');
});

test('UTC buckets clip boundaries and totals deduplicate targets across buckets',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const facts=new BehaviorEvents(db);await facts.initialize();
  const base={event_type:'region_enter',channel_id:'gate',stream_session_id:'s',track_id:'t',label_id:'person'};
  await facts.collection.insertMany([
   {...base,event_id:'before',occurred_at:'2026-10-19T00:29:59.999Z'},
   {...base,event_id:'one',occurred_at:'2026-10-19T00:30:00.000Z'},
   {...base,event_id:'two',occurred_at:'2026-10-19T01:00:00.000Z'},
   {...base,event_id:'three',track_id:'other',occurred_at:'2026-10-19T01:10:00.000Z'},
   {...base,event_id:'end',occurred_at:'2026-10-19T02:30:00.000Z'},
  ]);
  const q={from:'2026-10-19T08:30:00+08:00',to:'2026-10-19T10:30:00+08:00',bucket:'hour',channel_id:'gate'};
  const r=await facts.statistics(q);
  assert.deepEqual(r.items,[{event_type:'region_enter',occurrences:3,tracked_targets:2}]);
  assert.deepEqual(r.buckets,[
   {from:'2026-10-19T00:30:00.000Z',to:'2026-10-19T01:00:00.000Z',event_type:'region_enter',occurrences:1,tracked_targets:1},
   {from:'2026-10-19T01:00:00.000Z',to:'2026-10-19T02:00:00.000Z',event_type:'region_enter',occurrences:2,tracked_targets:2},
  ]);
  assert.equal(r.coverage.state,'unknown');assert.equal(r.missing_bucket_policy,'unknown');
  const empty=await facts.statistics({...q,label_id:'vehicle'});assert.deepEqual(empty.buckets,[]);assert.deepEqual(empty.items,[]);
  const total=await facts.statistics({...q,bucket:undefined});assert.deepEqual(total.items,r.items);assert.equal('buckets' in total,false);
 }finally{await db.dropDatabase();await client.close();}
});
test('local midnight, DST days, rule filters and observed direction groups use actual database date arithmetic',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const facts=new BehaviorEvents(db);await facts.initialize();
  const base={event_type:'region_enter',channel_id:'gate',stream_session_id:'s',track_id:'t',label_id:'person',zone_id:'z'};
  await facts.collection.insertMany([
   {...base,event_id:'a',rule_id:'r1',occurred_at:'2026-10-18T23:59:59.000Z',direction:{entry_side_deg:359}},
   {...base,event_id:'b',rule_id:'r2',occurred_at:'2026-10-19T00:00:00.000Z',direction:{entry_side_deg:90}},
   {...base,event_id:'dst',rule_id:'r1',occurred_at:'2026-03-08T12:00:00.000Z',direction:{entry_side_deg:null}},
  ]);
  const q={from:'2026-10-18T16:00:00Z',to:'2026-10-19T16:00:00Z',bucket:'day',timezone:'Asia/Shanghai'};
  const local=await facts.statistics(q);assert.equal(local.buckets.length,1);assert.equal(local.buckets[0].from,'2026-10-18T16:00:00.000Z');assert.equal(local.buckets[0].to,'2026-10-19T16:00:00.000Z');
  assert.equal(local.items[0].occurrences,2);assert.equal(local.items[0].tracked_targets,1);
  const filtered=await facts.statistics({...q,rule_id:'r1'});assert.equal(filtered.items[0].occurrences,1);
  const groups=await facts.statistics({...q,group_by:'entry_direction'});assert.deepEqual(groups.items.map(r=>r.group).sort(),[0,2]);
  const dst=await facts.statistics({from:'2026-03-08T00:00:00-05:00',to:'2026-03-09T00:00:00-04:00',bucket:'day',timezone:'America/New_York'});
  assert.equal(Date.parse(dst.buckets[0].to)-Date.parse(dst.buckets[0].from),23*3600000);
  await assert.rejects(facts.statistics({...q,timezone:'Bad/Timezone'}),e=>e.code==='invalid_timezone');
 }finally{await db.dropDatabase();await client.close();}
});
