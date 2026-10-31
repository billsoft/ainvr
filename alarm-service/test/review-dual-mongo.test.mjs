import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID,createHash} from 'node:crypto';
import {parseAuthorization} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
import {SECONDARY_REVIEW_VERSION} from '../src/review-secondary.mjs';
import {ReviewWorker} from '../src/review-worker.mjs';
const uri=process.env.AINVR_REVIEW_TEST_MONGO_URI;
const config={schema:'ainvr.review-authorization.v1',enabled:true,mode:'confirm_or_reject',model_sha256:'a'.repeat(64),layout:'target-crop-v1',prompt_template:'alarm-review-zh-v1',caller_template:REVIEW_PROMPT_VERSION,labels:['person'],approve_above:.99,minimum_frame_score:.95,authorized_by:'dual test operator',authorized_at:'2026-10-31T00:00:00Z',secondary:{version:SECONDARY_REVIEW_VERSION,confirm_above:.99,reject_below:.01}};
const actual=[.728597,.999974,.999997,.999999];
function make(){
 const sample={seq:'1',frame_id:'f1',source_pts_ns:'1',source_frame_index:'1',captured_at:new Date().toISOString(),track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20}};
 return {alarm_id:randomUUID(),occurred_at:new Date().toISOString(),channel_id:'c',input_stream_id:'in',frame_id:'f2',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',duration_ms:100,labels:[{label_id:'person',name:'person'}]}},analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample,{...sample,seq:'2',frame_id:'f2',source_pts_ns:'100000001',source_frame_index:'2'}]}},review:{state:'queued',context_state:'ready',generation:randomUUID(),attempt:0,next_attempt_at:0,policy:{enabled:true,reject_below:.05,approve_above:.95}}};
}
async function fixture(fn,{scores=actual,limited=false,authorization=config}={}){
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000});
 await client.connect();
 const db=client.db('ainvr_dual_worker_test_'+randomUUID().replaceAll('-','')),events=db.collection('events');
 const row=make(),calls=[],saved=[];let permission=parseAuthorization(authorization),effect=async()=>{},corrupt=()=>{};
 assert.ok(permission,'fixture authorization must parse');
 const context={
  image:async()=>({data:Buffer.from('in-memory-worker-input')}),
  savePrepared:async(r,s,image,options)=>{saved.push({frame_id:s.frame_id,options});return {frame_id:s.frame_id,key:createHash('sha256').update(JSON.stringify(image)).digest('hex'),layout:image.layout,target:image.target,...(options?.secondary?{secondary:true}:{})}}};
 if(limited)context.prepareInputs=async(r,proof)=>({mode:'verified_behavior_available_visuals',confirm_only:true,missing_frame_ids:[proof.samples[0].frame_id],items:[{sample:proof.samples.at(-1),source_kind:'retained_target',data:Buffer.from('crop')}]});
 const worker=new ReviewWorker({events},{context,readiness:async()=>false,authorization:async()=>permission,invoke:async body=>{
  const index=calls.length;calls.push(body);
  assert.ok(index<scores.length,'unexpected extra model invocation');
  const result={schema:'ainvr.alarm_review.v1',model:{package_sha256:config.model_sha256},template:config.prompt_template,prepared_image:{layout:config.layout,target:body.preparation?[...body.preparation.target]:undefined,jpeg_base64:'aW1hZ2U=',width:64,height:64},real_score:scores[index]};
  if(index>=4)delete result.prepared_image;
  corrupt(result,index,body);await effect(index,body);return result;
 }});
 const f={row,events,calls,saved,worker,read:()=>events.findOne({alarm_id:row.alarm_id}),setEffect:fn=>{effect=fn},setCorrupt:fn=>{corrupt=fn},revoke:()=>{permission=null}};
 try{await worker.initialize();await events.insertOne(row);await fn(f)}
 finally{await worker.close();try{await db.dropDatabase()}finally{await client.close()}}
}
const mongo={skip:!uri,timeout:15000};
const pending=row=>{assert.equal(row.handling.state,'unacknowledged');assert.notEqual(row.handling.reviewed_by_kind,'ai');assert.ok(!(row.logs??[]).some(log=>log.action==='ai_review'))};
test('dual authorization parse boundaries remain fail closed',()=>{
 assert.ok(parseAuthorization(config));
 for(const patch of [{confirm_above:.989999},{confirm_above:1.000001},{confirm_above:NaN},{reject_below:-.000001},{reject_below:.010001},{reject_below:Infinity},{version:'unknown'}])
  assert.equal(parseAuthorization({...config,secondary:{...config.secondary,...patch}}),null,JSON.stringify(patch));
 for(const secondary of [undefined,null,{}, {...config.secondary,confirm_above:'0.99'},{...config.secondary,reject_below:'0.01'}])assert.equal(parseAuthorization({...config,secondary}),null);
 for(const patch of [{labels:['car']},{labels:['person','car']},{mode:'reject'},{enabled:false},{minimum_frame_score:.949999},{minimum_frame_score:1},{model_sha256:'bad'}])assert.equal(parseAuthorization({...config,...patch}),null);
 assert.ok(parseAuthorization({...config,secondary:{...config.secondary,confirm_above:1,reject_below:0}}));
 assert.notEqual(parseAuthorization(config).id,parseAuthorization({...config,secondary:{...config.secondary,confirm_above:1}}).id);
 assert.notEqual(parseAuthorization(config).id,parseAuthorization({...config,secondary:{...config.secondary,reject_below:0}}).id);
 assert.ok(parseAuthorization({...config,mode:'confirm_only',secondary:undefined}));
});
test('actual weak/strong primary pair is confirmed by unanimous secondary evidence',mongo,()=>fixture(async f=>{
 assert.equal(await f.worker.step(),true);const row=await f.read();
 assert.equal(f.calls.length,4);assert.deepEqual(row.review.frame_scores,actual.slice(0,2));assert.deepEqual(row.review.secondary.frame_scores,actual.slice(2));
 assert.equal(row.handling.reviewed_by_kind,'ai');assert.equal(row.handling.disposition,'handled');assert.equal(row.handling.state,'acknowledged');assert.equal(row.review.decision_basis,'operator_authorized_dual_review');assert.equal(row.review.secondary.outcome,'confirmed');
 assert.deepEqual(row.review.secondary.frames.map(x=>x.frame_id),['f1','f2']);assert.equal(row.review.secondary_frames.length,2);
 assert.deepEqual(f.saved.map(x=>x.options?.secondary===true),[false,false,true,true]);
 assert.notEqual(f.calls[0].request_id,f.calls[2].request_id);assert.notDeepEqual(f.calls[0].preparation.target,f.calls[2].preparation.target);
 assert.deepEqual(row.review.secondary.frames[0].preparation_target,f.calls[2].preparation.target);assert.equal(row.logs.at(-1).action,'ai_review');assert.equal(row.review.authorization.accuracy_validated,false);
}));
test('negative primary and secondary require unanimous explicit nonperson proof to auto-dismiss',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,6);assert.equal(row.handling.reviewed_by_kind,'ai');assert.equal(row.handling.disposition,'false_positive');
 for(const request of f.calls.slice(4)){assert.equal(request.alarm.kind,'明确非人员目标');assert.equal(request.image.jpeg_base64,'aW1hZ2U=');assert.equal(request.image.fit,'strict');assert.equal(request.preparation,undefined);assert.match(request.alarm.description,/否/);assert.match(request.alarm.description,/昏暗|黑暗/);}
 assert.equal(f.saved.filter(x=>x.options?.secondary).length,2);assert.deepEqual(row.review.secondary.non_target_evidence.frame_scores,[.999997,.999999]);assert.deepEqual(row.review.secondary.non_target_evidence.frame_ids,['f1','f2']);assert.equal(row.review.decision_basis,'operator_authorized_dual_review');assert.equal(row.review.secondary.outcome,'false_positive');
},{scores:[.01,.02,.001,.002,.999997,.999999]}));
test('conflicting primary evidence stays manual without secondary calls',mongo,()=>fixture(async f=>{
 await f.worker.step();pending(await f.read());assert.equal(f.calls.length,2);
},{scores:[.01,.99999]}));
test('conflicting secondary evidence stays manual',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,4);assert.equal(row.review.secondary.outcome,'uncertain');assert.equal(row.review.state,'waiting_validation');
},{scores:[...actual.slice(0,2),.999999,.001]}));
test('limited retained evidence cannot automatically dismiss',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,1);assert.equal(row.review.secondary.reason,'incomplete_frames');
},{scores:[.001],limited:true}));
test('human decision during secondary inference wins',mongo,()=>fixture(async f=>{
 f.setEffect(async index=>{if(index===2)await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human','handling.disposition':'false_positive'},$inc:{'handling.revision':1}})});
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,3);assert.equal(row.handling.reviewed_by_kind,'human');assert.equal(row.handling.disposition,'false_positive');assert.equal(row.handling.revision,1);assert.ok(!(row.logs??[]).some(x=>x.action==='ai_review'));
}));
test('generation replacement during secondary inference wins',mongo,()=>fixture(async f=>{
 f.setEffect(async index=>{if(index===2)await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'review.generation':'replacement','review.state':'queued','review.reason':'replacement_pending'}})});
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,3);assert.equal(row.review.generation,'replacement');assert.equal(row.review.state,'queued');assert.equal(row.review.reason,'replacement_pending');
}));
test('authorization revoked during last secondary invocation leaves alarm pending',mongo,()=>fixture(async f=>{
 f.setEffect(async index=>{if(index===3)f.revoke()});await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,4);assert.equal(row.review.secondary.reason,'authorization_changed');assert.equal(row.review.secondary.outcome,'uncertain');
}));
for(const kind of ['target','model'])test(`corrupt secondary ${kind} is rejected before automatic handling`,mongo,()=>fixture(async f=>{
 f.setCorrupt((result,index)=>{if(index===2){if(kind==='target')result.prepared_image.target[0]+=.1;else result.model.package_sha256='b'.repeat(64)}});
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,3);assert.equal(row.review.reason,'invalid_model_result');assert.equal(f.saved.filter(x=>x.options?.secondary).length,0);
}));
test('legacy confirm-only authorization cannot auto-dismiss or run a secondary pass',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,2);assert.equal(row.review.secondary,undefined);
},{scores:[.001,.002],authorization:{...config,mode:'confirm_only',secondary:undefined}}));

test('dark or unclear third-pass evidence stays pending despite both negative earlier passes',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,6);assert.equal(row.review.secondary.outcome,'uncertain');
},{scores:[.01,.02,.001,.002,.888,.999999]}));
for(const kind of ['missing_score','schema','model','template','invalid_score'])test(`missing or corrupt third-pass ${kind} cannot auto-reject`,mongo,()=>fixture(async f=>{
 f.setCorrupt((result,index)=>{if(index===4){
  if(kind==='missing_score')delete result.real_score;
  if(kind==='schema')delete result.schema;
  if(kind==='template')result.template='wrong-template';
  if(kind==='model')result.model.package_sha256='b'.repeat(64);
  if(kind==='invalid_score')result.real_score=1.01;
 }});
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,5);assert.equal(row.review.reason,'invalid_model_result');
},{scores:[.01,.02,.001,.002,.999999,.999999]}));
