import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePoints} from '../src/geometry.mjs';
import {acknowledge,pending,validateFrame,validateRule} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
const rule=(extra={})=>({id:'r',version:1,name:'Gate',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g1',label_map_version:'l1',behavior:'region_enter',points:[[.6,0],[1,0],[1,1],[.6,1]],...extra});
const frame=(seq,x,extra={})=>({schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:`s:${seq}`,source_pts_ns:String(BigInt(seq)*1000000000n),captured_at:'2026-10-19T00:00:00Z',source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g1'},model:{id:'m',label_map_version:'l1'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(BigInt(seq)*1000000000n),bbox:{x:x*1000-10,y:100,w:20,h:100},confidence:null}],...extra});
test('intrusion emits once and replay identity is deterministic',()=>{
  const a=evaluate(null,frame(1,.5),[rule()]);
  const b=evaluate(a.checkpoint,frame(2,.8),[rule()]);
  assert.equal(b.events.length,1);assert.equal(b.events[0].direction.entry_edge,3);
  assert.equal(b.events[0].alarm_id,evaluate(a.checkpoint,frame(2,.8),[rule()]).events[0].alarm_id);
  assert.equal(evaluate(b.checkpoint,frame(2,.8),[rule()]).events.length,0);
  assert.equal(evaluate(b.checkpoint,frame(3,.9),[rule()]).events.length,0);
});
test('gap, new session and lost observation do not imply crossing',()=>{
  const cp=evaluate(null,frame(1,.5),[rule()]).checkpoint;
  assert.equal(evaluate(cp,frame(3,.8),[rule()]).events.length,0);
  assert.equal(evaluate(cp,frame(2,.8,{stream_session_id:'new'}),[rule()]).events.length,0);
  const lost=frame(2,.6);lost.tracks[0].observation='predicted';lost.tracks[0].last_observed_pts_ns='1000000000';
  const next=evaluate(cp,lost,[rule()]);
  assert.equal(evaluate(next.checkpoint,frame(3,.8),[rule()]).events.length,0);
});
test('PTS regression, incompatible labels and geometry reset eligibility',()=>{
  const cp=evaluate(null,frame(1,.5),[rule()]).checkpoint;
  assert.equal(evaluate(cp,frame(2,.8,{source_pts_ns:'0',tracks:[]}),[rule()]).issues[0],'input_gap');
  assert.equal(evaluate(cp,frame(2,.8),[rule({label_map_version:'other'})]).events.length,0);
  assert.equal(evaluate(cp,frame(2,.8),[rule({geometry_revision:'other'})]).events.length,0);
});
test('entry requires an observed outside, never first seen inside',()=>{
  const r=rule({behavior:'region_enter',points:[[.6,0],[1,0],[1,1],[.6,1]]});
  assert.equal(evaluate(null,frame(1,.8),[r]).events.length,0);
  const a=evaluate(null,frame(1,.4),[r]);assert.equal(evaluate(a.checkpoint,frame(2,.8),[r]).events.length,1);
});
test('duration uses timestamps and version changes reset state',()=>{
  const r=rule({behavior:'appearance',duration_ms:2000});
  let cp=evaluate(null,frame(1,.4),[r]).checkpoint;
  let a=evaluate(cp,frame(2,.4),[r]);assert.equal(a.events.length,0);
  assert.equal(evaluate(a.checkpoint,frame(3,.4),[r]).events.length,1);
  assert.equal(evaluate(a.checkpoint,frame(3,.4),[{...r,version:2}]).events.length,0);
});
test('entry edge restrictions',()=>{
  const through=edges=>{const r=rule({entry_edges:edges});return evaluate(evaluate(null,frame(1,.5),[r]).checkpoint,frame(2,.8),[r]).events.length;};
  assert.equal(through([1]),0);assert.equal(through([3]),1);assert.equal(through([1,3]),1);
});
test('invalid polygons, zero lines and unsupported schedule reject',()=>{
  assert.throws(()=>validatePoints([[0,0],[1,1],[0,1],[1,0]]));
  assert.throws(()=>validateRule(rule({points:[[.7,0],[.7,0]]})));
  assert.throws(()=>validateRule(rule({behavior:'line_crossing',points:[[.7,0],[.7,1]]})),e=>e.code==='unsupported_behavior');
  assert.throws(()=>validateRule(rule({schedule:{mode:'weekly'}})));
});
test('nan, overflow boxes, duplicate track and unsafe numeric PTS reject',()=>{
  const f=frame(1,.5);f.tracks[0].bbox.w=NaN;assert.throws(()=>validateFrame(f));
  assert.throws(()=>validateFrame(frame(1,.999)));
  assert.throws(()=>validateFrame(frame(1,.5,{source_pts_ns:1000000000})));
  const duplicate=frame(1,.5);duplicate.tracks.push(structuredClone(duplicate.tracks[0]));assert.throws(()=>validateFrame(duplicate));
});
test('acknowledgement is separate from review; duplicate cannot replace actor',()=>{
  const event=evaluate(null,frame(1,.4),[rule({behavior:'appearance'})]).events[0];
  event.review={state:'running',attempt:1};assert.equal(pending(event),true);
  const result=acknowledge(event,{expected_handling_revision:0,note:'checked'},'operator','op-1','2026-10-19T00:00:00Z');
  assert.equal(result.event.review.state,'running');assert.equal(pending(result.event),false);assert.equal(event.handling.state,'unacknowledged');
  const again=acknowledge(result.event,{expected_handling_revision:0},'other','op-2','2026-10-19T00:00:01Z');
  assert.equal(again.outcome,'already_acknowledged');assert.equal(again.event.handling.acknowledged_by,'operator');
  assert.throws(()=>acknowledge(event,{expected_handling_revision:1},'op','id','now'),e=>e.code==='version_conflict');
});
test('review rejection is excluded from pending but does not delete event',()=>{
  const event=evaluate(null,frame(1,.4),[rule({behavior:'appearance'})]).events[0];
  event.review.state='not_supported';assert.equal(pending(event),true);
  event.handling={...event.handling,state:'acknowledged',reviewed_by_kind:'ai',disposition:'false_positive'};assert.equal(pending(event),false);assert.ok(event.alarm_id);
});

test('bound input stream prevents applying a region from another camera and clears old transition state',()=>{
 const r=rule({input_stream_id:'in'});
 const first=evaluate(null,frame(1,.5),[r]);
 const switched=evaluate(first.checkpoint,frame(2,.8,{input_stream_id:'other'}),[r]);
 assert.deepEqual(switched.events,[]);assert.ok(switched.issues.includes('rule_input_mismatch:r'));
 const back=evaluate(switched.checkpoint,frame(3,.8),[r]);assert.equal(back.events.length,0);
 assert.equal(evaluate(first.checkpoint,frame(2,.8),[r]).events.length,1);
 assert.throws(()=>validateRule(rule({input_stream_id:''})),e=>e.code==='invalid_identity');
});

test('a retained track ID is the same target; a briefly absent ID keeps its alarm latch',()=>{
 const r=rule({behavior:'appearance'});
 for(const observation of ['lost','predicted']){
  const first=evaluate(null,frame(1,.4),[r]);assert.equal(first.events.length,1);
  const kept=frame(2,.8);kept.tracks[0].observation=observation;kept.tracks[0].last_observed_pts_ns='1000000000';
  const gap=evaluate(first.checkpoint,kept,[r]);assert.equal(Object.keys(gap.checkpoint.states).length,1);
  assert.equal(evaluate(gap.checkpoint,frame(3,.4),[r]).events.length,0);
 }
 const first=evaluate(null,frame(1,.4),[r]),gone=evaluate(first.checkpoint,frame(2,.4,{tracks:[]}),[r]);
 assert.equal(gone.ended_episodes.length,0);
 assert.equal(evaluate(gone.checkpoint,frame(3,.4),[r]).events.length,0);
});

test('transport gap preserves deduplication but not dwell or crossing evidence',()=>{
 const r=rule({behavior:'appearance'});
 const first=evaluate(null,frame(1,.4),[r]);
 assert.equal(evaluate(first.checkpoint,frame(3,.4),[r]).events.length,0);
 assert.equal(evaluate(first.checkpoint,frame(2,.4,{gap:true}),[r]).events.length,0);
 const dwell=rule({behavior:'appearance',duration_ms:2000});
 let cp=evaluate(null,frame(1,.4),[dwell]).checkpoint;
 cp=evaluate(cp,frame(2,.4,{tracks:[]}),[dwell]).checkpoint;
 const back=evaluate(cp,frame(3,.4),[dwell]);assert.equal(back.events.length,0);
 const next=evaluate(back.checkpoint,frame(4,.4),[dwell]);assert.equal(next.events.length,0);
 assert.equal(evaluate(next.checkpoint,frame(5,.4),[dwell]).events.length,1);
});

test('approach does not repeat while the target lingers; an observed departure re-arms it',()=>{
 // x=.25 is 50 px left of the zone on a 1000 px source.
 const r=rule({behavior:'region_approach',approach_px:60,rearm_ms:1000,points:[[.3,0],[.7,0],[.7,1],[.3,1]]});
 const first=evaluate(null,frame(1,.25),[r]);assert.equal(first.events.length,1);
 const lost=frame(2,.25);lost.tracks[0].observation='lost';lost.tracks[0].last_observed_pts_ns='1000000000';
 const back=evaluate(evaluate(first.checkpoint,lost,[r]).checkpoint,frame(3,.25),[r]);assert.equal(back.events.length,0);
 const outside=evaluate(back.checkpoint,frame(4,.05),[r]);
 assert.equal(evaluate(outside.checkpoint,frame(5,.25),[r]).events.length,0);
 const away=evaluate(outside.checkpoint,frame(5,.05),[r]);assert.equal(evaluate(away.checkpoint,frame(6,.25),[r]).events.length,1);
 assert.equal(Object.keys(evaluate(back.checkpoint,frame(4,.25),[]).checkpoint.states).length,0);
});

test('acknowledging records whether it was handled or a false alarm; false alarms leave the pending list',()=>{
 const event=evaluate(null,frame(1,.4),[rule({behavior:'appearance'})]).events[0];
 const handled=acknowledge(event,{expected_handling_revision:0,note:''},'operator','op-h','2026-10-20T00:00:00Z');
 assert.equal(handled.event.handling.disposition,'handled');
 const wrong=acknowledge(event,{expected_handling_revision:0,note:'shadow',disposition:'false_positive'},'operator','op-f','2026-10-20T00:00:00Z');
 assert.equal(wrong.event.handling.disposition,'false_positive');assert.equal(pending(wrong.event),false);assert.equal(wrong.log.disposition,'false_positive');
 assert.throws(()=>acknowledge(event,{expected_handling_revision:0,disposition:'maybe'},'operator','op-x','now'),e=>e.code==='invalid_disposition');
});

test('human correction of an AI decision is versioned and changes reviewer without deleting AI evidence',()=>{
 const event=evaluate(null,frame(1,.4),[rule({behavior:'appearance'})]).events[0];
 event.handling={state:'acknowledged',revision:1,reviewed_by_kind:'ai',disposition:'false_positive'};event.review={state:'not_supported',score:.01};
 assert.throws(()=>acknowledge(event,{expected_handling_revision:0,disposition:'handled'},'human','a','now'),e=>e.code==='version_conflict');
 const result=acknowledge(event,{expected_handling_revision:1,disposition:'handled'},'human','b','now');
 assert.equal(result.event.handling.reviewed_by_kind,'human');assert.equal(result.event.handling.disposition,'handled');assert.equal(result.event.review.score,.01);
});
