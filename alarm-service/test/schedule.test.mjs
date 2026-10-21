import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeSchedule,createScheduleEvaluator} from '../src/schedule.mjs';
import {validateRule} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const cases=JSON.parse(readFileSync(new URL('../../test/fixtures/alarm-weekly-schedule.json',import.meta.url),'utf8'));
const weekly=(windows,timezone='Asia/Shanghai')=>({mode:'weekly',timezone,windows});
const slot=(days,start,end)=>({days,start,end});
const period=(schedule,at)=>createScheduleEvaluator(at)(schedule);
const rule={id:'m:appearance',monitor_id:'m',version:1,name:'Entry',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],max_gap_ms:60000};
const frame=(seq,at,x=.5)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:at,source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:x*1000-10,y:490,w:20,h:20}}]});
test('shared schedule contract rejects unknown fields, overlaps and ambiguous inputs',()=>{
 for(const c of cases){
  if(c.valid)assert.doesNotThrow(()=>validateRule({...rule,schedule:c.schedule}),c.name);
  else assert.throws(()=>validateRule({...rule,schedule:c.schedule}),e=>e.code==='invalid_schedule',c.name);
 }
 assert.deepEqual(normalizeSchedule(undefined),{mode:'always'});
 assert.throws(()=>normalizeSchedule(weekly(Array.from({length:29},()=>slot([1],'09:00','10:00')))));
 const s=normalizeSchedule(weekly([slot([3,1],'09:00','10:00')]));s.windows[0].days[0]=7;
 assert.deepEqual(normalizeSchedule(weekly([slot([3,1],'09:00','10:00')])).windows[0].days,[1,3]);
});
test('uses captured instant and rule timezone with inclusive start and exclusive end',()=>{
 const s=weekly([slot([1],'09:00','18:00')]);
 assert.equal(period(s,'2026-10-19T00:59:59Z'),null);
 assert.ok(period(s,'2026-10-19T01:00:00Z'));
 assert.ok(period(s,'2026-10-19T09:59:59.999Z'));
 assert.equal(period(s,'2026-10-19T10:00:00Z'),null);
 assert.equal(period(s,'2026-10-20T01:00:00Z'),null);
 assert.equal(period(s,'2026-10-19T09:30:00+08:00'),period(s,'2026-10-19T01:30:00Z'));
 assert.throws(()=>evaluate(null,frame(1,'2026-10-19T09:30:00'),[{...rule,schedule:s}]),e=>e.code==='invalid_time');
});
test('Sunday night belongs to its start day; adjacent slots stay continuous over week wrap',()=>{
 const s=weekly([slot([7],'22:00','06:00'),slot([1],'06:00','07:00')]);
 assert.equal(period(s,'2026-10-18T15:00:00Z'),period(s,'2026-10-18T22:30:00Z'));
 assert.equal(period(s,'2026-10-18T23:00:00Z'),null);
 assert.notEqual(period(s,'2026-10-18T15:00:00Z'),period(s,'2026-10-25T15:00:00Z'));
 const full=weekly([slot([1,2,3,4,5,6,7],'00:00','24:00')]);
 assert.equal(period(full,'2026-10-18T15:59:59Z'),period(full,'2026-10-25T16:00:00Z'));
});
test('DST follows local wall clock; missing spring hours are not fabricated and fall repeat stays one window',()=>{
 const spring=weekly([slot([7],'02:00','04:00')],'America/New_York');
 assert.equal(period(spring,'2026-03-08T06:59:59Z'),null);
 assert.ok(period(spring,'2026-03-08T07:00:00Z'));
 assert.equal(period(spring,'2026-03-08T08:00:00Z'),null);
 assert.equal(period(weekly([slot([7],'02:00','03:00')],'America/New_York'),'2026-03-08T07:00:00Z'),null);
 const fall=weekly([slot([7],'01:00','02:00')],'America/New_York');
 assert.equal(period(fall,'2026-11-01T05:30:00Z'),period(fall,'2026-11-01T06:30:00Z'));
 assert.equal(period(fall,'2026-11-01T07:00:00Z'),null);
});
test('inactive frames end activity; a new window starts a new activity even without an off-window frame',()=>{
 const r={...rule,schedule:weekly([slot([1],'09:00','10:00'),slot([1],'10:01','11:00')])};
 const first=evaluate(null,frame(1,'2026-10-19T01:59:58Z'),[r]);
 assert.equal(first.events.length,1);
 const off=evaluate(first.checkpoint,frame(2,'2026-10-19T02:00:00Z'),[r]);
 assert.equal(off.events.length,0);assert.equal(off.ended_episodes[0].end_reason,'schedule_ended');
 assert.deepEqual(off.checkpoint.states,{});
 const missing=frame(2,'2026-10-19T02:01:00Z');missing.tracks=[];
 const absent=evaluate(first.checkpoint,missing,[r]);assert.equal(absent.ended_episodes[0].end_reason,'schedule_ended');
 const resumed=evaluate(first.checkpoint,frame(2,'2026-10-19T02:01:00Z'),[r]);
 assert.equal(resumed.events.length,1);assert.notEqual(resumed.events[0].episode_id,first.events[0].episode_id);
 assert.equal(resumed.ended_episodes[0].episode_id,first.events[0].episode_id);
 assert.deepEqual(evaluate(JSON.parse(JSON.stringify(resumed.checkpoint)),frame(3,'2026-10-19T02:01:01Z'),[r]).events,[]);
});
test('dwell and traversal cannot borrow prior-window evidence; adjacent active slots can',()=>{
 const schedule=weekly([slot([1],'09:00','10:00'),slot([1],'10:01','11:00')]);
 const r={...rule,schedule,duration_ms:1000};
 let first=evaluate(null,frame(1,'2026-10-19T01:59:59Z'),[r]);
 assert.equal(evaluate(first.checkpoint,frame(2,'2026-10-19T02:01:00Z'),[r]).events.length,0);
 const traverse={...rule,behavior:'region_traverse',schedule};
 let cp=evaluate(null,frame(1,'2026-10-19T01:59:58Z',.2),[traverse]).checkpoint;
 cp=evaluate(cp,frame(2,'2026-10-19T01:59:59Z',.5),[traverse]).checkpoint;
 assert.equal(evaluate(cp,frame(3,'2026-10-19T02:01:00Z',.8),[traverse]).events.length,0);
 const adjacent={...traverse,schedule:weekly([slot([1],'09:00','10:00'),slot([1],'10:00','11:00')])};
 cp=evaluate(null,frame(1,'2026-10-19T01:59:58Z',.2),[adjacent]).checkpoint;
 cp=evaluate(cp,frame(2,'2026-10-19T01:59:59Z',.5),[adjacent]).checkpoint;
 assert.equal(evaluate(cp,frame(3,'2026-10-19T02:00:00Z',.8),[adjacent]).events.length,1);
});
test('Mongo keeps schedule facts immutable and recovers a prepared schedule closure after configuration changes',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const r={...rule,schedule:weekly([slot([1],'09:00','10:00')])};
  const snapshot={schema_version:'1.0',revision:'1',rules:[r]};
  await repo.ruleSnapshots.apply(snapshot,'console');
  await assert.rejects(repo.ruleSnapshots.apply({...snapshot,revision:'2',rules:[{...r,schedule:{mode:'always'}}]},'console'),e=>e.code==='rule_version_conflict');
  const envelope=(seq,at)=>({schema_version:'1.0',producer_id:'p',offset:String(seq),frame:frame(seq,at)});
  const consumer=new ObservationConsumer(repo);
  assert.equal((await consumer.consume(envelope(1,'2026-10-19T00:59:59Z'))).behavior_events.length,0);
  const first=await consumer.consume(envelope(2,'2026-10-19T01:00:00Z'));
  assert.equal(first.events.length,1);
  await repo.confirm(first.events[0],{expected_handling_revision:0,note:'checked'},'operator','ack');
  const interrupted=new ObservationConsumer(repo,{hook:async point=>{if(point==='prepared')throw Error('power loss');}});
  const closing=envelope(3,'2026-10-19T02:00:00Z');
  await assert.rejects(interrupted.consume(closing),/power loss/);
  await repo.ruleSnapshots.apply({...snapshot,revision:'2',rules:[{...r,version:2,schedule:{mode:'always'}}]},'console');
  const recovered=new ObservationConsumer(new AlarmRepository(db));
  assert.equal((await recovered.consume(closing)).outcome,'already_consumed');
  const alarm=await repo.get(first.events[0]);
  assert.equal(alarm.lifecycle.end_reason,'schedule_ended');assert.equal(alarm.handling.acknowledged_by,'operator');
  assert.deepEqual(alarm.rule.snapshot.schedule,r.schedule);
  assert.equal(await repo.behaviors.collection.countDocuments(),1);
  const next=await recovered.consume(envelope(4,'2026-10-19T02:01:00Z'));
  assert.notEqual(next.events[0],first.events[0]);assert.equal(await repo.behaviors.collection.countDocuments(),2);
 }finally{await db.dropDatabase();await client.close();}
});
