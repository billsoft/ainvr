// A crossing with no frame inside the zone is proven by the frame before and the frame after.
// Both must reach the alarm as screenshots, although the earlier one is only asked for afterwards.
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
const jpeg=Buffer.from('ffd8ffc0001108000a001403012200021101031101ffd9','hex'); // 20 x 10
const rule={id:'r',version:1,name:'cross',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'bottom_center',
 points:[[.45,.2],[.55,.2],[.55,.9],[.45,.9]],duration_ms:0,hysteresis:.005};
test('an alarm for a crossing seen only before and after carries both frames as screenshots',{skip:!uri},async()=>{
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_direct_'+randomUUID().replaceAll('-',''));
 const root=await mkdtemp('/mnt/ainvr-ssd/direct-test-');
 try{
  const repo=new AlarmRepository(db);await repo.initialize();
  const context=new ReviewContext(repo,root);await context.initialize();repo.reviewContext=context;
  await repo.saveRule(rule,0,'test');await mkdir(join(root,'raw'));
  const consumer=new ObservationConsumer(repo),started=Date.now();
  const xs=[.2,.3,.7];
  for(const [i,x] of xs.entries()){
   const seq=String(i+1),pts=String(BigInt(i+1)*500000000n);
   const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'i',stream_session_id:'s',seq,frame_id:`s:${seq}`,source_pts_ns:pts,source_frame_index:seq,captured_at:new Date(started+i*500).toISOString(),
    source:{width:20,height:10,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},evidence_delivery:{schema_version:2,state:'durable'},
    tracks:[{track_id:'t',label_id:'p',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*20-.5,y:3,w:1,h:3}}]};
   const key=frameKey('c','s',frame);
   const meta={schema_version:2,channel_id:'c',stream_session_id:'s',source_pts_ns:pts,source_frame_index:seq,frame_width:20,frame_height:10,bytes:jpeg.length,sha256:createHash('sha256').update(jpeg).digest('hex')};
   await durableFile(join(root,'raw',key+'.jpg'),jpeg);await durableFile(join(root,'raw',key+'.json'),JSON.stringify(meta));
   const result=await consumer.consume({schema_version:'1.0',producer_id:'p',offset:seq,frame});
   assert.equal(result.outcome,'consumed');
   if(consumer.flushAcknowledgements)await consumer.flushAcknowledgements();
  }
  const alarm=await repo.events.findOne({});
  assert.ok(alarm,'the crossing raised an alarm');
  assert.equal(alarm.analysis_evidence.traversal.interior_observed,false);
  assert.equal(alarm.analysis_evidence.delivery.state,'complete');
  assert.deepEqual(alarm.analysis_evidence.delivery.frames.map(f=>f.frame_id),['s:2','s:3']);
 }finally{await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
});
