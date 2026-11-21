import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {createServer} from 'node:http';
import {canonicalDigest,validateMotionMetadata,motionStatus,createMotionAdmission,admitFrame,validatePendingPermit} from '../src/motion-admission.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {validateRule} from '../src/domain.mjs';
import {measuredCoverage} from '../src/flow-statistics.mjs';
import {ObservationPump} from '../src/observation-pump.mjs';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createApp} from '../src/http.mjs';
import {observationBarrier} from '../src/observation-barrier.mjs';

const rule={id:'r',version:1,name:'Cross',channel_id:'c',input_stream_id:'in',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',points:[[.7,0],[1,0],[1,1],[.7,1]]};
const frame=(seq,x)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_frame_index:String(seq),source_pts_ns:String(BigInt(seq)*1000000000n),captured_at:new Date(Date.UTC(2026,10,21)+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(BigInt(seq)*1000000000n),bbox:{x:x*1000-10,y:100,w:20,h:100}}]});
const envelope=(seq,x)=>({schema_version:'1.0',producer_id:'native',offset:String(seq),frame:frame(seq,x)});
const metadata=(rules=[rule],epoch='a')=>({protocol:1,scopes:[{input_stream_id:'in',channel_id:'c',guard_epoch:epoch.repeat(64),execution_digest:canonicalDigest(rules.filter(r=>r.channel_id==='c'&&r.input_stream_id==='in').sort((a,b)=>a.id.localeCompare(b.id)))}]});
const snapshot=(revision=1,rules=[rule],epoch='a')=>({schema_version:'1.0',revision:String(revision),rules,motion_admission:metadata(rules,epoch)});
const permit=input=>({decision:'permit',permit:Object.fromEntries([...['protocol','frame_digest','producer_id','offset','channel_id','input_stream_id','guard_epoch','execution_digest'].map(k=>[k,input[k]]),['authorized_at',new Date().toISOString()]])});

test('metadata hashes raw rules before defaults and scopes use publisher ordering',()=>{
 const meta=metadata();assert.deepEqual(validateMotionMetadata(meta,[rule]),meta);
 assert.notEqual(canonicalDigest([validateRule(rule)]),meta.scopes[0].execution_digest);
 assert.throws(()=>validateMotionMetadata(meta,[{...rule,name:'different'}]),e=>e.code==='invalid_motion_scope');
 assert.throws(()=>validateMotionMetadata({...meta,scopes:[...meta.scopes,...meta.scopes]},[rule]));
 assert.equal(motionStatus(null),null);
 assert.equal(motionStatus(meta).scopes_digest,canonicalDigest(meta.scopes));
});
test('HTTP installation drains pre-registration consumers before acknowledging a protected snapshot',async()=>{
 let applied=false;
 const repo={ruleSnapshots:{apply:async()=>{applied=true;return {applied:true};}}};
 const release=observationBarrier(repo).enter();
 const token='test-only-operator-'.repeat(3),app=createApp({repository:repo,apiToken:token,producerToken:'producer-'.repeat(5),consumer:{}});
 try{
  const request=app.inject({method:'POST',url:'/v1/configuration/rules',headers:{authorization:'Bearer '+token,'x-ainvr-actor':'test'},payload:snapshot()});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(applied,false);
  release();assert.equal((await request).statusCode,200);assert.equal(applied,true);
 }finally{release();await app.close();}
});
test('permit replay binds immutable producer/offset/frame and cannot authorize the next input',async()=>{
 const e=envelope(1,.5),scope=metadata().scopes[0],fingerprint='f'.repeat(64);
 const got=await admitFrame({admit:async input=>permit(input)},scope,e,fingerprint);
 const pending={offset:e.offset,fingerprint,motion_input:got.input,motion_permit:got.permit};
 validatePendingPermit(pending,'c','native');
 for(const changed of [{offset:'2'},{fingerprint:'e'.repeat(64)},{motion_permit:{...got.permit,input_stream_id:'other'}}])
  assert.throws(()=>validatePendingPermit({...pending,...changed},'c','native'),e=>e.code==='motion_admission_required');
 for(const transport of [null,{admit:async()=>({decision:'retry',reason:'moving'})},{admit:async()=>{throw Error('PG down');}},{admit:async input=>({...permit(input),permit:{...permit(input).permit,offset:'2'}})}])
  await assert.rejects(admitFrame(transport,scope,e,fingerprint),e=>e.code==='motion_admission_required');
 let called=false;
 for(const index of [undefined,null,9007199254740995])await assert.rejects(admitFrame({admit:async()=>{called=true;}},scope,
  {...e,frame:{...e.frame,source_frame_index:index}},fingerprint),e=>e.code==='invalid_integer');
 assert.equal(called,false);
});
test('admission transport uses authenticated loopback POST and rejects nonlocal endpoints',async()=>{
 assert.throws(()=>createMotionAdmission({control_url:'http://example.com:1234',service_token:'private'}));
 let observed;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;observed={url:req.url,method:req.method,token:req.headers['x-service-token'],body:JSON.parse(raw)};res.setHeader('content-type','application/json');res.end(JSON.stringify(permit(observed.body)));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const client=createMotionAdmission({control_url:`http://127.0.0.1:${server.address().port}/`,service_token:'test-only-token'});
  const result=await admitFrame(client,metadata().scopes[0],envelope(1,.5),'f'.repeat(64));
  assert.equal(observed.url,'/api/internal/ptz-motion/admit');assert.equal(observed.method,'POST');assert.equal(observed.token,'test-only-token');
  assert.equal(result.permit.frame_digest,'f'.repeat(64));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

const mongo=process.env.AINVR_ALARM_TEST_MONGO==='1';
async function isolated(run){
 const client=new MongoClient(process.env.AINVR_ALARM_TEST_MONGO_URI??'mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{const repo=new AlarmRepository(db);await repo.initialize();await run(repo,db);}finally{await db.dropDatabase();await client.close();}
}
test('Mongo atomic snapshot persists raw metadata, registry survives omission and author geometry stays strict',{skip:!mongo},()=>isolated(async(repo,db)=>{
 const applied=await repo.ruleSnapshots.apply(snapshot(),'test');assert.deepEqual(applied.motion_admission,motionStatus(metadata()));
 const restarted=new AlarmRepository(db);assert.deepEqual((await restarted.executionRules('c')).scopes,metadata().scopes);
 const changed={...rule,points:[[.6,0],[1,0],[1,1],[.6,1]]};
 await assert.rejects(repo.ruleSnapshots.apply(snapshot(2,[changed],'b'),'test'),e=>e.code==='rule_version_conflict');
 await assert.rejects(repo.ruleSnapshots.apply(snapshot(1,[rule],'b'),'test'),e=>e.code==='revision_conflict');
 await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'2',rules:[rule]},'test');
 assert.equal((await repo.ruleSnapshots.status()).motion_admission,null);
 assert.equal((await restarted.executionRules('c')).required.length,1);
 await assert.rejects(new ObservationConsumer(restarted).consume(envelope(1,.5)),e=>e.code==='motion_admission_required');
 assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,null);
}));
test('crash between durable registration and atomic publication leaves the old snapshot fail closed',{skip:!mongo},()=>isolated(async repo=>{
 await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[rule]},'test');
 const collection=repo.ruleSnapshots.collection,replace=collection.replaceOne;
 collection.replaceOne=async()=>{throw Error('publication crash');};
 try{await assert.rejects(repo.ruleSnapshots.apply(snapshot(2),'test'),/publication crash/);}finally{collection.replaceOne=replace;}
 assert.equal((await repo.ruleSnapshots.current()).revision,'1');assert.equal((await repo.ruleSnapshots.requiredForChannel('c')).length,1);
 await assert.rejects(new ObservationConsumer(repo).consume(envelope(1,.5)),e=>e.code==='motion_admission_required');
 await repo.ruleSnapshots.apply(snapshot(2),'test');
 let reads=0;const current=repo.ruleSnapshots.current.bind(repo.ruleSnapshots);repo.ruleSnapshots.current=()=>{reads++;return current();};
 await repo.executionRules('c');assert.equal(reads,1);
}));
test('only a new protected scope drains; same revision and installed updates do not pause fixed-camera consumers',{skip:!mongo},()=>isolated(async repo=>{
 assert.equal(await repo.ruleSnapshots.needsMotionDrain(snapshot()),true);
 await repo.ruleSnapshots.apply(snapshot(),'test');
 assert.equal(await repo.ruleSnapshots.needsMotionDrain(snapshot()),false);
 assert.equal(await repo.ruleSnapshots.needsMotionDrain(snapshot(2,[rule],'b')),false);
 const extra={...rule,id:'extra',input_stream_id:'extra'};
 const next=snapshot(3,[rule,extra]);next.motion_admission.scopes.push({input_stream_id:'extra',channel_id:'c',guard_epoch:'a'.repeat(64),execution_digest:canonicalDigest([extra])});
 assert.equal(await repo.ruleSnapshots.needsMotionDrain(next),true);
 const token='test-only-operator-'.repeat(3),app=createApp({repository:repo,apiToken:token,producerToken:'producer-'.repeat(5),consumer:{}});
 const release=observationBarrier(repo).enter();
 try{
  for(const body of [snapshot(),snapshot(2,[rule],'b')]){
   const response=await app.inject({method:'POST',url:'/v1/configuration/rules',headers:{authorization:'Bearer '+token,'x-ainvr-actor':'test'},payload:body});
   assert.equal(response.statusCode,200); // still holding the simulated fixed-camera consumer
  }
 }finally{release();await app.close();}
}));
test('denied or unavailable PG never consumes; unguarded fixed camera has no admission request',{skip:!mongo},()=>isolated(async repo=>{
 const fixed={...rule,id:'fixed',channel_id:'fixed',input_stream_id:'fixed-in'};
 await repo.ruleSnapshots.apply(snapshot(1,[rule,fixed]),'test');let calls=0;
 repo.motionAdmission={admit:async()=>{calls++;return {decision:'retry',reason:'moving'};}};
 const consumer=new ObservationConsumer(repo);
 await assert.rejects(consumer.consume(envelope(1,.5)),e=>e.code==='motion_admission_required');
 assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,null);assert.equal(await repo.behaviors.collection.countDocuments(),0);
 await consumer.consume({...envelope(1,.5),frame:{...frame(1,.5),channel_id:'fixed',input_stream_id:'fixed-in'}});
 assert.equal(calls,1);assert.equal((await repo.checkpoints.findOne({channel_id:'fixed'})).offset,'1');
 repo.motionAdmission={admit:async()=>{throw Error('unavailable');}};
 await assert.rejects(consumer.consume(envelope(1,.5)),e=>e.code==='motion_admission_required');
}));
test('required registration is scoped to source and processor, not unrelated fixed input later using that processor',{skip:!mongo},()=>isolated(async repo=>{
 await repo.ruleSnapshots.apply(snapshot(),'test');
 const fixed={...rule,version:2,input_stream_id:'fixed-in'};
 await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'2',rules:[fixed]},'test');
 repo.motionAdmission={admit:async()=>{throw Error('fixed input must not request admission');}};
 const result=await new ObservationConsumer(repo).consume({...envelope(1,.5),frame:{...frame(1,.5),input_stream_id:'fixed-in'}});
 assert.equal(result.durable,true);
}));
for(const point of ['prepared','behavior_inserted','event_inserted','before_checkpoint'])test(`pre-motion authorized pending survives ${point}, restart and later motion without a new permit`,{skip:!mongo},()=>isolated(async(repo,db)=>{
 await repo.ruleSnapshots.apply(snapshot(),'test');let calls=0;
 repo.motionAdmission={admit:async input=>{calls++;return permit(input);}};
 await new ObservationConsumer(repo).consume(envelope(1,.5));let crashed=false;
 const broken=new ObservationConsumer(repo,{hook:async p=>{if(p===point&&!crashed){crashed=true;throw Error('crash');}}});
 await assert.rejects(broken.consume(envelope(2,.8)),/crash/);
 const pending=(await repo.checkpoints.findOne({channel_id:'c'})).pending;assert.ok(pending.motion_permit);assert.equal(calls,2);
 const paused={...rule,state:'paused',view_epoch:'b'.repeat(64),view_not_before:frame(3,.8).captured_at};
 await repo.ruleSnapshots.apply(snapshot(2,[paused],'b'),'test');
 const restarted=new AlarmRepository(db);restarted.motionAdmission={admit:async()=>{throw Error('must not request');}};
 await new ObservationConsumer(restarted).consume(envelope(2,.8));
 assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),1);
 assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2');
}));
test('legacy pending is retained and reported, never retroactively signed or discarded',{skip:!mongo},()=>isolated(async repo=>{
 await repo.saveRule(rule,0,'test');await new ObservationConsumer(repo).consume(envelope(1,.5));
 await assert.rejects(new ObservationConsumer(repo,{hook:async p=>{if(p==='prepared')throw Error('crash');}}).consume(envelope(2,.8)),/crash/);
 await repo.ruleSnapshots.apply(snapshot(),'test');let called=false;repo.motionAdmission={admit:async()=>{called=true;}};
 await assert.rejects(new ObservationConsumer(repo).consume(envelope(2,.8)),e=>e.code==='motion_admission_required');
 const checkpoint=await repo.checkpoints.findOne({channel_id:'c'});assert.ok(checkpoint.pending);assert.equal(checkpoint.offset,'1');assert.equal(called,false);
}));
test('changed guard epoch independently breaks continuity even without an intermediate paused frame',{skip:!mongo},()=>isolated(async repo=>{
 await repo.ruleSnapshots.apply(snapshot(),'test');repo.motionAdmission={admit:async input=>permit(input)};
 const consumer=new ObservationConsumer(repo);await consumer.consume(envelope(1,.5));
 await repo.ruleSnapshots.apply(snapshot(2,[rule],'b'),'test');
 const result=await consumer.consume(envelope(2,.8));assert.ok(result.issues.includes('view_changed'));
 assert.equal(await repo.events.countDocuments(),0);assert.equal(await repo.behaviors.collection.countDocuments(),0);
}));
test('counter-only movement leaves an unknown coverage gap and cannot manufacture a crossing on resume',{skip:!mongo},()=>isolated(async repo=>{
 const counter={...rule,id:'flow-c',counter_id:'people',behavior:'region_traverse',alarm_enabled:false,
  zone_id:'zone',zone_version:1,points:[[.3,0],[.7,0],[.7,1],[.3,1]],edge_ids:['top','right','bottom','left']};
 await repo.ruleSnapshots.apply(snapshot(1,[counter]),'test');let allowed=true;
 repo.motionAdmission={admit:async input=>allowed?permit(input):{decision:'retry',reason:'moving'}};
 const consumer=new ObservationConsumer(repo);await consumer.consume(envelope(1,.1));await consumer.consume(envelope(2,.5));
 allowed=false;await assert.rejects(consumer.consume(envelope(3,.9)),e=>e.code==='motion_admission_required');
 const resumed={...counter,view_epoch:'b'.repeat(64),view_not_before:frame(10,.5).captured_at};
 await repo.ruleSnapshots.apply(snapshot(2,[resumed],'b'),'test');allowed=true;
 await consumer.consume(envelope(10,.5));await consumer.consume(envelope(11,.9));
 assert.equal(await repo.behaviors.collection.countDocuments(),0);assert.equal(await repo.events.countDocuments(),0);
 const rows=await repo.flow.coverage.find({}).toArray();
 const coverage=measuredCoverage(rows,frame(3,.5).captured_at,frame(9,.5).captured_at);
 assert.equal(coverage.state,'no_data');assert.equal(coverage.covered_ms,0);
 assert.ok(rows.every(r=>!(r.from<frame(3,.5).captured_at&&r.to>frame(9,.5).captured_at)));
}));

const rawHash=s=>createHash('sha256').update(s).digest('hex');
test('registered paused pump preserves legacy pending and missing metadata never deletes journal input',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-motion-')),folder=path.join(root,rawHash('c'));
 const labels=[{class_id:0,label_id:'person',name:'Person',description:'person'}];
 const sample={schema_version:'1.0',producer_id:'native',offset:'1',channel_id:'c',stream_url:'rtmp://127.0.0.1/live/cam',stream_session_id:'s',source_frame_index:'1',source_pts_ns:'1000000000',timestamp:Date.now()/1000,width:1000,height:1000,model:{id:'test',label_catalog:{schema_version:'1.0',adapter:'test',labels}},tracks:[]};
 let current={rules:[{...rule,state:'paused'}]},pending={offset:'0'},consumed=0;
 const repo={ruleSnapshots:{current:async()=>current,requiredForChannel:async()=>[{channel_id:'c',input_stream_id:'in'}]},checkpoints:{findOne:async()=>pending}};
 const pump=new ObservationPump(root,{consume:async()=>{consumed++;return {durable:true};}},repo);
 try{
  await mkdir(folder);await writeFile(path.join(folder,'00000000000000000001.json'),JSON.stringify(sample));
  await pump.tick();assert.equal((await readdir(folder)).length,1);assert.equal(pump.status.channel_issues[0].reason,'motion_metadata_missing');
  current={...current,motion_admission:metadata()};await pump.tick();assert.equal((await readdir(folder)).length,1);
  assert.equal(pump.status.channel_issues[0].reason,'motion_pending_requires_replay');
  pending=null;await pump.tick();assert.equal((await readdir(folder)).length,0);assert.equal(consumed,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
for(const authorized of [true,false])test(`paused pump ${authorized?'finishes authorized pre-motion pending':'retains legacy pending without reauthorization'}`,{skip:!mongo},()=>isolated(async repo=>{
 await repo.ruleSnapshots.apply(snapshot(),'test');repo.motionAdmission={admit:async input=>permit(input)};
 await new ObservationConsumer(repo).consume(envelope(1,.5));
 await assert.rejects(new ObservationConsumer(repo,{hook:async p=>{if(p==='prepared')throw Error('prepared crash');}}).consume(envelope(2,.8)),/prepared crash/);
 if(!authorized)await repo.checkpoints.updateOne({channel_id:'c'},{$unset:{'pending.motion_permit':'','pending.motion_input':''}});
 const paused={...rule,state:'paused',view_epoch:'b'.repeat(64),view_not_before:frame(3,.8).captured_at};
 await repo.ruleSnapshots.apply(snapshot(2,[paused],'b'),'test');
 repo.motionAdmission={admit:async()=>{throw Error('paused replay must not request a new permit');}};
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-motion-replay-')),folder=path.join(root,rawHash('c'));
 const native={schema_version:'1.0',producer_id:'native',offset:'2',channel_id:'c',stream_url:'rtmp://127.0.0.1/live/cam',stream_session_id:'s',source_frame_index:'2',source_pts_ns:'2000000000',timestamp:Date.parse(frame(2,.8).captured_at)/1000,width:1000,height:1000,model:{id:'test',label_catalog:{schema_version:'1.0',adapter:'test',labels:[{class_id:0,label_id:'person',name:'Person',description:'person'}]}},tracks:[]};
 const consumer=new ObservationConsumer(repo),pump=new ObservationPump(root,consumer,repo);
 try{
  await mkdir(folder);await writeFile(path.join(folder,'00000000000000000002.json'),JSON.stringify(native));
  await pump.tick();
  if(authorized){
   await pump.settleWindow();
   assert.equal((await readdir(folder)).length,0);assert.equal(await repo.events.countDocuments(),1);
   const checkpoint=await repo.checkpoints.findOne({channel_id:'c'});assert.equal(checkpoint.pending,null);assert.equal(checkpoint.offset,'2');
   await pump.tick();assert.equal(await repo.behaviors.collection.countDocuments(),1);
  }else{
   assert.equal((await readdir(folder)).length,1);assert.equal(await repo.events.countDocuments(),0);
   const checkpoint=await repo.checkpoints.findOne({channel_id:'c'});assert.ok(checkpoint.pending);assert.equal(checkpoint.offset,'1');
   assert.equal(pump.status.channel_issues[0].reason,'motion_pending_requires_replay');
  }
 }finally{await pump.close();await rm(root,{recursive:true,force:true});}
}));
