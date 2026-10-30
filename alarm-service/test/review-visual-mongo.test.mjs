import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {evaluate} from '../src/engine.mjs';
import {ReviewContext,reviewSamples} from '../src/review-context.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';
import {parseAuthorization} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
const enabled=!!process.env.AINVR_REVIEW_TEST_MONGO_URI;
const jpeg=Buffer.from('ffd8ffc00011080040004003012200021101031101ffd9','hex');
const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'核对人',reject_below:.05,approve_above:.95};
const authorization=parseAuthorization({schema:'ainvr.review-authorization.v1',enabled:true,mode:'confirm_only',model_sha256:'a'.repeat(64),layout:'target-crop-v1',prompt_template:'alarm-review-zh-v1',caller_template:REVIEW_PROMPT_VERSION,labels:['人'],approve_above:.99,authorized_by:'test',authorized_at:'2026-10-29T00:00:00Z'});
function make(){
 const r={id:'r',version:1,name:'test',channel_id:'c',state:'enabled',label_ids:['person'],labels:[{label_id:'person',name:'人'}],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy};
 let cp=null,event;
 for(const [i,x] of [.2,.4,.5].entries()){
  const n=String(i+1),pts=String((i+1)*1000000000),f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(Date.now()-3000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-25,y:500,w:50,h:50}}]};
  const result=evaluate(cp,f,[r]);cp=result.checkpoint;event??=result.events[0];
 }
 assert.ok(event);assert.equal(reviewSamples(event).ok,true);
 const id='a'.repeat(64);
 return {...event,alarm_id:randomUUID(),behavior_event_ids:[id],handling:{state:'unacknowledged',revision:0},review:{generation:randomUUID(),evidence_id:id,policy,state:'uncertain',context_state:'incomplete',reason:'missing_context',recovery:{attempt:6,next_at:0}}};
}
async function fixture(fn){
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI,{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_visual_test_'+randomUUID().replaceAll('-',''));
 try{const repo=new AlarmRepository(db),context=new ReviewContext(repo,'/mnt/ainvr-ssd/visual-test-unused');await context.images.initialize();context.image=async()=>{throw Error('missing_context')};await fn(repo,context);}
 finally{await db.dropDatabase();await client.close();}
}
function vaultFor(row){return {metadata:async()=>({state:'available',evidence:{kind:'target_crop',variants:['original','processed'],channel_id:row.channel_id,stream_session_id:row.stream_session_id,track_id:row.track_ids[0],source_pts_ns:row.source_pts_ns,source_frame_index:row.analysis_evidence.source_frame_index,frame_width:1920,frame_height:1080,image_width:64,image_height:64,label_id:'person'}}),image:async()=>jpeg};}
test('exhausted recording recovery can atomically recover the exact original crop and confirm, with explicit limited evidence',{skip:!enabled},()=>fixture(async(repo,context)=>{
 const row=make();repo.evidenceVault=vaultFor(row);await repo.events.insertOne(row);await context.recoverOne();
 let current=await repo.events.findOne({alarm_id:row.alarm_id});assert.equal(current.review.state,'queued');assert.equal(current.review.context_state,'ready');assert.equal(current.review.frames[0].source_kind,'retained_target');
 assert.equal(current.review.recovery.state,'visual_completed');assert.equal(current.review.recovery.method,'retained_evidence');assert.equal(current.review.recovery.reason,null);
 assert.deepEqual(await context.retained(row.alarm_id,current.review.frames[0].key),jpeg);
 const calls=[];const worker=new ReviewWorker(repo,{context,readiness:async()=>false,authorization:async()=>authorization,invoke:async request=>{calls.push(request);return {schema:'ainvr.alarm_review.v1',real_score:.9999,model:{package_sha256:'a'.repeat(64)},template:'alarm-review-zh-v1',prepared_image:{layout:'target-crop-v1',jpeg_base64:jpeg.toString('base64'),width:64,height:64}}}});
 await worker.step();current=await repo.events.findOne({alarm_id:row.alarm_id});assert.equal(current.handling.reviewed_by_kind,'ai');assert.equal(current.handling.disposition,'handled');assert.equal(current.review.evidence_mode,'verified_behavior_available_visuals');assert.equal(current.review.reviewed_frame_ids.length,1);assert.equal(current.review.required_frame_ids.length,2);
 assert.deepEqual(calls[0].preparation.target,[0,0,1,1]);assert.deepEqual(calls[0].preparation.region,[]);assert.equal(current.logs.at(-1).missing_frame_ids.length,2);
}));
test('limited images never auto-dismiss even for a qualified model, and human handling wins during preparation',{skip:!enabled},()=>fixture(async(repo,context)=>{
 const row=make();repo.evidenceVault=vaultFor(row);await repo.events.insertOne(row);await context.recoverOne();
 const worker=new ReviewWorker(repo,{context,readiness:async()=>true,qualification:async()=>true,authorization:async()=>null,invoke:async()=>({schema:'ainvr.alarm_review.v1',real_score:.001,model:{package_sha256:'a'.repeat(64)}})});
 await worker.step();const low=await repo.events.findOne({alarm_id:row.alarm_id});assert.equal(low.handling.state,'unacknowledged');assert.equal(low.review.state,'uncertain');assert.notEqual(low.handling.disposition,'false_positive');
 const human=make();repo.evidenceVault=vaultFor(human);await repo.events.insertOne(human);const read=repo.evidenceVault.image;
 repo.evidenceVault.image=async(...args)=>{await repo.events.updateOne({alarm_id:human.alarm_id},{$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human'},$inc:{'handling.revision':1}});return read(...args)};
 await context.recoverOne();const done=await repo.events.findOne({alarm_id:human.alarm_id});assert.equal(done.handling.reviewed_by_kind,'human');assert.equal(done.review.context_state,'incomplete');
}));
test('database timeouts do not turn ready image evidence into a permanent missing-image verdict',{skip:!enabled},()=>fixture(async(repo,context)=>{
 const row=make();row.review.state='queued';delete row.review.context_state;row.review.context_started_at=Date.now()-60000;await repo.events.insertOne(row);
 context.publish=async()=>{};context.processCaptureJobs=async()=>{};context.maintain=async()=>{};context.prepareInputs=async()=>{throw Object.assign(Error('storage timeout'),{code:50})};
 await context.step();const waiting=await repo.events.findOne({alarm_id:row.alarm_id});assert.equal(waiting.review.state,'queued');assert.equal(waiting.review.context_state,undefined);
}));
