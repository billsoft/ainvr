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
