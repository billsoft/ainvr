import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {ReviewWorker} from '../src/review-worker.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
test('durable review: newest first, human race, stage race, uncertainty and automatic disposition isolation',{skip:!enabled},async()=>{
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_review_test_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 const policy={enabled:true,description:'person',reject_below:.05,approve_above:.95};
 const sample={seq:'1',frame_id:'f',source_pts_ns:'1',source_frame_index:'1',captured_at:new Date().toISOString(),track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20}};
 const make=(id,at,auto=false)=>({alarm_id:id,occurred_at:at,channel_id:'c',input_stream_id:'in',frame_id:'f',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',labels:[{label_id:'person',name:'person'}]}},analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample]}},review:{state:'queued',context_state:'ready',generation:id,attempt:0,next_attempt_at:0,policy:{...policy}}});
 let effect=async()=>{},score=.99,validated=true;const seen=[];
 const worker=new ReviewWorker({events},{qualification:async()=>validated,context:{image:async(row)=>{seen.push(row.alarm_id);return {data:Buffer.from('jpeg')}}},invoke:async()=>{await effect();return {schema:'ainvr.alarm_review.v1',validated,model:{package_sha256:'a'.repeat(64)},real_score:score}}});
 try{
  await worker.initialize();await events.insertMany([make('second','2026-10-22T02:00:00Z'),make('first','2026-10-22T03:00:00Z')]);
  await worker.step();assert.equal(seen[0],'first');assert.equal((await events.findOne({alarm_id:'first'})).review.state,'supported');
  effect=()=>events.updateOne({alarm_id:'second'},{$set:{'handling.state':'acknowledged','handling.disposition':'processed'},$inc:{'handling.revision':1}});
  await worker.step();const human=await events.findOne({alarm_id:'second'});assert.equal(human.handling.disposition,'processed');assert.equal(human.review.reason,'human_handled');
  await events.insertOne(make('changed','2026-10-22T03:00:00Z'));effect=()=>events.updateOne({alarm_id:'changed'},{$set:{'review.generation':'new','review.state':'queued'}});
  await worker.step();assert.equal((await events.findOne({alarm_id:'changed'})).review.state,'queued');await events.deleteOne({alarm_id:'changed'});
  effect=async()=>{};score=.01;await events.insertOne(make('suggestion','2026-10-22T04:00:00Z'));await worker.step();
  const suggestion=await events.findOne({alarm_id:'suggestion'});assert.equal(suggestion.review.state,'not_supported');assert.equal(suggestion.handling.state,'acknowledged');assert.equal(suggestion.handling.reviewed_by_kind,'ai');assert.equal(suggestion.handling.disposition,'false_positive');
  await events.insertOne(make('automatic','2026-10-22T05:00:00Z',true));await worker.step();const auto=await events.findOne({alarm_id:'automatic'});assert.equal(auto.handling.state,'acknowledged');assert.equal(auto.handling.disposition,'false_positive');assert.equal(auto.logs[0].action,'ai_review');
  score=.5;await events.insertOne(make('uncertain','2026-10-22T06:00:00Z',true));await worker.step();assert.equal((await events.findOne({alarm_id:'uncertain'})).handling.state,'unacknowledged');
  validated=false;score=.99;await events.insertOne(make('unvalidated','2026-10-22T07:00:00Z'));await worker.step();
  const blocked=await events.findOne({alarm_id:'unvalidated'});assert.equal(blocked.handling.state,'unacknowledged');assert.equal(blocked.review.state,'failed');assert.equal(blocked.review.reason,'unvalidated_profile');assert.equal(blocked.review.attempt,1);
  effect=async()=>{throw Error('input_too_long')};await events.insertOne(make('oversized','2026-10-22T08:00:00Z'));await worker.step();
  const oversized=await events.findOne({alarm_id:'oversized'});assert.equal(oversized.handling.state,'unacknowledged');assert.equal(oversized.review.state,'failed');assert.equal(oversized.review.reason,'input_too_long');assert.equal(await worker.step(),false);
  effect=async()=>{};score=.99;validated=true;worker.readiness=async()=>false;
  await events.insertOne(make('waiting','2026-10-22T09:00:00Z'));await worker.step();
  assert.equal((await events.findOne({alarm_id:'waiting'})).review.state,'waiting_validation');
  assert.equal((await events.findOne({alarm_id:'waiting'})).review.attempt,0);
  assert.equal((await events.findOne({alarm_id:'waiting'})).review.reference.state,'completed');
  assert.equal((await events.findOne({alarm_id:'waiting'})).handling.state,'unacknowledged');
  await events.deleteOne({alarm_id:'unvalidated'});
  assert.equal(await worker.step(),false);
  // A new evidence generation must be analyzed again; stale reference cannot authorize it.
  await events.updateOne({alarm_id:'waiting'},{$set:{'review.generation':'next-generation'}});
  await worker.step();
  assert.equal((await events.findOne({alarm_id:'waiting'})).review.reference.generation,'next-generation');
  // Isolate the new pending row from older failed-profile rows recovered by preflight.
  await events.deleteOne({alarm_id:'unvalidated'});worker.readiness=async()=>true;await worker.step();
  assert.equal((await events.findOne({alarm_id:'waiting'})).handling.reviewed_by_kind,'ai');
 }finally{await worker.close();await db.dropDatabase();await client.close();}
});
