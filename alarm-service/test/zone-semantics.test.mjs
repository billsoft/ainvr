// Requirement-level safety for intrusion and passage counting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const square=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const base={version:1,name:'r',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',anchor:'center',points:square};
// tracks: [{id,x,y,state?}] in normalized centre coordinates; one frame per second.
function runner(rule){
  let cp=null,seq=0;
  return (tracks,change=()=>{})=>{
    seq++;const pts=String(seq*1000000000);
    const f={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:'f'+seq,source_pts_ns:pts,
      captured_at:new Date(1760918400000+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
      tracks:tracks.map(t=>({track_id:t.id??'t',label_id:'p',state:t.state??'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:t.x*1000-5,y:(t.y??.5)*1000-5,w:10,h:10}}))};
    change(f);const out=evaluate(cp,f,[rule]);cp=out.checkpoint;return out.events;
  };
}
test('traversal counts passing through, not stepping back out over the entry edge',()=>{
  const step=runner({...base,id:'t',behavior:'region_traverse'});
  for(const x of [.2,.4,.5,.4])assert.equal(step([{x}]).length,0);
  assert.equal(step([{x:.2}]).length,0);  // came back out of the left edge
  const pass=runner({...base,id:'t',behavior:'region_traverse'});
  const events=[.2,.4,.6,.8].flatMap(x=>pass([{x}]));
  assert.equal(events.length,1);assert.equal(events[0].analysis_evidence.traversal.same_boundary_edge,false);
});
test('intrusion re-arms only after a stable observed departure lasting rearm_ms',()=>{
  const step=runner({...base,id:'e',behavior:'region_enter',rearm_ms:3000,hysteresis:.01});
  assert.equal(step([{x:.2}]).length,0);assert.equal(step([{x:.4}]).length,1);
  // Boundary dithering within the rearm wait is the same intrusion.
  for(let i=0;i<3;i++){assert.equal(step([{x:.2}]).length,0);assert.equal(step([{x:.4}]).length,0);}
  for(let i=0;i<3;i++)assert.equal(step([{x:.2}]).length,0);
  assert.equal(step([{x:.2}]).length,0);assert.equal(step([{x:.4}]).length,1);
});
