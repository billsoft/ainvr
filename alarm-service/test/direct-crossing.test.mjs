// A target whose identity is kept and whose consecutive positions lie on opposite sides of a zone has
// passed through it, even when no frame caught it inside (narrow zone, low frame rate).
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {compactProof} from '../src/compact-evidence.mjs';
const W=1000,H=1000;
const rule=(extra={})=>({id:'r',version:1,name:'cross',channel_id:'c',state:'enabled',label_ids:['p'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',anchor:'bottom_center',points:[[.48,.3],[.52,.3],[.52,.7],[.48,.7]],duration_ms:0,hysteresis_px:5,...extra});
// One frame every stepMs; xs are the bottom-centre x of the single track, null means not detected.
function play(r,xs,{stepMs=500,y=500,width=20,gapAt=[]}={}){
 let cp=null;const events=[],issues=[];
 xs.forEach((x,i)=>{
  const pts=String(BigInt(i+1)*BigInt(stepMs)*1000000n),seen=x!==null;
  const track={track_id:'t',label_id:'p',state:'confirmed',observation:seen?'detected':'lost',last_observed_pts_ns:seen?pts:'0',source_frame_index:String(i+1),bbox:{x:(seen?x:.5)*W-width/2,y:y-40,w:width,h:40}};
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:`s:${i+1}`,source_pts_ns:pts,source_frame_index:String(i+1),captured_at:new Date(1760918400000+i*stepMs).toISOString(),source:{width:W,height:H,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[track],...(gapAt.includes(i)?{gap:true}:{})};
  const result=evaluate(cp,frame,[r]);cp=result.checkpoint;events.push(...result.events);issues.push(...result.issues);
 });
 return {events,issues,cp};
}
test('a narrow zone crossed between two frames is a traversal, with both endpoints as evidence',()=>{
 const {events}=play(rule(),[.30,.40,.60,.70]);
 assert.equal(events.length,1);
 const event=events[0],t=event.analysis_evidence.traversal;
 assert.equal(t.interior_observed,false);
 assert.equal(t.entry.edge,3);assert.equal(t.exit.edge,1);
 assert.equal(event.direction.entry_edge,3);assert.equal(event.direction.exit_edge,1);
 const samples=event.analysis_evidence.review_context.samples;
 assert.deepEqual(samples.map(s=>s.frame_id),['s:2','s:3']);
 assert.ok(samples[0].roles.includes('进入前'));assert.ok(samples[1].roles.includes('离开后'));
 assert.equal(compactProof({...event,track_ids:['t']}).ok,true);
});
test('the same passage seen at a high frame rate still counts once',()=>{
 const xs=Array.from({length:21},(_,i)=>.30+i*.02);
 assert.equal(play(rule(),xs,{stepMs:66}).events.length,1);
});
test('a counter over a zone counts the skipped crossing too',()=>{
 assert.equal(play(rule({id:'flow:r',alarm_enabled:false}),[.30,.40,.60,.70]).events.length,1);
});
test('clipping a corner by less than the jitter of the box is not a traversal',()=>{
 // Standing beside the bottom-left corner (.48,.7) of the zone; the anchor moves 14 px through its tip.
 const corner=rule({points:[[.48,.3],[.9,.3],[.9,.7],[.48,.7]]});
 const wobble=width=>{
  let cp=null;const events=[],issues=[];
  [[.47,.68],[.47,.68],[.50,.71]].forEach(([x,y],i)=>{
   const pts=String(BigInt(i+1)*500000000n);
   const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:`s:${i+1}`,source_pts_ns:pts,source_frame_index:String(i+1),captured_at:new Date(1760918400000+i*500).toISOString(),source:{width:W,height:H,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
    tracks:[{track_id:'t',label_id:'p',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,source_frame_index:String(i+1),bbox:{x:x*W-width/2,y:y*H-300,w:width,h:300}}]};
   const result=evaluate(cp,frame,[corner]);cp=result.checkpoint;events.push(...result.events);issues.push(...result.issues);
  });
  return {events,issues};
 };
 const wide=wobble(200);
 assert.equal(wide.events.length,0);
 assert.ok(wide.issues.some(i=>i.startsWith('interior_not_observed')));
 // The same 14 px is a real crossing for a small target.
 assert.equal(wobble(20).events.length,1);
});
test('an alarm rule never joins positions across a missed detection',()=>{
 assert.equal(play(rule(),[.30,.40,null,.60,.70]).events.length,0);
});
test('an alarm rule never joins positions across an input gap',()=>{
 assert.equal(play(rule(),[.30,.40,.60,.70],{gapAt:[2]}).events.length,0);
});
test('going in and back out over the same edge is not a traversal',()=>{
 const wide=rule({points:[[.45,.3],[.9,.3],[.9,.7],[.45,.7]]});
 assert.equal(play(wide,[.30,.40,.50,.40,.30]).events.length,0);
});
test('a minimum duration still applies to a skipped crossing',()=>{
 assert.equal(play(rule({duration_ms:2000}),[.30,.40,.60,.70]).events.length,0);
});
test('a counter that tolerates missed detections still never joins a skipped crossing across them',()=>{
 const counter=rule({id:'flow:r',alarm_enabled:false,passage:{kind:'zone',max_gap_ms:1500}});
 // The identity may have been handed to another person while nothing was detected.
 assert.equal(play(counter,[.30,.40,null,.60,.70]).events.length,0);
 // Seen inside the zone after the miss: the tolerated gap keeps counting as before.
 const wide=rule({id:'flow:r',alarm_enabled:false,passage:{kind:'zone',max_gap_ms:1500},points:[[.42,.3],[.62,.3],[.62,.7],[.42,.7]]});
 assert.equal(play(wide,[.30,.40,null,.50,.56,.70,.80]).events.length,1);
});
