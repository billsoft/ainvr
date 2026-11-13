import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import {AlarmRepository} from '../src/repository.mjs';
import {FaceWatchlistWorker} from '../src/face-watchlist-worker.mjs';
import {makeFaceWatchlistAlarm} from '../src/face-watchlist-candidate.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';
import {ReferenceReviewWorker} from '../src/reference-review.mjs';
import {ReviewContext} from '../src/review-context.mjs';
import {startService} from '../src/runtime.mjs';
import {candidate,acknowledged} from './face-watchlist-fixture.mjs';
const uri=process.env.AINVR_ALARM_TEST_MONGO_URI;
async function fixture(work){
 const endpoint=new URL(uri);assert.equal(endpoint.protocol,'mongodb:');assert.ok(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname));assert.equal(endpoint.port,'27932','only the assigned isolated Mongo is allowed');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:3000,monitorCommands:true});await client.connect();
 const name='ainvr_face_delivery_test_'+randomUUID().replaceAll('-',''),db=client.db(name),repo=new AlarmRepository(db);
 try{await repo.initialize();await work({client,db,repo,name});}finally{await db.dropDatabase();await client.close();}
}
for(const fault of ['insert_response_lost','ack_response_lost'])test(`real Mongo ${fault}: replay retains one alarm, original evidence and human disposition`,{skip:!uri},async()=>fixture(async({client,db,repo})=>{
 let current=candidate(),acks=0,journaled=false;
 client.on('commandStarted',e=>{if(e.commandName==='update'&&e.command.update==='alarms'&&e.command.updates.some(u=>u.u.$setOnInsert?.event_kind==='face_watchlist'))journaled=e.command.writeConcern?.j===true&&e.command.writeConcern?.w===1;});
 const transport={poll:async()=>({items:[current]}),ack:async c=>{assert.equal(await repo.events.countDocuments(),1);acks++;if(fault==='ack_response_lost'&&acks===1)throw Error('ACK connection lost');return acknowledged(c);}};
 const originalInsert=repo.insert.bind(repo);let inject=true;
 if(fault==='insert_response_lost')repo.insert=async(...args)=>{const result=await originalInsert(...args);if(inject){inject=false;throw Error('insert response lost');}return result;};
 const worker=new FaceWatchlistWorker(repo,{transport});await worker.tick();await worker.close();
 assert.equal(journaled,true);assert.equal(await repo.events.countDocuments(),1);assert.equal(worker.status().acknowledged,0);
 const original=await repo.events.findOne();assert.equal(original.review.reason,'face_watchlist_manual_review');
 const processorList=await repo.list({status:'all',channel_id:current.processor_id});
 assert.deepEqual(processorList.items.map(row=>row.alarm_id),[original.alarm_id]);
 assert.equal((await repo.list({status:'all',channel_id:current.channel_id})).items.length,0);
 assert.equal((await repo.list({status:'all',channel_id:current.processor_id,event_kind:'face_watchlist'})).items.length,1);
 assert.equal(original.input_stream_id,null);assert.equal(original.analysis_evidence.face.channel_id,current.channel_id);
 assert.equal(original.analysis_evidence.face.recording_channel_id,current.recording_channel_id);
 const disposition=fault==='insert_response_lost'?'handled':'false_positive';
 await repo.confirm(original.alarm_id,{expected_handling_revision:0,disposition,note:'人工复核'},'test-operator','face-human-decision');
 const handled=await repo.events.findOne();
 current=candidate({record_id:'55555555-5555-4555-a555-555555555555',photo_ref:'55555555-5555-4555-a555-555555555555',frame_id:'session:2',source_pts_ns:'2000000000',source_frame_index:'2',occurred_at:'2026-11-12T12:00:01.000Z',library_name:'后续名单名',member_name:'后续姓名',similarity:.96});
 const recovered=new FaceWatchlistWorker(new AlarmRepository(db),{transport});await recovered.tick();await recovered.close();
 assert.equal(recovered.status().acknowledged,1);assert.equal(await repo.events.countDocuments(),1);
 const after=await repo.events.findOne();assert.deepEqual(after,handled);
 assert.equal(after.analysis_evidence.face.record_id,original.analysis_evidence.face.record_id);assert.equal(after.rule.snapshot.library_version,7);
 assert.equal(after.rule.name,'发生时名单');assert.equal(after.analysis_evidence.face.member_name,'发生时姓名');
 assert.equal(after.handling.disposition,disposition);assert.equal(after.handling.reviewed_by_kind,'human');
 assert.equal((await repo.get(after.alarm_id)).event_kind,'face_watchlist');
 assert.equal(await repo.behaviors.collection.countDocuments(),0);assert.equal(await repo.captureJobs.countDocuments(),0);
 assert.equal(await db.collection('alarm_rules').countDocuments(),0);
}));
test('real Mongo face markers exclude queued/legacy candidates from both person review workers',{skip:!uri},async()=>fixture(async({repo})=>{
 const event=makeFaceWatchlistAlarm(candidate());await repo.insert(event,{durable:true});
 for(const marker of ['event_kind','snapshot','face']){
  const row=structuredClone(event);delete row.event_kind;delete row.rule.snapshot.event_kind;delete row.analysis_evidence.face;
  if(marker==='event_kind')row.event_kind='face_watchlist';if(marker==='snapshot')row.rule.snapshot.event_kind='face_watchlist';if(marker==='face')row.analysis_evidence.face=candidate();
  row.alarm_id=marker;row.dedup_key=marker;await repo.events.insertOne(row);
 }
 let calls=0;const invoke=async()=>{calls++;throw Error('must not review face identity as person');};
 const worker=new ReviewWorker(repo,{invoke,context:{image:invoke},readiness:async()=>true,authorization:async()=>({id:'person-permission',focus:{},mode:'confirm_or_reject'})});
 const reference=new ReferenceReviewWorker({rows:repo.events,invoke,image:invoke,prepare:invoke});
 for(const state of ['ready','incomplete']){
  await repo.events.updateMany({},{$set:{'review.policy.enabled':true,'review.state':'queued','review.context_state':state,'review.generation':'legacy-person','review.next_attempt_at':0}});
  assert.equal(await worker.step(),false);assert.equal(await reference.step(),false);
 }
 assert.equal(calls,0);assert.equal(await repo.events.countDocuments({'handling.state':'acknowledged'}),0);
}));
test('real Mongo clear-history tombstone prevents outbox retry resurrecting a cleared face candidate',{skip:!uri},async()=>fixture(async({repo})=>{
 const c=candidate({occurred_at:new Date(Date.now()-10000).toISOString()});await repo.insert(makeFaceWatchlistAlarm(c),{durable:true});
 await repo.clearAll('test-operator','face-clear');let acks=0;
 const worker=new FaceWatchlistWorker(repo,{transport:{poll:async()=>({items:[c]}),ack:async value=>{acks++;return acknowledged(value);}}});
 await worker.tick();await worker.close();assert.equal(acks,1);assert.equal(await repo.events.countDocuments(),0);
}));
test('service startup starts the face consumer and shutdown stops it before Mongo closes',{skip:!uri,timeout:15000},async t=>fixture(async({db,name})=>{
 // Face delivery only references BFF-owned photos. Stub the unrelated spatial
 // frame collector so this lifecycle test neither opens nor writes its SSD path.
 t.mock.method(ReviewContext.prototype,'initialize',async()=>{});t.mock.method(ReviewContext.prototype,'run',()=>{});t.mock.method(ReviewContext.prototype,'close',async()=>{});
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 let polls=0,acks=0;const c=candidate(),token='face-runtime-test-'.repeat(3);
 const service=await startService({schema_version:'1.0',version:1,operation_id:'face-test',host:'127.0.0.1',port,mongo_uri:uri,database:name,api_token:token,producer_token:'face-producer-test-'.repeat(3)},
  {faceOutbox:{poll:async()=>{polls++;return {items:acks?[]:[c]};},ack:async value=>{acks++;return acknowledged(value);}}});
 try{
  for(let i=0;i<100&&acks===0;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(acks,1);assert.equal(await db.collection('alarms').countDocuments(),1);
  const response=await service.app.inject({url:'/v1/status',headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.statusCode,200);assert.equal(response.json().face_watchlist.acknowledged,1);
  for(const [channel,count] of [[c.processor_id,1],[c.channel_id,0]]){
   const url=`/v1/events?status=all&channel_id=${encodeURIComponent(channel)}`;
   const list=await service.app.inject({url,headers:{authorization:`Bearer ${token}`,'x-ainvr-actor':'console-administrator'}});
   assert.equal(list.statusCode,200);assert.equal(list.json().items.length,count);
   if(count)assert.equal(list.json().items[0].event_kind,'face_watchlist');
   const tokenOnly=await service.app.inject({url,headers:{authorization:`Bearer ${token}`}});
   assert.equal(tokenOnly.statusCode,200);assert.deepEqual(tokenOnly.json().items,[]);
   assert.equal(tokenOnly.body.includes(c.member_name),false);
   const local=await service.app.inject({url,headers:{authorization:`Bearer ${token}`,'x-ainvr-actor':'console-local'}});
   assert.equal(local.statusCode,200);assert.deepEqual(local.json().items,[]);
  }
 }finally{await service.close();}
 const atClose=polls;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(polls,atClose);
}));
