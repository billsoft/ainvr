import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const rule=(behavior='region_traverse')=>({id:'r',name:'Gate',version:1,channel_id:'c',input_stream_id:'input',state:'enabled',label_ids:['person'],label_map_version:'labels',geometry_revision:'geometry',anchor:'center',behavior,duration_ms:behavior==='appearance'?2000:0,...(behavior==='appearance'?{}:{points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]})});
const frame=(seq,x)=>({schema_version:'1.0',channel_id:'c',input_stream_id:'input',stream_session_id:'session',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1e9),captured_at:new Date(1793070000000+seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'geometry'},model:{label_map_version:'labels'},tracks:[{track_id:'same-id',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1e9),bbox:{x:x*1000-10,y:490,w:20,h:20}}]});
test('a camera view change cannot complete an old traversal, even without paused frames',()=>{
 let cp=null;const r=rule();for(const [i,x]of[.2,.5].entries())cp=evaluate(cp,frame(i+1,x),[r]).checkpoint;
 const resumed={...r,view_epoch:'a'.repeat(64)};const result=evaluate(cp,frame(3,.8),[resumed]);assert.equal(result.events.length,0);assert.ok(result.issues.includes('view_changed'));
});
test('a paused spatial rule does not produce an alarm and resume starts fresh dwell',()=>{
 const r=rule('appearance');let cp=evaluate(null,frame(1,.5),[r]).checkpoint;cp=evaluate(cp,frame(2,.5),[r]).checkpoint;
 const paused={...r,state:'paused',view_epoch:'a'.repeat(64)};let result=evaluate(cp,frame(3,.5),[paused]);assert.equal(result.events.length,0);cp=result.checkpoint;
 const resumed={...r,view_epoch:'b'.repeat(64)};result=evaluate(cp,frame(4,.5),[resumed]);assert.equal(result.events.length,0);cp=result.checkpoint;
 result=evaluate(cp,frame(5,.5),[resumed]);assert.equal(result.events.length,0);cp=result.checkpoint;
 assert.equal(evaluate(cp,frame(6,.5),[resumed]).events.length,1);
});
test('an unrelated processor view does not reset this processor',()=>{
 const r=rule('appearance');let cp=evaluate(null,frame(1,.5),[r]).checkpoint;cp=evaluate(cp,frame(2,.5),[r]).checkpoint;
 const other={...r,id:'other',channel_id:'other',view_epoch:'a'.repeat(64)};assert.equal(evaluate(cp,frame(3,.5),[r,other]).events.length,1);
});

test('pre-movement journal backlog cannot count after rearming, including legacy rules',()=>{
 const r={...rule(),view_epoch:'a'.repeat(64),view_not_before:frame(5,.5).captured_at};let cp=null;
 for(const [i,x]of[.2,.5,.8].entries()){const out=evaluate(cp,frame(i+1,x),[r]);cp=out.checkpoint;assert.equal(out.events.length,0)}
 for(const [i,x]of[.2,.5,.8].entries()){const out=evaluate(cp,frame(i+5,x),[r]);cp=out.checkpoint;if(i<2)assert.equal(out.events.length,0);else assert.equal(out.events.length,1)}
});
