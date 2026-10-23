import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
const square=[[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const concave=[[.1,.1],[.9,.1],[.9,.9],[.7,.9],[.7,.3],[.3,.3],[.3,.9],[.1,.9]];
function scenario(behavior,points=square){
 const rule={id:'r',version:1,name:'r',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',anchor:'center',duration_ms:2000,hysteresis:.01,behavior,points,...(behavior==='region_approach'?{approach_px:100}:{})};
 let cp=null,seq=0;return (x,y=.5)=>{seq++;const ns=String(seq*1e9);const f={schema_version:'1.0',channel_id:'c',input_stream_id:'input',stream_session_id:'s',seq:String(seq),frame_id:'s:'+seq,source_pts_ns:ns,captured_at:new Date(seq*1000).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',state:'confirmed',observation:'detected',label_id:'p',last_observed_pts_ns:ns,bbox:{x:x*1000-5,y:y*1000-5,w:10,h:10}}]};const r=evaluate(cp,f,[rule]);cp=r.checkpoint;return r;};
}
test('approach inner jitter pauses rather than resets dwell, and never rearms a fired event',()=>{
 const step=scenario('region_approach');
 assert.equal(step(.25).events.length,0);
 assert.equal(step(.25).events.length,0); // one second accumulated
 for(let i=0;i<5;i++)assert.equal(step(.305).events.length,0);
 assert.equal(step(.25).events.length,0); // uncertain interval excluded
 assert.equal(step(.25).events.length,1);
 for(let i=0;i<4;i++){assert.equal(step(.305).events.length,0);assert.equal(step(.25).events.length,0);}
});
test('stable inside ends approach candidate; initial inner uncertainty cannot start one',()=>{
 const step=scenario('region_approach');
 for(let i=0;i<4;i++)assert.equal(step(.305).events.length,0);
 assert.equal(step(.25).events.length,0);assert.equal(step(.25).events.length,0);
 assert.equal(step(.4).events.length,0);
 assert.equal(step(.25).events.length,0);assert.equal(step(.25).events.length,0);assert.equal(step(.25).events.length,1);
});
test('concave shortcut invalidates intrusion candidate until a fresh observed entry',()=>{
 const step=scenario('region_enter',concave);
 assert.equal(step(.05,.6).events.length,0);assert.equal(step(.2,.6).events.length,0);
 const jump=step(.8,.6);assert.equal(jump.events.length,0);assert.ok(jump.issues.some(x=>x.startsWith('ambiguous_concave_crossing:')));
 for(let i=0;i<4;i++)assert.equal(step(.8,.6).events.length,0);
 assert.equal(step(.95,.6).events.length,0);assert.equal(step(.8,.6).events.length,0);assert.equal(step(.8,.6).events.length,0);
 const event=step(.8,.6).events[0];assert.ok(event);assert.equal(event.direction.entry_edge,1);
});
test('ordinary continuous intrusion remains valid',()=>{
 const step=scenario('region_enter');assert.equal(step(.2).events.length,0);assert.equal(step(.4).events.length,0);assert.equal(step(.45).events.length,0);assert.equal(step(.5).events.length,1);assert.equal(step(.5).events.length,0);
});
