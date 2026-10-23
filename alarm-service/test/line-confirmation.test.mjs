import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const rule={id:'r',version:1,name:'line',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'center',alarm_enabled:false,hysteresis_px:5,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],passage:{kind:'line',edges:[3],max_gap_ms:1000}};
function run(frames){let cp=null;const events=[],inputs=[];frames.forEach((rows,i)=>{
 if(!Array.isArray(rows))rows=[rows];
 const ms=rows[0]?.ms??i*100,pts=String((ms+1000)*1000000);
 const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:rows[0]?.session??'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,23)+ms).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:rows.filter(v=>!v.absent).map((v,j)=>({track_id:v.id??'t'+j,label_id:'person',state:v.state??'confirmed',observation:v.predicted?'predicted':'detected',last_observed_pts_ns:v.predicted?String((ms+900)*1000000):pts,event_eligible:!v.ineligible,bbox:{x:v.x*1000-10,y:(v.y??.5)*1000-10,w:20,h:20}})),...(rows[0]?.gap?{gap:true}:{})};
 inputs.push(f);const result=evaluate(cp,f,[rule]);cp=JSON.parse(JSON.stringify(result.checkpoint));events.push(...result.events);
 });return {cp,events,inputs};}
const path=xs=>xs.map(x=>({x}));
test('short-lived confirmed ghost and immediate return produce no count in either direction',()=>{
 for(const xs of [[.2,.2,.4],[.2,.2,.4,.4],[.2,.2,.4,.2,.2],[.2,.4,.2,.4,.2,.4]])assert.equal(run(path(xs)).events.length,0);
});
test('same stationary destination can confirm; lingering never repeats',()=>{
 const {events}=run(path([.2,.2,.4,.4,.4,.4,.4]));assert.equal(events.length,1);
 assert.equal(events[0].direction.line_direction,'inward');assert.equal(events[0].analysis_evidence.traversal.confirmation.stable_ms,200);
 assert.equal(events[0].analysis_evidence.traversal.exit.frame_id,'3');assert.equal(events[0].analysis_evidence.traversal.confirmation.confirmed_frame_id,'5');
});
test('true return after confirmation counts independently',()=>{
 const {events}=run(path([.2,.2,.4,.4,.4,.2,.2,.2]));assert.deepEqual(events.map(e=>e.direction.line_direction),['inward','outward']);
});
test('five close simultaneous people remain five distinct crossings',()=>{
 const frames=Array.from({length:12},(_,i)=>Array.from({length:5},(_,j)=>({id:'person-'+j,x:i<2+j?.2:.4,y:.45+j*.01})));
 assert.equal(run(frames).events.length,5);
});
test('fast traversal with enough observations and slow frame rate both confirm',()=>{
 assert.equal(run(path([.1,.2,.4,.7,.9])).events.length,1);
 assert.equal(run([.1,.2,.4,.4].map((x,i)=>({x,ms:i*500}))).events.length,1);
});
test('predictions do not satisfy confirmation; recovery restarts its stable duration',()=>{
 const start=path([.2,.2,.4]);
 assert.equal(run([...start,{x:.4,predicted:true,ms:400},{x:.4,ms:600}]).events.length,0);
 assert.equal(run([...start,{x:.4,predicted:true,ms:400},{x:.4,ms:600},{x:.4,ms:800}]).events.length,1);
});
test('boundary uncertainty resets destination confirmation without inventing a reverse crossing',()=>{
 assert.equal(run(path([.2,.2,.4,.301,.4,.4])).events.length,0);
 assert.equal(run(path([.2,.2,.4,.301,.4,.4,.4])).events.length,1);
});
test('gaps, identity changes and session changes cannot complete a pending crossing',()=>{
 for(const patch of [{gap:true},{id:'new'},{session:'new'},{absent:true}])assert.equal(run([...path([.2,.2,.4]),{x:.4,...patch},...path([.4,.4,.4])]).events.length,0);
});
test('tentative after-side observations never supply confirmed completion',()=>{
 const start=[.2,.2,.4].map(x=>({x,state:'tentative'}));
 assert.equal(run([...start,{x:.4}]).events.length,0);
 assert.equal(run([...start,...path([.4,.4,.4])]).events.length,1);
});
test('finite line extension and endpoints do not count',()=>{
 assert.equal(run([.2,.2,.4,.4,.4].map(x=>({x,y:.1}))).events.length,0);
 assert.equal(run([.2,.2,.4,.4,.4].map(x=>({x,y:.3}))).events.length,0);
});

test('real Mongo persists delayed confirmation once, including checkpoint failure and replay',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const {MongoClient}=await import('mongodb'),{randomUUID}=await import('node:crypto');
 const {AlarmRepository}=await import('../src/repository.mjs'),{ObservationConsumer}=await import('../src/ingestion.mjs');
 const client=await new MongoClient('mongodb://127.0.0.1:27028').connect(),db=client.db('ainvr_line_confirm_'+randomUUID().replaceAll('-',''));
 try{
  const repo=new AlarmRepository(db);await repo.initialize();await repo.saveRule(rule,0,'test');
  const frames=run(path([.2,.2,.4,.4,.4,.4])).inputs;let failOnce=true;
  const consumer=new ObservationConsumer(repo,{hook:async phase=>{if(phase==='before_checkpoint'&&failOnce&&await repo.behaviors.collection.countDocuments()){failOnce=false;throw Error('checkpoint fault')}}});
  for(const f of frames){const envelope={schema_version:'1.0',producer_id:'p',offset:f.seq,frame:f};try{await consumer.consume(envelope)}catch(e){assert.match(e.message,/checkpoint fault/);await consumer.consume(envelope)}await consumer.consume(envelope)}
  assert.equal(await repo.behaviors.collection.countDocuments(),1);assert.equal(await repo.events.countDocuments(),0);
  assert.equal((await repo.behaviors.collection.findOne()).analysis_evidence.traversal.confirmation.policy,'line-observed-sides-v1');
 }finally{await db.dropDatabase();await client.close()}
});
