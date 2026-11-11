// A full alarm screenshot pool must cost the new alarm its screenshot, never the channel's counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {AlarmRepository} from '../src/repository.mjs';
import {ReviewContext} from '../src/review-context.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {durableFile,frameKey} from '../src/evidence-spool.mjs';
const uri=process.env.AINVR_REVIEW_TEST_MONGO_URI;
const jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex');
const rule={id:'r',version:1,name:'risk',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',incident_policy:'condition-v1'};
const frameAt=(seq,track)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'i',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_pts_ns:String(seq),source_frame_index:String(seq),captured_at:new Date().toISOString(),source:{width:20,height:10,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},evidence_delivery:{schema_version:2,state:'durable'},tracks:[{track_id:track,label_id:'p',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq),bbox:{x:1,y:1,w:5,h:5}}]});
const envelopeOf=frame=>({schema_version:'1.0',producer_id:'p',offset:frame.seq,frame});
// Real Mongo image pool, one filler image, and a limit that leaves no room for a second one.
async function fullPool(fn){
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_capacity_'+randomUUID().replaceAll('-',''));
 const root=await mkdtemp('/mnt/ainvr-ssd/capacity-test-');
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const context=new ReviewContext(repo,root);context.policy={max_bytes:jpeg.length+8,retention_days:7};await context.initialize();repo.reviewContext=context;
  await repo.saveRule(rule,0,'test');await mkdir(join(root,'raw'));
  await context.images.put('context','filler',jpeg,{maxBytes:jpeg.length+8,retentionMs:7*86400000});
  const source=async frame=>{
   const key=frameKey('c','s',frame);
   const meta={schema_version:2,channel_id:'c',stream_session_id:'s',source_pts_ns:frame.source_pts_ns,source_frame_index:frame.source_frame_index,frame_width:20,frame_height:10,bytes:jpeg.length,sha256:createHash('sha256').update(jpeg).digest('hex')};
   await durableFile(join(root,'raw',key+'.jpg'),jpeg);await durableFile(join(root,'raw',key+'.json'),JSON.stringify(meta));
  };
  await fn({repo,context,source});
 }finally{await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
}
test('a full screenshot pool publishes the alarm without a screenshot and the channel keeps consuming',{skip:!uri},()=>fullPool(async({repo,context,source})=>{
 const first=frameAt(1,'t');await source(first);
 const consumer=new ObservationConsumer(repo);
 const result=await consumer.consume(envelopeOf(first));
 assert.equal(result.durable,true);assert.equal(result.outcome,'consumed');
 const checkpoint=await repo.checkpoints.findOne({channel_id:'c'});
 assert.equal(checkpoint.offset,'1');assert.equal(checkpoint.pending,null);
 const alarm=await repo.events.findOne({});
 assert.ok(alarm,'the alarm itself is still published');
 assert.equal(alarm.analysis_evidence.delivery.state,'failed');
 assert.equal(alarm.analysis_evidence.delivery.failure,'evidence_capacity');
 assert.equal(alarm.review.reason,'source_evidence_failed');
 // Published screenshots are untouched: pool pressure only refuses the new one.
 assert.deepEqual(await context.images.get('context','filler'),jpeg);
 const next=frameAt(2,'t');await source(next);
 assert.equal((await consumer.consume(envelopeOf(next))).outcome,'consumed');
 assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2');
}));
test('a prepared result left behind while the pool was full completes on the next attempt',{skip:!uri},()=>fullPool(async({repo,source})=>{
 const first=frameAt(1,'t');await source(first);
 let crashed=false;
 const interrupted=new ObservationConsumer(repo,{hook:async point=>{if(point==='prepared'&&!crashed){crashed=true;throw Error('stopped after prepare');}}});
 await assert.rejects(interrupted.consume(envelopeOf(first)),/stopped after prepare/);
 assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).pending,'the prepared outcome is waiting');
 const restarted=new ObservationConsumer(repo);
 assert.equal((await restarted.consume(envelopeOf(first))).durable,true);
 const checkpoint=await repo.checkpoints.findOne({channel_id:'c'});
 assert.equal(checkpoint.offset,'1');assert.equal(checkpoint.pending,null);
 assert.equal((await repo.events.findOne({})).analysis_evidence.delivery.failure,'evidence_capacity');
}));
test('a storage outage still holds the frame for retry',{skip:!uri},()=>fullPool(async({repo,context,source})=>{
 const first=frameAt(1,'t');await source(first);
 context.image=async()=>{throw Object.assign(Error('connection lost'),{name:'MongoNetworkError'});};
 await assert.rejects(new ObservationConsumer(repo).consume(envelopeOf(first)),/connection lost/);
 assert.equal(await repo.events.countDocuments({}),0);
 assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).pending);
}));
