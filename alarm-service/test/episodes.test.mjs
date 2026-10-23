import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {evaluate} from '../src/engine.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const behaviors=['appearance','region_approach','region_enter','region_traverse'];
const rules=behaviors.map(behavior=>({id:`${behavior}@c`,trigger_id:behavior,version:1,name:'Gate',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior,anchor:'center',
  ...(behavior==='appearance'?{}:{points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]}),...(behavior==='region_approach'?{approach_px:100}:{})}));
const frame=(seq,x)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:new Date(1760918400000+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:x*1000-10,y:490,w:20,h:20}}]});
test('all triggers share one activity per target on the channel; it ends after the identity grace',()=>{
 let cp=null,events=[];
 for(const [i,x] of [.15,.25,.3,.4,.6,.85].entries()){
  const r=evaluate(cp,frame(i+1,x),rules);cp=r.checkpoint;events.push(...r.events);
 }
  assert.deepEqual(events.map(e=>e.behavior),['appearance','region_approach','region_enter','region_traverse']);
 assert.equal(new Set(events.map(e=>e.episode_id)).size,1);
 let outside=[];for(let i=7;i<=10;i++){const r=evaluate(cp,frame(i,.9),rules);cp=r.checkpoint;outside.push(...r.ended_episodes);}
 assert.equal(outside.length,0);  // still the same visible target
 const absent=frame(11,.9);absent.tracks=[];
 let gone=evaluate(cp,absent,rules);assert.equal(gone.ended_episodes.length,0);cp=gone.checkpoint;
 for(let i=12;i<=14;i++){const f=frame(i,.9);f.tracks=[];gone=evaluate(cp,f,rules);cp=gone.checkpoint;}
 assert.equal(gone.ended_episodes.length,1);assert.equal(gone.ended_episodes[0].end_reason,'track_expired');
 const next=evaluate(cp,frame(15,.25),rules);
 assert.ok(next.events.length&&next.events.every(e=>e.episode_id!==events[0].episode_id));
});
test('a target far outside the zone creates no zone facts; appearance fires once per target',()=>{
 let cp=null,events=[];
 for(let i=1;i<=12;i++){const r=evaluate(cp,frame(i,.1),rules);cp=r.checkpoint;events.push(...r.events);}
 assert.deepEqual(events.map(e=>e.rule.id),['appearance@c']);
 assert.equal(events[0].rule.snapshot.zone_id,null);  // appearance is whole-picture
 const reset=evaluate(cp,{...frame(13,.1),stream_session_id:'new'},rules);
 assert.equal(reset.ended_episodes.length,1);assert.deepEqual(reset.events.map(e=>e.rule.id),['appearance@c']);
 assert.notEqual(reset.events[0].episode_id,events[0].episode_id);
});
test('Mongo merges stages, preserves acknowledgement and recovers prepared input without duplicate facts',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028');await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();for(const r of rules)await repo.saveRule(r,0,'test');
  const envelope=(seq,x)=>({schema_version:'1.0',producer_id:'p',offset:String(seq),frame:frame(seq,x)});
  const consumer=new ObservationConsumer(repo);
  const id=(await consumer.consume(envelope(1,.15))).events[0];  // appearance opens the activity
  for(const [seq,x] of [[2,.25],[3,.3]])await consumer.consume(envelope(seq,x));
  await repo.confirm(id,{expected_handling_revision:0,note:'checked'},'operator','ack');
  // Crash while storing the intrusion stage; the retry must not duplicate it.
  let once=false;const broken=new ObservationConsumer(repo,{hook:async point=>{if(point==='event_inserted'&&!once){once=true;throw Error('crash');}}});
  await assert.rejects(()=>broken.consume(envelope(4,.4)),/crash/);
  await consumer.consume(envelope(4,.4));
  for(const [seq,x] of [[5,.6],[6,.85]])await consumer.consume(envelope(seq,x));
  assert.equal(await repo.events.countDocuments(),1);
  const alarm=await repo.get(id);assert.equal(alarm.behavior,'region_traverse');
  assert.equal(alarm.handling.acknowledged_by,'operator');assert.equal(alarm.logs.filter(l=>l.action==='acknowledged').length,1);
  assert.equal(new Set(alarm.stages.map(s=>s.event_id)).size,alarm.stages.length);
  assert.equal(await repo.behaviors.collection.countDocuments(),alarm.stages.length);
  assert.equal(alarm.trigger_id,'region_traverse');assert.equal(alarm.rule.id,'region_traverse@c');  // shows the trigger that reached the top level
  for(let i=7;i<=10;i++){const gone=envelope(i,.9);gone.frame.tracks=[];await consumer.consume(gone);}
  assert.equal((await repo.get(id)).lifecycle.state,'ended');
 }finally{await db.dropDatabase();await client.close();}
});
