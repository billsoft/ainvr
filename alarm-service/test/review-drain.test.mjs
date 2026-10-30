import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {ReviewWorker} from '../src/review-worker.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
const policy={enabled:true,description:'person',reject_below:.05,approve_above:.95};
const sample={seq:'1',frame_id:'f',source_pts_ns:'1',source_frame_index:'1',captured_at:new Date().toISOString(),track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20},roles:['触发关键帧']};
const make=(id,at)=>({alarm_id:id,occurred_at:at,channel_id:'c',input_stream_id:'in',frame_id:'f',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},
 rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',labels:[{label_id:'person',name:'person'}]}},
 analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample]}},
 review:{state:'queued',context_state:'ready',generation:id,attempt:0,next_attempt_at:0,policy:{...policy}}});
test('a backlog drains back-to-back instead of idling between alarms',{skip:!enabled},async()=>{
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_review_drain_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 const worker=new ReviewWorker({events},{qualification:async()=>true,readiness:async()=>true,authorization:async()=>null,
  context:{image:async()=>({data:Buffer.from('jpeg')})},
  invoke:async()=>({schema:'ainvr.alarm_review.v1',model:{package_sha256:'a'.repeat(64)},real_score:.99})});
 try{
  await worker.initialize();
  await events.insertMany([make('a','2026-10-29T12:03:00Z'),make('b','2026-10-29T12:02:00Z'),make('c','2026-10-29T12:01:00Z')]);
  worker.run();
  await new Promise(resolve=>setTimeout(resolve,1800));   // the old fixed 3 s pause would have finished at most one alarm
  const done=await events.countDocuments({'handling.state':'acknowledged'});
  assert.equal(done,3);
 }finally{await worker.close();await db.dropDatabase();await client.close();}
});
