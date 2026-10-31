import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {parseAuthorization,authorizedResult,authorizedScores,confirmationAssessment} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';
const config={schema:'ainvr.review-authorization.v1',enabled:true,mode:'confirm_only',model_sha256:'a'.repeat(64),layout:'target-crop-v1',prompt_template:'alarm-review-zh-v1',caller_template:REVIEW_PROMPT_VERSION,labels:['person'],approve_above:.99,authorized_by:'test operator',authorized_at:'2026-10-26T00:00:00Z'};
const result={schema:'ainvr.alarm_review.v1',model:{package_sha256:config.model_sha256},prepared_image:{layout:config.layout},template:config.prompt_template,caller_template:REVIEW_PROMPT_VERSION,target_label:'person',real_score:.999};
test('operator permission is confirm-only, profile-bound and distinct from validation',()=>{
 const p=parseAuthorization(config);assert.ok(p);assert.ok(authorizedResult(p,result));
 for(const patch of [{enabled:false},{mode:'reject'},{approve_above:.5},{caller_template:'old'},{labels:[]},{model_sha256:'invalid'}])assert.equal(parseAuthorization({...config,...patch}),null);
 for(const patch of [{model:{package_sha256:'b'.repeat(64)}},{prepared_image:{layout:'composite'}},{target_label:'car'},{template:'changed'},{caller_template:'old'}])assert.equal(authorizedResult(p,{...result,...patch}),false);
 assert.notEqual(parseAuthorization({...config,approve_above:1}).id,p.id);
});
test('operator confirmations are real AI reviews; low scores, races and revoked permission stay manual',{skip:!process.env.AINVR_REVIEW_TEST_MONGO_URI},async()=>{
 const client=new MongoClient(process.env.AINVR_REVIEW_TEST_MONGO_URI);await client.connect();
 const db=client.db('ainvr_review_test_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 let permission=parseAuthorization(config),effect=async()=>{},answer={...result};const seen=[];
 const sample={seq:'1',frame_id:'f',source_pts_ns:'1',source_frame_index:'1',captured_at:new Date().toISOString(),track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20}};
 const make=(id,at)=>({alarm_id:id,occurred_at:at,channel_id:'c',input_stream_id:'in',frame_id:'f',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',labels:[{label_id:'person',name:'person'}]}},analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample]}},review:{state:'waiting_validation',context_state:'ready',generation:id,attempt:0,next_attempt_at:0,policy:{enabled:true,reject_below:.05,approve_above:.95},reference:{state:'completed',generation:id,prompt_version:REVIEW_PROMPT_VERSION}}});
 const worker=new ReviewWorker({events},{readiness:async()=>false,authorization:async()=>permission,context:{image:async r=>{seen.push(r.alarm_id);return {data:Buffer.from('jpeg')}}},invoke:async()=>{await effect();return answer;}});
 try{
  await worker.initialize();await events.insertMany([make('old','2026-10-26T01:00:00Z'),make('new','2026-10-26T02:00:00Z')]);await worker.step();
  const done=await events.findOne({alarm_id:'new'});assert.equal(seen[0],'new');assert.equal(done.handling.reviewed_by_kind,'ai');assert.equal(done.handling.state,'acknowledged');assert.equal(done.handling.disposition,'handled');assert.equal(done.review.decision_basis,'operator_authorized_confirm_only');assert.equal(done.review.authorization.accuracy_validated,false);assert.equal(done.review.reference,undefined);assert.equal(done.logs[0].action,'ai_review');
  answer={...result,real_score:.01};await worker.step();const low=await events.findOne({alarm_id:'old'});assert.equal(low.handling.state,'unacknowledged');assert.equal(low.review.reason,'manual_review_required');assert.equal(await worker.step(),false);
  answer={...result,real_score:.98};await events.insertOne(make('middle','2026-10-26T03:00:00Z'));await worker.step();assert.equal((await events.findOne({alarm_id:'middle'})).handling.state,'unacknowledged');assert.equal(await worker.step(),false);
  answer=result;await events.insertOne(make('human','2026-10-26T04:00:00Z'));effect=()=>events.updateOne({alarm_id:'human'},{$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human','handling.disposition':'false_positive'},$inc:{'handling.revision':1}});await worker.step();assert.equal((await events.findOne({alarm_id:'human'})).handling.reviewed_by_kind,'human');
  await events.insertOne(make('revoke','2026-10-26T05:00:00Z'));effect=async()=>{permission=null};await worker.step();assert.equal((await events.findOne({alarm_id:'revoke'})).handling.state,'unacknowledged');
  permission=parseAuthorization(config);effect=async()=>{};answer={...result,model:{package_sha256:'b'.repeat(64)}};await events.insertOne(make('model','2026-10-26T06:00:00Z'));await worker.step();assert.equal((await events.findOne({alarm_id:'model'})).handling.state,'unacknowledged');
  answer=result;await events.insertOne(make('generation','2026-10-26T07:00:00Z'));effect=()=>events.updateOne({alarm_id:'generation'},{$set:{'review.generation':'changed'}});await worker.step();assert.equal((await events.findOne({alarm_id:'generation'})).handling.state,'unacknowledged');

  // Exercise the production proof and worker with two actual appearance frames.
  permission=parseAuthorization({...config,minimum_frame_score:.95});effect=async()=>{};
  const twoFrames=(id,at)=>{const row=make(id,at);row.frame_id='f2';row.rule.snapshot.duration_ms=100;
   row.analysis_evidence.review_context.trace=[sample,{...sample,seq:'2',frame_id:'f2',source_pts_ns:'100000001',source_frame_index:'2'}];return row;};
  let outputs=[.9999,.9773];worker.invoke=async()=>({...result,real_score:outputs.shift()});
  await events.insertOne(twoFrames('corroborated','2026-10-26T08:00:00Z'));await worker.step();
  const corroborated=await events.findOne({alarm_id:'corroborated'});assert.equal(corroborated.handling.reviewed_by_kind,'ai');assert.deepEqual(corroborated.review.frame_scores,[.9999,.9773]);assert.equal(corroborated.review.authorization.minimum_frame_score,.95);
  outputs=[.9999,.94];await events.insertOne(twoFrames('conflicting','2026-10-26T09:00:00Z'));await worker.step();
  assert.equal((await events.findOne({alarm_id:'conflicting'})).handling.state,'unacknowledged');
 }finally{await worker.close();try{await db.dropDatabase();}finally{await client.close();}}
});

test('multi-frame confirmation requires a strong frame and unanimous per-frame support',()=>{
 const strict=parseAuthorization(config),balanced=parseAuthorization({...config,minimum_frame_score:.95});
 const rule={approve_above:.95};
 assert.equal(authorizedScores(strict,[.9999,.9773],rule),false);
 assert.equal(authorizedScores(balanced,[.9999,.9773],rule),true);
 for(const scores of [[.9773],[.98,.98],[1,.94],[1,.01],[],[1,NaN],[1,1.01]])assert.equal(authorizedScores(balanced,scores,rule),false);
 assert.equal(authorizedScores(balanced,[.9999,.9773],{approve_above:.98}),false);
 assert.equal(authorizedScores(balanced,[.9999,.999],{approve_above:1}),false);
 assert.equal(authorizedScores(balanced,[.9999],rule),true);
 assert.equal(parseAuthorization({...config,minimum_frame_score:.94}),null);
 assert.equal(parseAuthorization({...config,minimum_frame_score:1}),null);
 assert.notEqual(strict.id,balanced.id);
});


test('confirmation diagnostics retain the exact failed frame without treating maximum score as agreement',()=>{
 const p=parseAuthorization({...config,minimum_frame_score:.95}),rule={approve_above:.95};
 const gate=confirmationAssessment(p,[.7285974636292093,.9999739953455818],rule);
 assert.equal(gate.outcome,'frame_below_threshold');assert.deepEqual(gate.failed_frame_indices,[0]);
 assert.equal(gate.minimum_frame_score,.95);assert.equal(gate.strong_frame_score,.99);
 assert.equal(confirmationAssessment(p,[.98,.98],rule).outcome,'no_strong_frame');
 assert.equal(confirmationAssessment(p,[.95,.99],rule).outcome,'confirmed');
 assert.equal(confirmationAssessment(null,[1],rule).outcome,'not_authorized');
 assert.deepEqual(confirmationAssessment(p,[NaN],rule).frame_scores,[]);
 assert.deepEqual(confirmationAssessment(p,[.97,1],{approve_above:.98}).failed_frame_indices,[0]);
});
