import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {randomUUID,createHash} from 'node:crypto';
import {observationEnvelope,ObservationPump} from '../src/observation-pump.mjs';
import {digest,validateFrame} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
import {AlarmRepository} from '../src/repository.mjs';
import {ObservationConsumer} from '../src/ingestion.mjs';
const labels=[{class_id:0,label_id:'person',name:'Person',description:''}];
const version='labels-'+digest(['test_bpu',labels]),url='rtmp://127.0.0.1:1935/live/quality';
const binding={input_stream_id:'input',geometry_revision:'g',label_map_version:version,width:1000,height:1000,stream_fingerprint:createHash('sha256').update(url).digest('hex'),not_before:'2026-10-19T00:00:00Z'};
const base={id:'m:appearance',monitor_id:'m',version:1,name:'Gate',channel_id:'processor',input_stream_id:'input',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:version,behavior:'appearance',source_binding:binding,max_gap_ms:1500};
const polygon=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
function raw(seq,x=.5,low=false){
 const pts=String(9007199254740993n+BigInt(seq)*1000000000n),b={x:x*1000-10,y:490,w:20,h:20};
 return {schema_version:'1.0',producer_id:'native',offset:String(seq),channel_id:'processor',stream_url:url,stream_session_id:'s',source_frame_index:String(9007199254740995n+BigInt(seq)),source_pts_ns:pts,timestamp:Date.parse(binding.not_before)/1000+seq+1,width:1000,height:1000,model:{id:'test',label_catalog:{schema_version:'1.0',adapter:'test_bpu',labels}},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:b,...(low?{display_bbox:b,display_kind:'low_confidence',event_eligible:true}:{})}]};
}
const frame=(seq,x,low,rules=[base])=>observationEnvelope(raw(seq,x,low),rules).envelope.frame;
test('native hidden candidates remain observations for identity but cannot become event evidence',()=>{
 const sample=raw(0,.5,true),converted=observationEnvelope(sample,[base]).envelope.frame;
 assert.equal(converted.tracks[0].event_eligible,false);assert.equal(converted.tracks[0].observation,'detected');
 assert.equal(sample.tracks[0].event_eligible,true); // transport conversion does not edit native input
 assert.throws(()=>validateFrame({...converted,tracks:[{...converted.tracks[0],event_eligible:'yes'}]}),e=>e.code==='invalid_observation');
});
test('long runs of retained low-confidence identities do not repeatedly rearm appearance; briefly dropping an ID retains the activity',()=>{
 const first=evaluate(null,frame(0,.5,false),[base]);let cp=first.checkpoint;
 assert.equal(first.events.length,1);
 for(let seq=1;seq<8;seq++){const next=evaluate(cp,frame(seq,.5,true),[base]);cp=next.checkpoint;assert.equal(next.events.length,0);assert.equal(next.ended_episodes.length,0);}
 const visible=evaluate(cp,frame(8,.5,false),[base]);cp=visible.checkpoint;assert.equal(visible.events.length,0);
 assert.equal(Object.values(cp.episodes)[0].id,first.events[0].episode_id);
 const absent=frame(9,.5,true);absent.tracks=[];const expired=evaluate(cp,absent,[base]);
 assert.equal(expired.events.length,0);assert.equal(expired.ended_episodes.length,0);
 assert.equal(evaluate(expired.checkpoint,frame(10,.5,false),[base]).events.length,0);
});
test('display-only crossings do not prove entry or traversal; visible observed crossing can trigger afterward',()=>{
 const rules=['region_enter','region_traverse'].map(behavior=>({...base,id:'m:'+behavior,behavior,anchor:'center',points:polygon}));
 let cp=null,events=[];
 for(const [seq,x,low] of [[0,.2,false],[1,.5,true],[2,.8,false]]){
  const r=evaluate(cp,frame(seq,x,low,rules),rules);cp=r.checkpoint;events.push(...r.events);
 }
 assert.equal(events.length,0);
 for(const [seq,x] of [[3,.5],[4,.2]]){const r=evaluate(cp,frame(seq,x,false,rules),rules);cp=r.checkpoint;events.push(...r.events);}
 assert.deepEqual(events.map(e=>e.behavior),['region_enter','region_traverse']);
});
test('initial hidden candidates cannot create activities or any of the four behavior facts',()=>{
 const rules=['appearance','region_approach','region_enter','region_traverse'].map(behavior=>({...base,id:'m:'+behavior,behavior,anchor:'center',points:polygon,...(behavior==='region_approach'?{approach_px:100}:{})}));
 let cp=null;
 for(let seq=0;seq<5;seq++){const r=evaluate(cp,frame(seq,seq%2?.3:.5,true,rules),rules);cp=r.checkpoint;assert.equal(r.events.length,0);assert.deepEqual(cp.episodes,{});assert.deepEqual(cp.states,{});}
});
test('real Mongo stores only eligible behavior facts and keeps one alarm across low-confidence identity continuation',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(base,0,'test');const consumer=new ObservationConsumer(repo);
  for(let seq=0;seq<9;seq++)await consumer.consume(observationEnvelope(raw(seq,.5,seq>0&&seq<8),[base]).envelope);
  assert.equal(await repo.behaviors.collection.countDocuments(),1);assert.equal(await repo.events.countDocuments(),1);
  const saved=await repo.behaviors.collection.findOne({});assert.equal(saved.source_pts_ns,raw(0).source_pts_ns);
 }finally{await db.dropDatabase();await client.close();}
});
test('real C++ tracker journal with hidden detections and coasting reaches Mongo without false behavior counts',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'||!process.env.AINVR_NATIVE_QUALITY_ROOT},async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_alarm_test_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();await repo.ruleSnapshots.apply({schema_version:'1.0',revision:'1',rules:[base]},'test');
  const pump=new ObservationPump(process.env.AINVR_NATIVE_QUALITY_ROOT,new ObservationConsumer(repo),repo);await pump.tick();
  assert.equal(pump.status.state,'ready');assert.equal(pump.status.consumed,5);assert.equal(pump.status.pending,0);
  assert.equal(await repo.events.countDocuments(),1);assert.equal(await repo.behaviors.collection.countDocuments(),1);
  const fact=await repo.behaviors.collection.findOne({});assert.equal(fact.source_frame_index,'9007199254741005');assert.equal(fact.source_pts_ns,'9007200254740993');
 }finally{await db.dropDatabase();await client.close();}
});
