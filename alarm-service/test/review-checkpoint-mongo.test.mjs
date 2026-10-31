import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient, BSON} from 'mongodb';
import {randomUUID, createHash} from 'node:crypto';
import {ReviewWorker} from '../src/review-worker.mjs';
import {ReviewCheckpoint, CHECKPOINT_MAX_BYTES, CHECKPOINT_MAX_ENTRIES} from '../src/review-checkpoint.mjs';
import {parseAuthorization} from '../src/review-authorization.mjs';
import {REVIEW_PROMPT_VERSION} from '../src/review-prompt.mjs';
import {SECONDARY_REVIEW_VERSION} from '../src/review-secondary.mjs';

const uri = process.env.AINVR_REVIEW_TEST_MONGO_URI;
const mongo = {skip: !uri, timeout: 20000};
const config = {schema:'ainvr.review-authorization.v1', enabled:true, mode:'confirm_or_reject',
  model_sha256:'a'.repeat(64), layout:'target-crop-v1', prompt_template:'alarm-review-zh-v1',
  caller_template:REVIEW_PROMPT_VERSION, labels:['person'], approve_above:.99, minimum_frame_score:.95,
  authorized_by:'checkpoint test', authorized_at:'2026-10-31T00:00:00Z',
  secondary:{version:SECONDARY_REVIEW_VERSION, confirm_above:.99, reject_below:.01}};
function makeRow() {
  const sample = {seq:'1',frame_id:'f1',source_pts_ns:'1',source_frame_index:'1',captured_at:'2026-10-31T00:00:00Z',
    track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20}};
  return {alarm_id:randomUUID(),occurred_at:'2026-10-31T00:00:00Z',channel_id:'c',input_stream_id:'in',frame_id:'f2',
    direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,
    handling:{state:'unacknowledged',revision:0},
    rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',
      label_ids:['person'],behavior:'appearance',duration_ms:100,labels:[{label_id:'person',name:'person'}]}},
    analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},
      review_context:{trace:[sample,{...sample,seq:'2',frame_id:'f2',source_pts_ns:'100000001',source_frame_index:'2'}]}},
    review:{state:'queued',context_state:'ready',generation:randomUUID(),attempt:0,next_attempt_at:0,
      policy:{enabled:true,reject_below:.05,approve_above:.95}}};
}
async function fixture(fn, {negative=false, primary=false, noAuth=false}={}) {
  const client = new MongoClient(uri, {serverSelectionTimeoutMS:3000});
  await client.connect();
  const db = client.db('ainvr_checkpoint_test_' + randomUUID().replaceAll('-',''));
  const events = db.collection('events'), row = makeRow();
  let auth = noAuth ? null : parseAuthorization(config), fail = null, effect = async()=>{}, corrupt = ()=>{},
    now = Date.now(), imageSuffix = '', saveFail = false, actualModel = config.model_sha256;
  const calls=[], saved=[];
  const context = {
    image:async (r,s)=>({data:Buffer.from('input:'+s.frame_id+imageSuffix)}),
    savePrepared:async (r,s,image,options)=>{
      if (saveFail) {saveFail=false; throw Error('storage temporary');}
      const meta={frame_id:s.frame_id,key:createHash('sha256').update(image.jpeg_base64).digest('hex'),layout:image.layout};
      saved.push({frame:s.frame_id,image:structuredClone(image),secondary:!!options?.secondary});
      return meta;
    },
  };
  const invoke = async body => {
    const stage = !body.preparation ? 'non_target' : body.preparation.target[2]-body.preparation.target[0] > .25 ? 'expanded' : 'primary';
    const frame = Buffer.from(body.image.jpeg_base64,'base64').toString().includes('f1') ? 'f1' : 'f2';
    calls.push({stage,frame,body:structuredClone(body)});
    if (fail?.stage===stage && fail.frame===frame) {fail=null;throw Error('temporary model busy');}
    const score = stage==='non_target' ? .999 : negative ? .001 : stage==='expanded' || primary || frame==='f2' ? .99999 : .728597;
    const result={schema:'ainvr.alarm_review.v1',real_score:score,model:{package_sha256:actualModel},template:config.prompt_template};
    if (body.preparation) {
      result.prepared_image={layout:config.layout,target:[...body.preparation.target],jpeg_base64:Buffer.from(stage+':'+frame).toString('base64'),width:64,height:64};
      if(stage==='primary')result.context_image={layout:'context-marked-v1',jpeg_base64:Buffer.from('context:'+frame).toString('base64'),width:100,height:100};
    }
    corrupt(result,stage,frame);await effect(stage,frame);return result;
  };
  const options={context, invoke, readiness:async()=>noAuth, qualification:async()=>true,
    authorization:async()=>auth, clock:()=>now, policy:{retry_delay_s:0,max_attempts:3}};
  let worker=new ReviewWorker({events},options);
  const f={events,row,calls,saved,read:()=>events.findOne({alarm_id:row.alarm_id}),
    step:()=>worker.step(), restart:async()=>{await worker.close();worker=new ReviewWorker({events},options);await worker.initialize();},
    fail:(stage,frame)=>{fail={stage,frame};}, effect:fn=>{effect=fn;}, corrupt:fn=>{corrupt=fn;},
    changeAuth:patch=>{auth=parseAuthorization({...config,...patch});}, revoke:()=>{auth=null;},
    model:hash=>{actualModel=hash;}, input:suffix=>{imageSuffix=suffix;}, failSave:()=>{saveFail=true;},
    patch:update=>events.updateOne({alarm_id:row.alarm_id},update), advance:()=>{now+=100000;}};
  try {await worker.initialize();await events.insertOne(row);await fn(f);}
  finally {await worker.close();await db.dropDatabase();await client.close();}
}

for (const stage of ['primary','expanded','non_target']) test(`durable ${stage} retry reuses successful calls and restores exact audit JPEGs`, mongo, ()=>fixture(async f=>{
  f.fail(stage,'f2');await f.step();
  const first=await f.read(), cp=first.review.checkpoint;
  assert.equal(first.review.state,'queued');assert.ok(cp.entries.length>0);
  assert.ok(cp.entries.length<=12);assert.ok(BSON.calculateObjectSize(cp)<=CHECKPOINT_MAX_BYTES);
  const cached=cp.entries.map(e=>({stage:e.stage,frame:e.frame_id,response:e.response}));
  const before=f.calls.length;
  await f.restart();f.saved.length=0;await f.step();
  const done=await f.read();assert.equal(done.handling.state,'acknowledged');assert.equal(done.review.checkpoint,undefined);
  for(const entry of cached)assert.equal(f.calls.filter(c=>c.stage===entry.stage&&c.frame===entry.frame).length,entry.stage==='primary'&&entry.frame==='f1'?2:1);
  assert.ok(f.calls.length>before);
  for (const entry of cached) {
    if(entry.response.prepared_image)assert.ok(f.saved.some(s=>s.frame===entry.frame&&s.image.jpeg_base64===entry.response.prepared_image.jpeg_base64));
    if(entry.response.context_image)assert.ok(f.saved.some(s=>s.frame===entry.frame&&s.image.jpeg_base64===entry.response.context_image.jpeg_base64));
  }
  assert.equal(done.review.decision_path,stage==='non_target'?'explicit_non_target':stage==='primary'?'primary_confirmation':'expanded_confirmation');
  assert.equal(done.logs.at(-1).decision_path,done.review.decision_path);
},{negative:stage==='non_target',primary:stage==='primary'}));

for(const change of ['generation','auth','model','policy','context','input']) test(`${change} change prevents stale stage reuse`,mongo,()=>fixture(async f=>{
  f.fail('primary','f2');await f.step();assert.equal((await f.read()).review.checkpoint.entries.length,1);
  if(change==='generation')await f.patch({$set:{'review.generation':randomUUID()}});
  if(change==='auth')f.changeAuth({authorized_by:'replacement operator'});
  if(change==='model'){f.changeAuth({model_sha256:'b'.repeat(64)});f.model('b'.repeat(64));}
  if(change==='policy')await f.patch({$set:{'review.policy.approve_above':.96}});
  if(change==='context')await f.patch({$set:{'analysis_evidence.review_context.extra_binding':'new context'}});
  if(change==='input')f.input(':changed');
  await f.restart();await f.step();assert.equal(f.calls.filter(c=>c.stage==='primary'&&c.frame==='f1').length,2);
  assert.equal((await f.read()).handling.state,'acknowledged');
}));

test('qualification without operator package identity never reuses',mongo,()=>fixture(async f=>{
  f.fail('primary','f2');await f.step();assert.equal((await f.read()).review.checkpoint,undefined);
  await f.restart();await f.step();assert.equal(f.calls.filter(c=>c.stage==='primary'&&c.frame==='f1').length,2);
},{noAuth:true,primary:true}));

test('authorization is checked before the second primary call',mongo,()=>fixture(async f=>{
  f.effect(async(stage,frame)=>{if(stage==='primary'&&frame==='f1')f.revoke();});
  await f.step();assert.equal(f.calls.length,1);assert.equal((await f.read()).handling.state,'unacknowledged');
  assert.equal((await f.read()).review.reason,'authorization_changed');assert.equal((await f.read()).review.checkpoint,undefined);
}));

test('fresh anchor detects changed actual model despite unchanged auth and clears checkpoints',mongo,()=>fixture(async f=>{
  f.fail('primary','f2');await f.step();f.model('b'.repeat(64));
  await f.step();const result=await f.read();assert.equal(result.handling.state,'unacknowledged');assert.equal(result.review.state,'waiting_validation');
  assert.equal(f.calls.filter(c=>c.frame==='f1').length,2);assert.equal(result.review.checkpoint,undefined);
}));

for(const kind of ['template','layout'])test(`primary wrong ${kind} preserves reference behavior but never caches or authorizes`,mongo,()=>fixture(async f=>{
  f.corrupt((r,stage)=>{if(stage==='primary'){
    if(kind==='template')r.template='wrong';else r.prepared_image.layout='context-marked-v1';
  }});
  await f.step();const row=await f.read();assert.equal(row.handling.state,'unacknowledged');
  assert.equal(row.review.state,'waiting_validation');assert.equal(row.review.checkpoint,undefined);assert.equal(f.calls.length,2);
}));

for(const kind of ['schema','score','target'])test(`invalid ${kind} result is not checkpointed`,mongo,()=>fixture(async f=>{
  f.corrupt((r,stage,frame)=>{if(stage==='expanded'&&frame==='f1'){
    if(kind==='schema')r.schema='poison';if(kind==='score')r.real_score=NaN;if(kind==='target')r.prepared_image.target[0]+=.1;
  }});
  await f.step();const row=await f.read();assert.equal(row.review.reason,'invalid_model_result');
  assert.ok(row.review.checkpoint.entries.every(e=>e.stage==='primary'));assert.equal(row.handling.state,'unacknowledged');
}));

for(const change of ['human','generation'])test(`${change} fence wins even after a cached stage is reused`,mongo,()=>fixture(async f=>{
  f.fail('expanded','f2');await f.step();
  f.effect(async(stage,frame)=>{if(stage==='expanded'&&frame==='f2'){
    if(change==='human')await f.patch({$set:{'handling.state':'acknowledged','handling.reviewed_by_kind':'human','handling.disposition':'false_positive'},$inc:{'handling.revision':1}});
    else await f.patch({$set:{'review.generation':'replacement','review.state':'queued'}});
  }});
  await f.step();const done=await f.read();assert.ok(!(done.logs??[]).some(l=>l.action==='ai_review'));
  if(change==='human'){assert.equal(done.handling.reviewed_by_kind,'human');assert.equal(done.handling.revision,1);}
  else assert.equal(done.review.generation,'replacement');
}));

test('image persistence retry restores exact audit with one fresh primary anchor',mongo,()=>fixture(async f=>{
  f.failSave();await f.step();assert.equal((await f.read()).review.checkpoint.entries.length,1);
  await f.restart();await f.step();assert.equal(f.calls.filter(c=>c.stage==='primary'&&c.frame==='f1').length,2);
  assert.ok(f.saved.some(s=>s.image.layout==='context-marked-v1'));assert.equal((await f.read()).review.checkpoint,undefined);
}));

for(const field of ['frames','evidence_id'])test(`swapping original ${field} during cached positive review fences handling and preserves replacement`,mongo,()=>fixture(async f=>{
  const original=[{frame_id:'f1',key:'original-input'}];
  await f.patch({$set:{'review.frames':original,'review.evidence_id':'original-evidence'}});
  f.fail('expanded','f2');await f.step();
  assert.ok((await f.read()).review.checkpoint.entries.some(e=>e.stage==='expanded'&&e.frame_id==='f1'));
  const replacement=field==='frames'?[{frame_id:'f1',key:'replacement-input'}]:'replacement-evidence';
  f.effect(async(stage,frame)=>{if(stage==='expanded'&&frame==='f2'){
    await f.patch({$set:{['review.'+field]:replacement}});
  }});
  await f.step();const row=await f.read();
  assert.equal(f.calls.filter(c=>c.stage==='expanded'&&c.frame==='f1').length,1,'positive expanded checkpoint was reused');
  assert.equal(row.review.generation,f.row.review.generation);
  assert.deepEqual(row.review[field],replacement);
  assert.equal(row.handling.state,'unacknowledged');assert.equal(row.handling.revision,0);
  assert.ok(!(row.logs??[]).some(l=>l.action==='ai_review'));
}));

test('oversize responses skip caching without changing a valid verdict or losing audit images',mongo,()=>fixture(async f=>{
  f.corrupt(r=>{r.prepared_image.jpeg_base64='a'.repeat(CHECKPOINT_MAX_BYTES);});
  await f.step();const row=await f.read();assert.equal(row.handling.state,'acknowledged');
  assert.equal(row.review.checkpoint,undefined);assert.ok(f.saved.some(s=>s.image.jpeg_base64.length===CHECKPOINT_MAX_BYTES));
  assert.ok(BSON.calculateObjectSize(row)<CHECKPOINT_MAX_BYTES);
}));

test('checkpoint validates cache hits and evicts oldest entries to enforce twelve entries',mongo,async()=>{
  const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_checkpoint_test_'+randomUUID().replaceAll('-',''));
  try{
    const rows=db.collection('events'),row=makeRow();await rows.insertOne(row);
    const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'handling.state':'unacknowledged'};
    const auth=parseAuthorization(config);let calls=0;
    const cp=new ReviewCheckpoint({rows,row,fence,authorization:auth,binding:{test:'bounded'},currentAuthorization:async()=>auth,
      invoke:async()=>{calls++;return {model:{package_sha256:auth.model_sha256},template:auth.prompt_template,real_score:.999,prepared_image:{layout:auth.layout,jpeg_base64:'aW1hZ2U='}};}});
    await cp.initialize();const validate=async r=>assert.equal(r.real_score,.999);
    for(let i=0;i<12;i++)await cp.run('primary','f'+i,{image:{jpeg_base64:'aW1hZ2U='}},validate);
    assert.equal(cp.cache.entries.length,CHECKPOINT_MAX_ENTRIES);
    await cp.run('primary','overflow',{image:{}},validate);
    assert.equal((await rows.findOne(fence)).review.checkpoint.entries.length,12);
    await assert.rejects(cp.run('primary','f1',{image:{jpeg_base64:'aW1hZ2U='}},async()=>{throw Error('invalid_model_result');}),/invalid_model_result/);
    assert.equal(calls,13);
  }finally{await db.dropDatabase();await client.close();}
});
