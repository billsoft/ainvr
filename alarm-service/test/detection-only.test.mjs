import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {compactProof} from '../src/compact-evidence.mjs';
const rule=(x={})=>({id:'r',version:1,name:'Presence',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'appearance',...x});
const frame=(seq,xs=[.5])=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_frame_index:String(seq),source_pts_ns:String(BigInt(seq)*1000000000n),captured_at:new Date(1760000000000+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{id:'m',label_map_version:'l'},observation_mode:'detections',tracks:xs.map((x,i)=>({track_id:`detection:${seq}:${i}`,identity_kind:'detection',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(BigInt(seq)*1000000000n),bbox:{x:x*1000-10,y:100,w:20,h:100}}))});
test('frame presence is idempotent and does not invent target continuity',()=>{
 const a=evaluate(null,frame(1,[.4,.7]),[rule()]);assert.equal(a.events.length,2);
 assert.notEqual(a.events[0].episode_id,a.events[1].episode_id);
 assert.equal(a.events[0].analysis_evidence.judgement,'single_frame_presence');
 assert.equal(a.events[0].lifecycle.state,'ended');assert.equal(Object.keys(a.checkpoint.episodes).length,0);
 assert.equal(evaluate(a.checkpoint,frame(1),[rule()]).events.length,0);
 assert.equal(evaluate(a.checkpoint,frame(2),[rule()]).events.length,0);
 let cp=evaluate(a.checkpoint,frame(2,[]),[rule()]).checkpoint;
 cp=evaluate(cp,frame(5,[]),[rule()]).checkpoint;
 assert.equal(evaluate(cp,frame(6),[rule()]).events.length,1);
});
test('untracked observations cannot count, invade, traverse or prove dwell',()=>{
 for(const r of [rule({duration_ms:1000}),rule({behavior:'region_enter',points:[[0,0],[1,0],[1,1],[0,1]]}),rule({behavior:'region_traverse',points:[[0,0],[1,0],[1,1],[0,1]],alarm_enabled:false})]) {
  const a=evaluate(null,frame(1),[r]);assert.equal(a.events.length,0);assert.equal(a.coverage.length,0);assert.ok(a.issues.includes('tracking_required:r'));
 }
});
test('zone and approach use the actual frame geometry; single-frame proof has no entry claim',()=>{
 const zoned=rule({input_stream_id:'in',source_binding:{stream_fingerprint:'a'.repeat(64),input_stream_id:'in',geometry_revision:'g',label_map_version:'l',width:1000,height:1000,not_before:'2020-01-01T00:00:00Z'},assignment_id:'r',trigger_version:1,zone_id:'zone',zone_version:1,points:[[.4,0],[.6,0],[.6,1],[.4,1]],review:{enabled:true,profile_id:'alarm-review-zh-v1',version:1,description:'person',reject_below:.05,approve_above:.95}});
 assert.equal(evaluate(null,frame(1,[.2]),[zoned]).events.length,0);
 const a=evaluate(null,frame(1),[zoned]);assert.equal(a.events.length,1);assert.equal(compactProof(a.events[0]).ok,true);
 assert.deepEqual(a.events[0].analysis_evidence.review_context.samples[0].roles,['当帧检出']);
 const approach={...zoned,behavior:'region_approach',approach_px:100,approach_width_percent:10};
 assert.equal(evaluate(null,frame(1,[.35]),[approach]).events.length,1);
 assert.equal(evaluate(null,frame(1,[.5]),[approach]).events.length,0);
 assert.equal(evaluate(null,frame(1,[.1]),[approach]).events.length,0);
});
test('detector observations cannot masquerade as tracked input',()=>{
 const f=frame(1);delete f.observation_mode;assert.throws(()=>evaluate(null,f,[rule()]));
});

test('durable detection-only alarms preserve independent review and replay idempotence',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const {MongoClient}=await import('mongodb');
 const {randomUUID}=await import('node:crypto');
 const {AlarmRepository}=await import('../src/repository.mjs');
 const {ObservationConsumer}=await import('../src/ingestion.mjs');
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();
 const db=client.db('ainvr_detection_test_'+randomUUID().replaceAll('-',''));
 try{
   const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule(),0,'test');
   const consumer=new ObservationConsumer(repo);
   const envelope={schema_version:'1.0',producer_id:'test',offset:'1',frame:frame(1,[.4,.7])};
   await consumer.consume(envelope);await consumer.consume(envelope);
   assert.equal(await repo.events.countDocuments(),2);
   const events=await repo.events.find({}).toArray();assert.notEqual(events[0].alarm_id,events[1].alarm_id);
   await repo.events.updateOne({alarm_id:events[0].alarm_id},{$set:{'handling.state':'acknowledged','handling.disposition':'false_positive'}});
   assert.equal((await repo.events.findOne({alarm_id:events[1].alarm_id})).handling.state,'unacknowledged');
   await consumer.consume({...envelope,offset:'2',frame:frame(2,[.4,.7])});
   assert.equal(await repo.events.countDocuments(),2);
 }finally{await db.dropDatabase();await client.close();}
});

test('native detection journal transports a real detection without claiming a track',{skip:!process.env.AINVR_NATIVE_DETECTION_ROOT},async()=>{
 const {readdir,readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const {observationEnvelope}=await import('../src/observation-pump.mjs');const {digest}=await import('../src/domain.mjs');
 const root=process.env.AINVR_NATIVE_DETECTION_ROOT,dir=(await readdir(root))[0];
 const sample=JSON.parse(await readFile(root+'/'+dir+'/00000000000000000000.json','utf8'));
 assert.equal(sample.observation_mode,'detections');assert.equal(sample.tracks.length,0);assert.equal(sample.detections.length,1);
 const labels=sample.model.label_catalog.labels.map(l=>({class_id:l.class_id,label_id:l.label_id,name:l.name,description:l.description})),version='labels-'+digest([sample.model.label_catalog.adapter,labels]);
 const r=rule({channel_id:'processor',input_stream_id:'in',label_map_version:version,source_binding:{stream_fingerprint:createHash('sha256').update(sample.stream_url).digest('hex'),width:1000,height:1000,label_map_version:version,input_stream_id:'in',geometry_revision:'g',not_before:'2020-01-01T00:00:00Z'}});
 const {envelope}=observationEnvelope(sample,[r]);assert.equal(envelope.frame.tracks[0].identity_kind,'detection');
 assert.equal(evaluate(null,envelope.frame,[r]).events.length,1);
});
