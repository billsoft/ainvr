import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {observationEnvelope,ObservationPump} from '../src/observation-pump.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {digest} from '../src/domain.mjs';
const labels=[{class_id:0,label_id:'person',name:'Person',description:''}],version='labels-'+digest(['test_bpu',labels]);
const streamUrl='rtmp://127.0.0.1:1935/live/test',rawHash=value=>createHash('sha256').update(value).digest('hex');
const binding={input_stream_id:'input',geometry_revision:'g',label_map_version:version,width:1000,height:1000,stream_fingerprint:rawHash(streamUrl),not_before:'2026-10-19T00:00:00Z'};
const rule={id:'r',monitor_id:'m',version:1,name:'Gate',channel_id:'processor',input_stream_id:'input',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:version,behavior:'appearance',source_binding:binding};
const sample={schema_version:'1.0',producer_id:'native',offset:'0',channel_id:'processor',stream_url:streamUrl,stream_session_id:'s',source_frame_index:'9007199254740995',source_pts_ns:'9007199254740993',timestamp:Date.parse(binding.not_before)/1000+1,width:1000,height:1000,model:{id:'test',label_catalog:{schema_version:'1.0',adapter:'test_bpu',labels}},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:'9007199254740993',bbox:{x:200,y:400,w:20,h:20}}]};
test('actual label catalog, dimensions, stream binding and frozen cutover gate journal input',()=>{
 const e=observationEnvelope(sample,[rule]).envelope;
 assert.equal(e.frame.source_pts_ns,'9007199254740993');assert.equal(e.frame.frame_id,'s:9007199254740995');assert.equal(e.frame.input_stream_id,'input');
 assert.equal(observationEnvelope({...sample,width:3840},[rule]).ignored,'source_binding_mismatch');
 assert.equal(observationEnvelope({...sample,timestamp:0},[rule]).ignored,'before_monitor_binding');
 assert.equal(observationEnvelope(sample,[{...rule,source_binding:null}]).waiting,'source_binding_unavailable');
 assert.equal(observationEnvelope(sample,[]).ignored,'no_active_monitor');
 const changed=structuredClone(sample);changed.model.label_catalog.labels[0].description='changed';
 assert.equal(observationEnvelope(changed,[rule]).ignored,'source_binding_mismatch');
});
test('failed durable consumption retains the ordered head and never consumes later records',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-observations-')),dir=path.join(root,rawHash('processor'));
 try{
  await mkdir(dir);for(const offset of ['0','1'])await writeFile(path.join(dir,offset.padStart(20,'0')+'.json'),JSON.stringify({...sample,offset}));
  const seen=[];let fail=true;
  const pump=new ObservationPump(root,{consume:async e=>{seen.push(e.offset);if(fail)throw Error('storage down');return {durable:true}}},{ruleSnapshots:{current:async()=>({rules:[rule]})}});
  await pump.tick();assert.deepEqual(seen,['0']);assert.equal((await readdir(dir)).length,2);assert.equal(pump.status.state,'degraded');
  fail=false;await pump.tick();assert.deepEqual(seen,['0','0','1']);assert.equal((await readdir(dir)).length,0);assert.equal(pump.status.consumed,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('native C++ journal reaches real Mongo alarm and behavior facts without truncating PTS',{skip:!process.env.AINVR_NATIVE_JOURNAL_ROOT||process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028');await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule,0,'test');
  await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[rule]},'test');
  const pump=new ObservationPump(process.env.AINVR_NATIVE_JOURNAL_ROOT,new ObservationConsumer(repo),repo);await pump.tick();
  assert.equal(pump.status.consumed,3);assert.equal(pump.status.failed,0);assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),1);
  const checkpoint=await repo.checkpoints.findOne({channel_id:'processor'});assert.equal(checkpoint.offset,'2');assert.equal(checkpoint.checkpoint.pts,'9007199254740996');
  const fact=await repo.behaviors.collection.findOne();assert.equal(fact.source_frame_index,'1');assert.equal(fact.source_pts_ns,'9007199254740994');
  const folders=await readdir(process.env.AINVR_NATIVE_JOURNAL_ROOT);const state=JSON.parse(await readFile(path.join(process.env.AINVR_NATIVE_JOURNAL_ROOT,folders[0],'producer.json'),'utf8'));
  assert.equal(state.producer_id,checkpoint.producer_id);
 }finally{await db.dropDatabase();await client.close();}
});


test('blocked and incompatible sources expose actionable diagnostics and recover without deleting unconsumed data',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-observation-health-')),dir=path.join(root,rawHash('processor'));
 let rules=[{...rule,source_binding:null}];const seen=[];
 const pump=new ObservationPump(root,{consume:async e=>{seen.push(e.offset);return {durable:true}}},{ruleSnapshots:{current:async()=>({rules})}});
 try{
  await mkdir(dir);const file=path.join(dir,'00000000000000000000.json');await writeFile(file,JSON.stringify(sample));
  await pump.tick();assert.equal(pump.status.pending,1);assert.equal(pump.status.state,'degraded');
  assert.equal(pump.status.channel_issues[0].reason,'source_binding_unavailable');assert.equal(pump.status.channel_issues[0].state,'blocked');
  assert.equal((await readdir(dir)).length,1);assert.equal(seen.length,0);
  rules=[rule];await pump.tick();assert.equal(pump.status.channel_issues.length,0);assert.deepEqual(seen,['0']);
  await writeFile(path.join(dir,'00000000000000000001.json'),JSON.stringify({...sample,offset:'1',width:3840}));
  await pump.tick();assert.equal(pump.status.pending,0);assert.equal(pump.status.state,'degraded');
  assert.equal(pump.status.channel_issues[0].reason,'source_binding_mismatch');assert.equal(pump.status.channel_issues[0].state,'ignored');
  await pump.tick();assert.equal(pump.status.channel_issues.length,1); // Last source incompatibility stays visible between frames.
  await writeFile(path.join(dir,'00000000000000000002.json'),JSON.stringify({...sample,offset:'2'}));
  await pump.tick();assert.equal(pump.status.state,'ready');assert.equal(pump.status.channel_issues.length,0);
  assert.ok(!JSON.stringify(pump.status).includes('rtmp://'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('consumed deletion ACKs sync once per bounded batch; failure remains visible and replay is idempotent',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-batch-ack-')),dir=path.join(root,rawHash('processor'));
 try{
  await mkdir(dir);const seen=new Set();let unique=0,syncs=0;
  const values=Array.from({length:20},(_,i)=>({...sample,offset:String(i)}));
  const write=async()=>{for(const value of values)await writeFile(path.join(dir,value.offset.padStart(20,'0')+'.json'),JSON.stringify(value));};
  await write();const pump=new ObservationPump(root,{consume:async e=>{if(!seen.has(e.offset)){seen.add(e.offset);unique++;}return {durable:true};}},{ruleSnapshots:{current:async()=>({rules:[rule]})}});
  const original=pump.syncDirectory.bind(pump);pump.syncDirectory=async folder=>{syncs++;assert.equal(unique,20);await original(folder);};
  await pump.tick();assert.equal(syncs,1);assert.equal(unique,20);assert.equal(pump.status.failed,0);
  // Simulate directory deletions lost after a power interruption.
  await write();await pump.tick();assert.equal(unique,20);assert.equal(pump.status.consumed,40);
  await write();pump.syncDirectory=async()=>{throw Error('sync failed');};await pump.tick();assert.equal(pump.status.state,'degraded');assert.equal(pump.status.last_error,'acknowledgement_pending');
  assert.equal((await readdir(dir)).length,0);
  await pump.tick();assert.equal(pump.status.state,'degraded');assert.equal(pump.status.failed,2);
  pump.syncDirectory=original;await pump.tick();
  assert.equal(pump.status.state,'ready');assert.equal(pump.status.last_error,null);
  assert.equal(pump.status.channel_issues.length,0);assert.equal(pump.status.consumed,60);assert.equal(unique,20);

 }finally{await rm(root,{recursive:true,force:true});}
});

test('source discontinuity survives journal conversion without changing target identity',()=>{
 const original=observationEnvelope(sample,[rule]).envelope.frame;
 const resumed=observationEnvelope({...sample,gap:true},[rule]).envelope.frame;
 assert.equal(resumed.gap,true);
 assert.equal(resumed.stream_session_id,original.stream_session_id);
 assert.deepEqual(resumed.tracks,original.tracks);
 assert.throws(()=>observationEnvelope({...sample,gap:'true'},[rule]),/Invalid observation gap/);
});
test('pump defers per-frame ACK syncs and commits them before journal deletions',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-observations-')),dir=path.join(root,rawHash('processor'));
 try{
  await mkdir(dir);for(const offset of ['0','1','2'])await writeFile(path.join(dir,offset.padStart(20,'0')+'.json'),JSON.stringify({...sample,offset}));
  const order=[],options=[];
  const consumer={consume:async(e,o)=>{options.push(o);order.push('consume:'+e.offset);return {durable:true}},flushAcknowledgements:async()=>{order.push('flush')}};
  const pump=new ObservationPump(root,consumer,{ruleSnapshots:{current:async()=>({rules:[rule]})}});
  pump.syncDirectory=async()=>{order.push('sync')};
  await pump.tick();
  assert.deepEqual(order,['consume:0','consume:1','consume:2','flush','sync']);
  assert.ok(options.every(o=>o?.deferAcknowledgement===true),'pump must request deferred acknowledgements');
  assert.equal((await readdir(dir)).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('channels are consumed concurrently, each in order, and a blocked channel never stalls another',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-observations-'));
 try{
  const other={...rule,id:'r2',channel_id:'other'};
  for(const channel of ['processor','other']){
   const dir=path.join(root,rawHash(channel));await mkdir(dir);
   for(const offset of ['0','1','2'])await writeFile(path.join(dir,offset.padStart(20,'0')+'.json'),JSON.stringify({...sample,channel_id:channel,offset}));
  }
  const seen={processor:[],other:[]};let active=0,peak=0,failOnce=true;
  const consumer={consume:async e=>{
   const channel=e.frame.channel_id;active++;peak=Math.max(peak,active);seen[channel].push(e.offset);
   try{
    await new Promise(r=>setTimeout(r,30));
    if(channel==='other'&&e.offset==='1'&&failOnce){failOnce=false;throw Error('storage down');}
    return {durable:true};
   }finally{active--;}
  }};
  const pump=new ObservationPump(root,consumer,{ruleSnapshots:{current:async()=>({rules:[rule,other]})}});
  pump.syncDirectory=async()=>{};
  await pump.tick();
  assert.ok(peak>=2,'one channel at a time serialised every channel behind the slowest one');
  assert.deepEqual(seen.processor,['0','1','2']);
  assert.deepEqual(seen.other,['0','1']);
  assert.equal((await readdir(path.join(root,rawHash('processor')))).length,0);
  assert.deepEqual((await readdir(path.join(root,rawHash('other')))).sort(),['00000000000000000001.json','00000000000000000002.json']);
  await pump.tick();
  assert.deepEqual(seen.other,['0','1','1','2']);
  assert.equal((await readdir(path.join(root,rawHash('other')))).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a blocked channel writes the real cause to the service log once, not on every retry',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ainvr-observations-')),dir=path.join(root,rawHash('processor'));
 const write=process.stderr.write,lines=[];
 try{
  await mkdir(dir);await writeFile(path.join(dir,'0'.padStart(20,'0')+'.json'),JSON.stringify(sample));
  let cause='evidence_capacity';
  const pump=new ObservationPump(root,{consume:async()=>{throw Object.assign(Error(cause),{code:'E_TEST'})}},{ruleSnapshots:{current:async()=>({rules:[rule]})}});
  process.stderr.write=text=>{lines.push(String(text));return true;};
  for(let i=0;i<5;i++)await pump.tick();
  cause='storage down';await pump.tick();await pump.tick();
  process.stderr.write=write;
  const logged=lines.filter(l=>l.includes('observation_blocked')).map(l=>JSON.parse(l));
  assert.deepEqual(logged.map(l=>l.error),['evidence_capacity','storage down']);
  assert.equal(logged[0].channel_id,'processor');assert.equal(logged[0].step,'consume');assert.equal(logged[0].code,'E_TEST');
 }finally{process.stderr.write=write;await rm(root,{recursive:true,force:true});}
});

 test('adding a detector preserves only identical primary label bindings',()=>{
  const merged=structuredClone(sample);merged.model.label_catalog={schema_version:'1.0',adapter:'analysis_pipeline',labels:[...labels,{class_id:1,label_id:'node:face:class:0',name:'face',description:''}]};
  merged.model.compatible_label_catalogs=[structuredClone(sample.model.label_catalog)];
  const result=observationEnvelope(merged,[rule]);assert.ok(result.envelope);assert.equal(result.envelope.frame.model.compatible_label_versions[0].version,version);
  const changed=structuredClone(merged);changed.model.label_catalog.labels[0].description='other target';assert.throws(()=>observationEnvelope(changed,[rule]),/Incompatible label alias/);
  const absent=structuredClone(merged);delete absent.model.compatible_label_catalogs;assert.equal(observationEnvelope(absent,[rule]).ignored,'source_binding_mismatch');
 });
