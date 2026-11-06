import {FOCUS_LAYOUT,FOCUS_PROMPT_VERSION,FOCUS_DEFAULTS,FOCUS_TEMPLATE} from '../src/review-focus.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID,createHash} from 'node:crypto';
import {parseAuthorization} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
import {SECONDARY_REVIEW_VERSION,REVIEW_DECISION_VERSION} from '../src/review-secondary.mjs';
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
  const focused=body.preparation?.layout===FOCUS_LAYOUT;
  const result={...(focused?{class_scores:{person:scores[index],non_person:1-scores[index],uncertain:0},score_kind:'three_way_softmax_uncalibrated',submitted_prompt:'fixture ABC task'}:{}),schema:'ainvr.alarm_review.v1',model:{package_sha256:config.model_sha256},template:focused?FOCUS_TEMPLATE:config.prompt_template,prepared_image:{layout:body.preparation?.layout??config.layout,...(body.preparation?.layout===FOCUS_LAYOUT?{view:body.preparation.view,marker:body.preparation.show_target?'green-target-box':'no-target-box',region:body.preparation.region??[],expansion:body.preparation.view==='context'?1.6:1.15}:{}),target:body.preparation?[...body.preparation.target]:undefined,jpeg_base64:'aW1hZ2U=',width:body.preparation?.layout===FOCUS_LAYOUT?896:64,height:body.preparation?.layout===FOCUS_LAYOUT?448:64},real_score:scores[index]};
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
test('conflicting primary evidence receives bounded secondary review but cannot be outvoted',mongo,()=>fixture(async f=>{
 await f.worker.step();pending(await f.read());assert.equal(f.calls.length,4);
},{scores:[.01,.99999,.99999,.99999]}));
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

test('moderate complete primary evidence is no longer skipped; paired support is explicit and audited',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,4);
 assert.equal(row.handling.disposition,'handled');assert.equal(row.review.secondary.reason,'paired_views_confirmed');
 assert.equal(row.review.secondary.paired_support.minimum_frame_score,.85);
 assert.equal(row.review.decision_version,REVIEW_DECISION_VERSION);
 assert.equal(await f.worker.step(),false);
},{scores:[.9764,.8809,.9805,.8824],authorization:{...config,approve_above:.999,minimum_frame_score:.99,secondary:{...config.secondary,confirm_above:.999,paired_support:{minimum_frame_score:.85,strong_frame_score:.95}}}}));
test('old skipped evidence is reviewed once after decision version changes',mongo,()=>fixture(async f=>{
 await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'review.state':'waiting_validation','review.reference':{generation:f.row.review.generation,prompt_version:REVIEW_PROMPT_VERSION,authorization_id:parseAuthorization(config).id}}});
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,4);
 assert.equal(row.review.reference.decision_version,REVIEW_DECISION_VERSION);
 assert.equal(await f.worker.step(),false);
},{scores:[.7,.8,.7,.8]}));
test('paired policy cannot be smuggled through invalid authorization or confirm-only',()=>{
 const paired={minimum_frame_score:.85,strong_frame_score:.95};
 const good={...config,secondary:{...config.secondary,paired_support:paired}};
 assert.ok(parseAuthorization(good));assert.notEqual(parseAuthorization(good).id,parseAuthorization(config).id);
 for(const p of [{minimum_frame_score:.8499},{strong_frame_score:.9499},{minimum_frame_score:NaN},{strong_frame_score:1.01},{minimum_frame_score:1}])assert.equal(parseAuthorization({...good,secondary:{...good.secondary,paired_support:{...paired,...p}}}),null);
 assert.equal(parseAuthorization({...good,mode:'confirm_only'}),null);
});

const focusGrant={...config,focus:{...FOCUS_DEFAULTS},secondary:{...config.secondary,paired_support:{minimum_frame_score:.85,strong_frame_score:.95}}};
test('focus policy uses exact same target in tight/context views, handles and audits',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,4);assert.equal(row.handling.state,'acknowledged');
 assert.equal(f.calls[0].preparation.layout,FOCUS_LAYOUT);assert.equal(f.calls[0].preparation.view,'tight');assert.equal(f.calls[2].preparation.view,'context');
 assert.deepEqual(f.calls[0].preparation.target,f.calls[2].preparation.target);assert.equal(f.calls[0].alarm.kind,'person');
 assert.equal(row.review.caller_template,FOCUS_PROMPT_VERSION);assert.equal(row.review.input_profile,FOCUS_LAYOUT);assert.deepEqual(row.review.authorization.focus,focusGrant.focus);assert.equal(row.review.authorization.threshold,.99);assert.equal(row.review.authorization.minimum_frame_score,.95);assert.equal(row.review.secondary.confirm_above,.99);assert.equal(row.review.secondary.non_person_above,.99);assert.equal(row.review.secondary.reject_below,undefined);
},{authorization:focusGrant,scores:[.979,.98,.995,.996]}));
test('focus uncertain verdict is not reprocessed endlessly',mongo,()=>fixture(async f=>{
 await f.worker.step();pending(await f.read());assert.equal(await f.worker.step(),false);assert.equal(f.calls.length,4);
},{authorization:focusGrant,scores:[.6,.7,.6,.7]}));
for(const field of ['target','view','expansion','width'])test(`focus rejects corrupt primary ${field} before saving or handling`,mongo,()=>fixture(async f=>{
 f.setCorrupt((r,i)=>{if(i===0){if(field==='target')r.prepared_image.target[0]+=.1;else r.prepared_image[field]=field==='view'?'context':123;}});
 await f.worker.step();const row=await f.read();pending(row);assert.equal(row.review.reason,'invalid_model_result');assert.equal(f.saved.length,0);
},{authorization:focusGrant,scores:[.9999]}));

test('focus non-person class settles only after both complete views agree',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();assert.equal(f.calls.length,4);assert.equal(row.handling.disposition,'false_positive');assert.equal(row.review.secondary.reason,'focused_non_person_confirmed');assert.equal(row.review.secondary.non_target_evidence,undefined);
},{authorization:focusGrant,scores:[.001,.002,.001,.002]}));
test('focus uncertain class cannot be converted to false-positive',mongo,()=>fixture(async f=>{
 f.setCorrupt((r)=>{r.class_scores={person:r.real_score,non_person:0,uncertain:1-r.real_score};});
 await f.worker.step();pending(await f.read());assert.equal(f.calls.length,4);
},{authorization:focusGrant,scores:[.001,.002,.001,.002]}));
test('focus grant cannot accept a binary template disguised with an ABC layout',mongo,()=>fixture(async f=>{
 f.setCorrupt(r=>{r.template='alarm-review-zh-v1'});await f.worker.step();pending(await f.read());assert.equal((await f.read()).review.reason,'invalid_model_result');
},{authorization:focusGrant,scores:[.999]}));

test('rule evidence conflict blocks inference and preserves manual disposition',mongo,()=>fixture(async f=>{
 await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'analysis_evidence.review_context.trace.1.track_id':'wrong-target'}});
 await f.worker.step();const row=await f.read();pending(row);assert.equal(f.calls.length,0);assert.equal(row.review.reason,'rule_evidence_conflict');assert.equal(row.review.rule_evidence.blocking,true);assert.equal(row.review.token,undefined);
},{authorization:focusGrant,scores:[]}));

test('zoned appearance keeps identical historical zone in tight and expanded inputs',mongo,()=>fixture(async f=>{
 const points=[[0,0],[1,0],[1,1],[0,1]];
 await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'rule.snapshot.points':points,'rule.snapshot.zone_id':'zone','rule.snapshot.anchor':'center'}});
 await f.worker.step();const r=await f.read();assert.equal(r.handling.reviewed_by_kind,'ai');assert.equal(f.calls.length,4);
 for(const body of f.calls){assert.deepEqual(body.preparation.region,points);assert.equal(body.alarm.rule_context.region_required,true);}
},{authorization:focusGrant,scores:[.979,.98,.995,.996]}));
test('strong wider same-target evidence rescues a weak tight frame and audits the policy',mongo,()=>fixture(async f=>{
 f.setCorrupt((r,i)=>{if(i===0)r.class_scores={person:r.real_score,non_person:.012,uncertain:1-r.real_score-.012}});
 await f.worker.step();const r=await f.read();assert.equal(r.handling.reviewed_by_kind,'ai');assert.equal(r.review.secondary.reason,'focused_context_rescued');assert.equal(r.review.secondary.context_rescue.minimum_primary_person,.85);assert.equal(r.review.decision_path,'expanded_confirmation');
},{authorization:focusGrant,scores:[.878,.9996,.9966,.9989]}));

test('spatial audit preserves the storage metadata returned by the image store',mongo,()=>fixture(async f=>{
 const points=[[0,0],[1,0],[1,1],[0,1]];
 await f.events.updateOne({alarm_id:f.row.alarm_id},{$set:{'rule.snapshot.points':points,'rule.snapshot.zone_id':'zone','rule.snapshot.anchor':'center'}});
 f.setCorrupt((r,i,body)=>{if(i===4){r.template='spatial-review-abc-v1';r.review_scope='single_frame_spatial_shadow';r.spatial_scores={supported:.2,contradicted:.3,uncertain:.5};r.prepared_image={layout:'scene-review-v1',marker:'green-target-box',width:896,height:448,target:body.preparation.target,region:points};}});
 await f.worker.step();const r=await f.read();pending(r);assert.equal(f.calls.length,5);assert.equal(r.review.spatial.state,'completed');assert.equal(r.review.spatial_frames[0].storage,undefined);assert.equal(r.review.spatial_frames[0].layout,'scene-review-v1');assert.deepEqual(r.review.spatial_frames[0],r.review.spatial.frame);
},{authorization:focusGrant,scores:[.6,.7,.6,.7,.2]}));

test('marked views bind the exact target and reject a missing model-input marker',mongo,()=>fixture(async f=>{
 f.setCorrupt((r,i)=>{if(i===2)r.prepared_image.marker='no-target-box';});
 await f.worker.step();const row=await f.read();pending(row);
 assert.equal(row.review.reason,'invalid_model_result');
 assert.ok(f.calls.every(body=>body.preparation.show_target===true));
 assert.deepEqual(f.calls[0].preparation.target,f.calls[2].preparation.target);
},{authorization:focusGrant,scores:[.98,.98,.999,.999]}));

test('marked wider view supports an otherwise below-strong primary without lowering thresholds',mongo,()=>fixture(async f=>{
 await f.worker.step();const row=await f.read();
 assert.equal(row.handling.reviewed_by_kind,'ai');
 assert.equal(row.review.decision_version,REVIEW_DECISION_VERSION);
 assert.equal(row.review.secondary.reason,'focused_context_rescued');
 assert.equal(row.review.authorization.focus.strong_frame_score,.99);
 assert.ok(f.calls.every(body=>body.preparation.show_target===true));
},{authorization:focusGrant,scores:[.9882,.9834,.9996,.996]}));
