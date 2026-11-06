import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const base={id:'rule',version:1,name:'test',channel_id:'ai',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'lm',behavior:'region_enter',incident_policy:'condition-v1',spatial_semantics:'bbox-state-v1',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],duration_ms:0,review:{enabled:false}};
function fixture(patch={}){
 let cp=null,seq=0,ms=0;const events=[],ended=[];
 return {events,ended,step({x=400,ids=['p'],gap=1,mode='tracks',session='s',advance=100}={}){
  seq+=gap;ms+=advance;const pts=String(BigInt(ms+1000)*1000000n);
  const f={schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:session,seq:String(seq),frame_id:session+seq,source_frame_index:String(seq),source_pts_ns:pts,captured_at:new Date(1793940000000+ms).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},observation_mode:mode,tracks:ids.map((id,i)=>({track_id:mode==='detections'?`detection:${seq}:${i}`:id,...(mode==='detections'?{identity_kind:'detection'}:{}),label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x+i*35,y:400,w:20,h:30}}))};
  const out=evaluate(cp,f,[{...base,...patch}]);cp=JSON.parse(JSON.stringify(out.checkpoint));events.push(...out.events);ended.push(...out.ended_episodes);return out;
 }};
}
test('persistent risk survives identity, mode, session and sequence discontinuities',()=>{
 const s=fixture();s.step();s.step({ids:['replacement']});s.step({mode:'detections'});s.step({gap:2});s.step({session:'reconnected'});
 assert.equal(s.events.length,1);
});
test('boundary jitter cannot rearm even after the rearm timeout',()=>{
 const s=fixture();s.step();for(let i=0;i<50;i++)s.step({x:275});s.step();assert.equal(s.events.length,1);
});
test('observed stable clearance rearms same tracker with a distinct episode',()=>{
 const s=fixture();s.step();for(let i=0;i<33;i++)s.step({x:100});s.step();
 assert.equal(s.events.length,2);assert.notEqual(s.events[0].episode_id,s.events[1].episode_id);
 assert.ok(s.ended.some(e=>e.end_reason==='condition_cleared'));
});
test('a missing input interval never counts as clearance',()=>{
 const s=fixture();s.step();s.step({ids:[]});s.step({ids:[],advance:10000});s.step();assert.equal(s.events.length,1);
});
test('group checkpoint reset does not duplicate persistent group risk',()=>{
 const s=fixture({group:{labels:'any',minimum:2,window_ms:0}});
 s.step({ids:['a','b']});s.step({ids:['a','b'],gap:2});s.step({ids:['c','d']});assert.equal(s.events.length,1);
});
test('group condition rearms only after count stays below threshold',()=>{
 const s=fixture({group:{labels:'any',minimum:2,window_ms:0}});
 s.step({ids:['a','b']});for(let i=0;i<33;i++)s.step({ids:['a']});s.step({ids:['a','b']});assert.equal(s.events.length,2);
});
test('traversal cannot opt into persistent condition suppression',()=>{
 assert.throws(()=>fixture({behavior:'region_traverse',spatial_semantics:undefined}).step(),/Condition episodes/);
});
