import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {boundaryStable} from '../src/geometry.mjs';
import {FlowStatistics} from '../src/flow-statistics.mjs';
const base={id:'flow:r',version:1,name:'counter',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'bottom_center',alarm_enabled:false,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],duration_ms:0,hysteresis_px:5};
function run(options={},hidden=null){let cp=null,events=[];for(let i=0;i<40;i++){const pts=String((i+1)*1e8);const tracks=Array.from({length:5},(_,j)=>{const x=Math.min(.9,.2+Math.max(0,i-j)*.03);return {track_id:'t'+j,label_id:'p',state:'confirmed',observation:hidden&&j===2&&i>=hidden[0]&&i<=hidden[1]?'lost':'detected',last_observed_pts_ns:hidden&&j===2&&i>=hidden[0]&&i<=hidden[1]?String(hidden[0]*1e8):pts,bbox:{x:x*1000-10,y:480,w:20,h:20}}});const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(1760918400000+i*100).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks};const r=evaluate(cp,f,[{...base,...options}]);cp=r.checkpoint;events.push(...r.events);}return {cp,events};}
test('five simultaneous identities count independently; short coast retained, long coast diagnosed',()=>{
 assert.equal(run().events.length,5);assert.equal(run({},[8,12]).events.length,5);
 const lost=run({},[8,21]);assert.equal(lost.events.length,4);
 assert.ok(lost.cp.passage_diagnostics.some(d=>d.reason==='passage_observation_gap'&&d.track_id==='t2'&&d.rule_id==='flow:r'));
 assert.ok(lost.cp.passage_diagnostics.length<=64);
});
test('narrow zone skip is explained; two gates preserve valid observed passage',()=>{
 const points=[[.494,.3],[.502,.3],[.502,.7],[.494,.7]];
 const r=run({points});assert.equal(r.events.length,0);assert.ok(r.cp.passage_diagnostics.some(d=>d.reason==='interior_not_observed'));
 assert.equal(run({points,passage:{kind:'gates',edges:[3,1],max_gap_ms:1000}}).events.length,5);
});
test('pixel tolerance is isotropic on rectangular frames; legacy rules retain their semantics',()=>{
 const f={source:{width:1920,height:1080}},r={...base,hysteresis:.01,hysteresis_px:6};
 assert.equal(boundaryStable(r,f,[.3+5/1920,.5]),false);assert.equal(boundaryStable(r,f,[.5,.3+5/1080]),false);
 assert.equal(boundaryStable(r,f,[.3+7/1920,.5]),true);assert.equal(boundaryStable(r,f,[.5,.3+7/1080]),true);
 const old={...r};delete old.hysteresis_px;assert.equal(boundaryStable(old,f,[.3+7/1920,.5]),false);
});
test('live totals avoid historical coverage and aggregation scans',async()=>{
 const used=[];const db={collection(name){return {find(){assert.ok(['alarm_consumer_checkpoints','flow_clear_operations'].includes(name));return {limit(){return this},async toArray(){return []}}},async countDocuments(){used.push(name);return 5},aggregate(){throw Error('Unexpected aggregate')},}}};
 const service=new FlowStatistics(db);const r=await service.query({totals_only:true,series:[{key:'k',rule_id:'r',label_ids:['p'],filter:{kind:'line',side:'inward'},from:'2026-10-23T00:00:00Z',to:'2026-10-23T01:00:00Z'}]});assert.equal(r.items[0].occurrences,5);assert.deepEqual(used,['behavior_events']);
});

test('live and historical totals agree in an isolated real database',{skip:process.env.AINVR_ALARM_TEST_MONGO!=='1'},async()=>{
 const {MongoClient}=await import('mongodb');const {randomUUID}=await import('node:crypto');
 const client=new MongoClient('mongodb://127.0.0.1:27028',{serverSelectionTimeoutMS:3000});await client.connect();const db=client.db('ainvr_flow_live_test_'+randomUUID().replaceAll('-',''));
 try{
  const service=new FlowStatistics(db);await service.initialize();
  await db.collection('behavior_events').insertMany(Array.from({length:5},(_,i)=>({event_id:String(i),event_type:'region_traverse',rule_id:'r',label_id:'p',occurred_at:'2026-10-23T00:00:10Z',stream_session_id:'s',track_id:'t'+i,quality:{trajectory_complete:true},direction:{line_direction:'inward'}})));
  await db.collection('alarm_consumer_checkpoints').insertOne({channel_id:'c',checkpoint:{passage_diagnostics:[{rule_id:'r',reason:'passage_observation_gap',at:'2026-10-23T00:00:11Z'}]}});
  const series=[{key:'k',rule_id:'r',label_ids:['p'],filter:{kind:'line',side:'inward'},from:'2026-10-23T00:00:00Z',to:'2026-10-23T01:00:00Z'}];
  const live=await service.query({series,totals_only:true}),history=await service.query({series,bucket:'hour'});
  assert.equal(live.items[0].occurrences,5);assert.equal(live.items[0].occurrences,history.items[0].occurrences);assert.equal(live.items[0].diagnostic.reason,'passage_observation_gap');
 }finally{await db.dropDatabase();await client.close()}
});
