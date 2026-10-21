import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {heading} from '../src/traversal.mjs';
const rule={id:'r',version:1,name:'Traverse',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]};
function run(xs,change=()=>{}){
  let cp=null;const events=[];
  xs.forEach((x,i)=>{
    const seq=String(i+1),pts=String((i+1)*1000000000);
    const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq,frame_id:seq,source_pts_ns:pts,captured_at:new Date(1760918400000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-5,y:535,w:10,h:10}}]};
    change(f,i);const result=evaluate(cp,f,[rule]);cp=result.checkpoint;events.push(...result.events);
  });return events;
}
test('region traversal captures entry/exit direction and emits once for observed passage',()=>{
  const events=run([.2,.4,.5,.6,.8,.9]);assert.equal(events.length,1);
  const e=events[0];assert.equal(e.direction.entry_side_deg,270);assert.equal(e.direction.exit_side_deg,90);assert.equal(e.direction.motion_heading_deg,90);
  assert.equal(e.analysis_evidence.traversal.trajectory_complete,true);
  assert.equal(e.analysis_evidence.traversal.entry.frame_id,'2');assert.equal(e.analysis_evidence.traversal.exit.frame_id,'5');
});
test('initial inside, skipped interior, lost track and session/gap do not invent traversal',()=>{
  assert.equal(run([.4,.5,.8]).length,0);assert.equal(run([.2,.8]).length,0);
  for(const change of [(f,i)=>{if(i===2)f.tracks=[];},(f,i)=>{if(i>=2)f.stream_session_id='new';},(f,i)=>{if(i===2)f.gap=true;}])assert.equal(run([.2,.4,.5,.8],change).length,0);
});
test('boundary hysteresis does not emit repeated events; angles use original aspect ratio',()=>{
  assert.equal(run([.2,.299,.301,.299,.302,.4,.699,.701,.698,.8,.9]).length,1);
  assert.ok(Math.abs(heading([0,0],[1,1],1920,1080)-119.3577535)<.0001);
});
