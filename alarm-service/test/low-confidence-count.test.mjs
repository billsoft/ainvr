import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {counterContinuation} from '../src/low-confidence.mjs';
const base={id:'r',version:1,name:'Passage',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'center',alarm_enabled:false,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
export function replay(xs,options={}){
 let cp=null;const events=[],issues=[];
 xs.forEach((value,i)=>{
  const v=typeof value==='number'?{x:value}:value,ms=v.ms??i*100,pts=String((ms+1000)*1000000);
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:v.session??'s',seq:String(i+1),frame_id:String(i+1),source_pts_ns:pts,captured_at:new Date(Date.UTC(2026,9,21)+ms).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:v.absent?[]:[{track_id:v.id??'t',label_id:v.label??'person',state:v.state??'confirmed',observation:v.predicted?'predicted':'detected',last_observed_pts_ns:v.predicted?String((ms+900)*1000000):pts,event_eligible:v.low?false:(v.eligible??true),...(v.low?{display_kind:'low_confidence'}:{}),bbox:{x:v.x*1000-10,y:(v.y??.5)*1000-10,w:20,h:20}}],...(v.gap?{gap:true}:{})};
  const result=evaluate(cp,frame,[{...base,...options}]);cp=result.checkpoint;events.push(...result.events);issues.push(...result.issues);
 });return {events,issues,cp};
}

const passage={kind:'line',edges:[3],max_gap_ms:1500};
test('weak real endpoint completes a previously visible counter exactly once',()=>{
 const path=[.27,.28,.32,{x:.33,low:true},{x:.34,low:true},{x:.35,low:true},.36];
 assert.equal(replay(path,{passage}).events.length,1);
 assert.equal(replay(path.map(v=>typeof v==='number'?{x:v,low:true}:v),{passage}).events.length,0);
 assert.equal(replay(path.map(v=>typeof v==='object'?{...v,id:'new'}:v),{passage}).events.length,0);
 assert.equal(replay(path.map(v=>typeof v==='object'?{...v,predicted:true}:v),{passage}).events.length,0);
 assert.equal(replay(path.slice(0,-1),{alarm_enabled:true}).events.length,0);
});
test('weak continuation rejects stale, implausible, crowded or non-counter evidence',()=>{
 const state={passage_visible_pts:'1000000000',passage_observation:{pts:'1100000000',point:[.5,.5],w:20,h:20,label_id:'person'}};
 const track={track_id:'a',label_id:'person',state:'confirmed',observation:'detected',display_kind:'low_confidence',bbox:{x:490,y:490,w:20,h:20}};
 const frame={source_pts_ns:'1200000000',source:{width:1000,height:1000},tracks:[track]};
 const rule={alarm_enabled:false,behavior:'region_traverse',anchor:'center',passage};
 assert.equal(counterContinuation(rule,frame,track,state),true);
 for(const changed of [{...track,bbox:{x:600,y:490,w:20,h:20}},{...track,bbox:{x:490,y:490,w:40,h:40}},{...track,observation:'predicted'},{...track,state:'tentative'}])assert.equal(counterContinuation(rule,frame,changed,state),false);
 assert.equal(counterContinuation(rule,{...frame,source_pts_ns:'2600000000'},track,state),false);
 assert.equal(counterContinuation(rule,{...frame,tracks:[track,{...track,track_id:'b'}]},track,state),false);
 assert.equal(counterContinuation({...rule,alarm_enabled:true},frame,track,state),false);
 assert.equal(counterContinuation(rule,frame,track,{}),false);
});

test('low evidence uses the same area and two-gate core without changing their entry contract',()=>{
 for(const options of [{},{passage:{kind:'gates',edges:[3,1],max_gap_ms:1500}}]){
  const path=[.2,.28,.32,.5,.68,{x:.71,low:true},{x:.72,low:true},.8];
  assert.equal(replay(path,options).events.length,1);
 }
});
