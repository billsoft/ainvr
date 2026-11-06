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
test('SSD evidence survives delayed consumption and a crash; no alarm publishes before image admission',{skip:!uri},async()=>{
 const client=new MongoClient(uri);await client.connect();const db=client.db('ainvr_admission_'+randomUUID().replaceAll('-',''));
 const root=await mkdtemp('/mnt/ainvr-ssd/admission-test-');try{
  const repo=new AlarmRepository(db);await repo.initialize();const context=new ReviewContext(repo,root);await context.initialize();repo.reviewContext=context;
  const rule={id:'r',version:1,name:'risk',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',incident_policy:'condition-v1'};
  await repo.saveRule(rule,0,'test');const now=new Date().toISOString();
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'i',stream_session_id:'s',seq:'1',frame_id:'s:1',source_pts_ns:'1',source_frame_index:'1',captured_at:now,source:{width:20,height:10,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},evidence_delivery:{schema_version:2,state:'durable'},tracks:[{track_id:'t',label_id:'p',state:'confirmed',observation:'detected',last_observed_pts_ns:'1',bbox:{x:1,y:1,w:5,h:5}}]};
  const envelope={schema_version:'1.0',producer_id:'p',offset:'1',frame};
  await mkdir(join(root,'raw'));const key=frameKey('c','s',frame);
  const meta={schema_version:2,channel_id:'c',stream_session_id:'s',source_pts_ns:'1',source_frame_index:'1',frame_width:20,frame_height:10,bytes:jpeg.length,sha256:createHash('sha256').update(jpeg).digest('hex')};
  await durableFile(join(root,'raw',key+'.jpg'),jpeg);await durableFile(join(root,'raw',key+'.json'),JSON.stringify(meta));
  const save=context.image.bind(context);context.image=async()=>{throw Error('storage unavailable');};
  await assert.rejects(new ObservationConsumer(repo).consume(envelope),/storage unavailable/);
  assert.equal(await repo.events.countDocuments({}),0);assert.ok((await repo.checkpoints.findOne({channel_id:'c'})).pending);
  context.image=save;let crash=true;
  await assert.rejects(new ObservationConsumer(repo,{hook:async p=>{if(p==='event_inserted'&&crash){crash=false;throw Error('crash after publish');}}}).consume(envelope),/crash after publish/);
  assert.equal(await repo.events.countDocuments({}),1);
  await new ObservationConsumer(repo).consume(envelope);
  assert.equal(await repo.events.countDocuments({}),1);
  const event=await repo.events.findOne({});assert.equal(event.analysis_evidence.delivery.state,'complete');
  assert.deepEqual(await context.images.get('context',key),jpeg);
  assert.equal(event.review.reason,'policy_disabled'); // Human evidence exists with AI disabled.
  await repo.saveRule({...rule,version:2},1,'test');
  const missing={...frame,seq:'2',frame_id:'s:2',source_pts_ns:'2',source_frame_index:'2',tracks:frame.tracks.map(t=>({...t,last_observed_pts_ns:'2'}))};
  await new ObservationConsumer(repo).consume({...envelope,offset:'2',frame:missing});
  const failure=await repo.events.findOne({'rule.version':2});
  assert.equal(failure.analysis_evidence.delivery.state,'failed');
  assert.equal(failure.review.reason,'source_evidence_failed');
  assert.equal((await repo.checkpoints.findOne({channel_id:'c'})).offset,'2');
 }finally{await db.dropDatabase();await client.close();await rm(root,{recursive:true,force:true});}
});
