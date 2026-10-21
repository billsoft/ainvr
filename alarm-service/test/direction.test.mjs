import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {regionDirection} from '../src/traversal.mjs';
const base={id:'r',version:1,name:'Region',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
const frame=(seq,x,y=.5)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:new Date(1760918400000+seq*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:x*1920-10,y:y*1080-10,w:20,h:20}}]});
test('entry separates region side from motion direction on all four sides',()=>{
 for(const [start,end,side,motion] of [
  [[.2,.5],[.4,.5],270,90],[[.8,.5],[.6,.5],90,270],
  [[.5,.2],[.5,.4],0,180],[[.5,.8],[.5,.6],180,0]]){
  const first=evaluate(null,frame(1,...start),[base]);
  const result=evaluate(first.checkpoint,frame(2,...end),[base]);
  assert.equal(result.events.length,1);
  assert.ok(Math.abs(result.events[0].direction.entry_side_deg-side)<1e-9);
  assert.ok(Math.abs(result.events[0].direction.motion_heading_deg-motion)<1e-9);
 }
});
test('entry dwell retains initial crossing direction even when the target turns',()=>{
 const rule={...base,duration_ms:1000};
 let cp=evaluate(null,frame(1,.2),[rule]).checkpoint;
 cp=evaluate(cp,frame(2,.4),[rule]).checkpoint;
 const result=evaluate(cp,frame(3,.4,.6),[rule]);
 assert.equal(result.events.length,1);
 assert.equal(result.events[0].direction.entry_side_deg,270);
 assert.equal(result.events[0].direction.motion_heading_deg,90);
});
test('approach emits position side and nearest edge but unknown motion without observed history',()=>{
 // x=.28 is 38 px left of the zone on a 1920 px source.
 const rule={...base,behavior:'region_approach',approach_px:60};
 const first=evaluate(null,frame(1,.28),[rule]).events[0];
 assert.equal(first.direction.nearest_edge,3);
 assert.equal(first.direction.region_side_deg,270);
 assert.equal(first.direction.motion_heading_deg,null);
 assert.equal(first.direction.reference,'nearest_boundary');
 let cp=evaluate(null,frame(1,.2),[rule]).checkpoint;
 const lost=frame(2,.28);lost.tracks=[];
 cp=evaluate(cp,lost,[rule]).checkpoint;
 assert.equal(evaluate(cp,frame(3,.28),[rule]).events[0].direction.motion_heading_deg,null);
});
test('ambiguous crossing is not assigned an invented entry side; motion respects aspect ratio',()=>{
 const d=regionDirection(base,frame(1,.5),[.8,.5],[.2,.5],{entry:true});
 assert.equal(d.entry_side_deg,null);assert.equal(d.boundary_point,null);
 const diagonal=regionDirection(base,frame(1,.5),[.3,.3],[.2,.2]);
 assert.ok(Math.abs(diagonal.motion_heading_deg-119.3577535)<.0001);
});
