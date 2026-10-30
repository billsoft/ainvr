import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {ReviewWorker} from '../src/review-worker.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
const policy={enabled:true,description:'person',reject_below:.05,approve_above:.95};
const sample={seq:'1',frame_id:'f',source_pts_ns:'1',source_frame_index:'1',captured_at:new Date().toISOString(),track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20},roles:['触发关键帧']};
const make=id=>({alarm_id:id,occurred_at:'2026-10-29T12:00:00Z',channel_id:'c',input_stream_id:'in',frame_id:'f',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},
 rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',labels:[{label_id:'person',name:'person'}]}},
 analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample]}},
 review:{state:'queued',context_state:'ready',generation:id,attempt:0,next_attempt_at:0,policy:{...policy}}});
const mongoTimeout=()=>Object.assign(new Error('Operation exceeded time limit'),{name:'MongoServerError',code:50,codeName:'MaxTimeMSExpired'});
async function fixture(fn){
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_review_busy_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 try{await fn(events);}finally{await db.dropDatabase();await client.close();}
}
function workerFor(events,{saveError,invokeError}={}){
 let now=1_800_000_000_000;const clock=()=>now;
 const worker=new ReviewWorker({events},{clock,qualification:async()=>true,readiness:async()=>true,authorization:async()=>null,
  context:{image:async()=>({data:Buffer.from('jpeg')}),savePrepared:async()=>{if(saveError)throw saveError();return {key:'k',layout:'target-crop-v1'};}},
  invoke:async()=>{if(invokeError)throw invokeError();return {schema:'ainvr.alarm_review.v1',model:{package_sha256:'a'.repeat(64)},real_score:.5,prepared_image:{layout:'target-crop-v1',jpeg_base64:'AA=='}};}});
 return {worker,advance:ms=>{now+=ms;}};
}
test('transient storage failures keep the job retryable and do not spend model attempts',{skip:!enabled},()=>fixture(async events=>{
 await events.insertOne(make('busy'));
 const {worker,advance}=workerFor(events,{saveError:mongoTimeout});
 await worker.initialize();
 for(let i=1;i<=6;i++){
  assert.equal(await worker.step(),true);
  const row=await events.findOne({alarm_id:'busy'});
  assert.equal(row.review.state,'queued');assert.equal(row.review.reason,'storage_busy');
  assert.equal(row.review.attempt,0,'attempt must not be consumed by a storage timeout');
  assert.equal(row.review.storage_retries,i);
  advance(10*60_000);
 }
 await events.updateOne({alarm_id:'busy'},{$set:{'review.storage_retries':19}});
 assert.equal(await worker.step(),true);
 const capped=await events.findOne({alarm_id:'busy'});
 assert.equal(capped.review.state,'failed');assert.equal(capped.review.reason,'storage_unavailable');
}));
test('network and server-selection timeouts and a full image pool are also storage-busy',{skip:!enabled},()=>fixture(async events=>{
 for(const makeError of [()=>Object.assign(new Error('socket'),{name:'MongoNetworkTimeoutError'}),()=>Object.assign(new Error('no server'),{name:'MongoServerSelectionError'}),()=>new Error('evidence_capacity')]){
  await events.deleteMany({});await events.insertOne(make('x'));
  const {worker}=workerFor(events,{saveError:makeError});await worker.initialize();await worker.step();
  const row=await events.findOne({alarm_id:'x'});
  assert.equal(row.review.state,'queued');assert.equal(row.review.reason,'storage_busy');assert.equal(row.review.attempt,0);
 }
}));
test('unknown model-path errors still spend attempts and end as review_unavailable',{skip:!enabled},()=>fixture(async events=>{
 await events.insertOne(make('boom'));
 const {worker,advance}=workerFor(events,{invokeError:()=>new Error('boom')});await worker.initialize();
 for(let i=1;i<=3;i++){await worker.step();advance(10*60_000);}
 const row=await events.findOne({alarm_id:'boom'});
 assert.equal(row.review.state,'failed');assert.equal(row.review.reason,'review_unavailable');assert.equal(row.review.attempt,3);
}));
