import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
// Approach facts re-arm only after a clear observed departure, never on a boundary
// flicker or a predicted frame. x=.24 is 60 px left of the zone on a 1000 px source.
const rule={id:'near@c',trigger_id:'near',version:1,name:'r',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',
  behavior:'region_approach',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],approach_px:100,rearm_ms:2000};
function frame(seq,x){return {schema_version:'1.0',channel_id:'c',input_stream_id:'input',stream_session_id:'s',seq:String(seq),frame_id:'s:'+seq,source_pts_ns:String(seq*1000000000),
  captured_at:new Date(seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
  tracks:[{track_id:'t',state:'confirmed',observation:'detected',label_id:'p',last_observed_pts_ns:String(seq*1000000000),bbox:{x:x*1000,y:400,w:10,h:10}}]};}
test('approach facts require a clear observed departure for rearm, not a boundary flicker or prediction',()=>{
  let cp=null,seq=0;
  const step=(x,predicted=false)=>{
    const f=frame(++seq,x);
    if(predicted){f.tracks[0].observation='lost';f.tracks[0].last_observed_pts_ns=String((seq-1)*1000000000);f.tracks[0].predicted_bbox=f.tracks[0].bbox;}
    const out=evaluate(cp,f,[rule]);cp=out.checkpoint;return out.events.length;
  };
  assert.equal(step(.24),1);
  for(let i=0;i<3;i++){assert.equal(step(.9),0);assert.equal(step(.24),0);}
  assert.equal(step(.9),0);assert.equal(step(.9,true),0);assert.equal(step(.9),0);assert.equal(step(.24),0);
  assert.equal(step(.9),0);assert.equal(step(.9),0);assert.equal(step(.9),0);assert.equal(step(.24),1);
});
