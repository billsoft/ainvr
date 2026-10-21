// Trigger semantics (2026-10-20 design): one behavior per trigger, one rule per bound
// channel; appearance follows the track ID; directions are zone edges; approach is in
// source pixels; one activity per channel and target across all triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {validateRule,ENGINE_SEMANTICS} from '../src/domain.mjs';
import {behaviorEvent} from '../src/behavior-events.mjs';
const square=[[.3,.2],[.7,.2],[.7,.8],[.3,.8]];  // edges 0 上 1 右 2 下 3 左 on a 1920x1080 source
const rule=(behavior,extra={})=>({id:`${behavior}@gate`,trigger_id:behavior,version:1,name:behavior,channel_id:'gate',state:'enabled',label_ids:['person'],
  geometry_revision:'g',label_map_version:'l',behavior,anchor:'center',entry_edges:[],exit_edges:[],duration_ms:0,
  ...(behavior==='appearance'?{}:{points:square}),...(behavior==='region_approach'?{approach_px:60}:{}),...extra});
// Each step: seconds offset and tracks [{id,x,y,obs:'det'|'pred'|'lost'|'low'}].
function run(rules){
  let cp=null,seq=0;const all=[],ended=[];
  const step=(at,tracks=[])=>{
    seq++;const pts=BigInt(Math.round(at*1000))*1000000n+1000000000n;
    const f={schema_version:'1.0',channel_id:'gate',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:'f'+seq,source_pts_ns:String(pts),
      captured_at:new Date(Date.parse('2026-10-20T02:00:00Z')+at*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
      tracks:tracks.map(t=>{const obs=t.obs??'det',seen=obs==='det'||obs==='low';
        return {track_id:t.id??'t1',label_id:'person',state:'confirmed',observation:seen?'detected':'lost',last_observed_pts_ns:seen?String(pts):String(pts-1n),
          bbox:{x:(t.x??.5)*1920-10,y:(t.y??.5)*1080-10,w:20,h:20},...(obs==='low'?{event_eligible:false}:{}),
          ...(obs==='pred'?{predicted_bbox:{x:(t.x??.5)*1920-10,y:(t.y??.5)*1080-10,w:20,h:20}}:{})};})};
    const out=evaluate(cp,f,rules);cp=out.checkpoint;all.push(...out.events);ended.push(...out.ended_episodes);return out.events;
  };
  return {step,all,ended};
}
test('appearance counts one track ID through real detections and dead-reckoned frames',()=>{
  const {step}=run([rule('appearance',{duration_ms:3000})]);
  assert.equal(step(0,[{}]).length,0);step(1,[{obs:'pred'}]);step(2,[{obs:'low'}]);
  assert.equal(step(3,[{}]).length,1);
  for(let at=4;at<10;at++)assert.equal(step(at,[{}]).length,0);  // same ID: one appearance
  assert.equal(step(10,[{id:'t2'}]).length,0);assert.equal(step(13,[{id:'t2'}]).length,1);  // a new ID is a new target
});
test('a lost frame without dead reckoning or a long time gap restarts the count',()=>{
  const lost=run([rule('appearance',{duration_ms:3000})]);
  lost.step(0,[{}]);lost.step(1,[{obs:'lost'}]);lost.step(2,[{}]);
  assert.equal(lost.step(3,[{}]).length,0);assert.equal(lost.step(5,[{}]).length,1);
  const gap=run([rule('appearance',{duration_ms:3000})]);
  for(let i=0;i<10;i++)gap.step(i/10,[{}]);         // 10 fps
  assert.equal(gap.step(4,[{}]).length,0);           // 3 s without any frame at 10 fps: not continuous
  for(let i=1;i<30;i++)assert.equal(gap.step(4+i/10,[{}]).length,0);
  assert.equal(gap.step(7,[{}]).length,1);
});
test('the appearance fires only on a real detection so the alarm has evidence',()=>{
  const {step}=run([rule('appearance',{duration_ms:1000})]);
  step(0,[{}]);assert.equal(step(1,[{obs:'pred'}]).length,0);assert.equal(step(1.1,[{}]).length,1);
});
test('intrusion direction is the crossed zone edge',()=>{
  const allowed=run([rule('region_enter',{entry_edges:[2]})]);
  allowed.step(0,[{y:.9}]);const fired=allowed.step(1,[{y:.6}]);
  assert.equal(fired.length,1);assert.equal(fired[0].direction.entry_edge,2);
  const other=run([rule('region_enter',{entry_edges:[2]})]);
  other.step(0,[{x:.1}]);assert.equal(other.step(1,[{x:.5}]).length,0);  // came in over the left edge
  const any=run([rule('region_enter')]);any.step(0,[{x:.1}]);assert.equal(any.step(1,[{x:.5}]).length,1);
});
test('passage direction is entry edge then exit edge',()=>{
  const path=[[0,.5,.9],[1,.5,.6],[2,.5,.4],[3,.5,.1]];  // up through the zone: bottom in, top out
  for(const [entry,exit,expected] of [[[2],[0],1],[[0],[2],0],[[],[0],1],[[2],[],1]]){
    const {step,all}=run([rule('region_traverse',{entry_edges:entry,exit_edges:exit})]);
    for(const [at,x,y] of path)step(at,[{x,y}]);
    assert.equal(all.length,expected,JSON.stringify([entry,exit]));
  }
});
test('approach range is measured in source pixels and filtered by the facing edge',()=>{
  // x=.27 is 0.03*1920 = 57.6 px left of the zone's left edge (edge 3).
  const near=run([rule('region_approach',{approach_px:60})]);near.step(0,[{x:.1}]);
  const fired=near.step(1,[{x:.27}]);assert.equal(fired.length,1);assert.equal(fired[0].direction.nearest_edge,3);
  const short=run([rule('region_approach',{approach_px:50})]);short.step(0,[{x:.1}]);assert.equal(short.step(1,[{x:.27}]).length,0);
  const wrongSide=run([rule('region_approach',{approach_px:60,entry_edges:[1]})]);wrongSide.step(0,[{x:.1}]);assert.equal(wrongSide.step(1,[{x:.27}]).length,0);
});
test('all triggers on a channel share one activity per target, ended when the ID is gone',()=>{
  const {step,all,ended}=run([rule('appearance'),rule('region_enter'),rule('region_traverse')]);
  for(const [at,y] of [[0,.95],[1,.6],[2,.4],[3,.05]])step(at,[{y}]);
  assert.deepEqual(all.map(e=>e.behavior),['appearance','region_enter','region_traverse']);
  assert.equal(new Set(all.map(e=>e.episode_id)).size,1);
  assert.equal(all[0].episode_started_at,all[2].episode_started_at);
  step(4,[]);assert.equal(ended.length,1);assert.equal(ended[0].end_reason,'track_expired');
  step(5,[{y:.95}]);assert.notEqual(all.at(-1).episode_id,all[0].episode_id);
});
test('facts carry the trigger and the current judgement semantics',()=>{
  const {step}=run([rule('appearance')]);const [event]=step(0,[{}]);
  const fact=behaviorEvent(event);
  assert.equal(fact.trigger_id,'appearance');assert.equal(fact.rule_id,'appearance@gate');
  assert.equal(fact.engine_semantics,ENGINE_SEMANTICS);assert.notEqual(ENGINE_SEMANTICS,'2026-10-20');
});
test('rules accept only the four trigger behaviors with their own parameters',()=>{
  for(const behavior of ['line_crossing','region_contact'])assert.throws(()=>validateRule(rule(behavior,{points:square})),e=>e.code==='unsupported_behavior');
  assert.throws(()=>validateRule({...rule('region_approach'),approach_px:undefined}),e=>e.code==='invalid_range');
  assert.throws(()=>validateRule(rule('region_enter',{entry_edges:[4]})),e=>e.code==='invalid_direction');
  assert.throws(()=>validateRule(rule('region_enter',{exit_edges:[1]})),e=>e.code==='invalid_direction');
  assert.throws(()=>validateRule(rule('region_traverse',{entry_edges:[1],exit_edges:[1]})),e=>e.code==='invalid_direction');
  assert.equal(validateRule({...rule('appearance'),trigger_id:undefined}).trigger_id,'appearance@gate');
});
test('a channel that runs at a low frame rate from the start still detects (frame-rate adaptive)',()=>{
  const slow=run([rule('appearance',{duration_ms:10000})]);
  for(let at=0;at<10;at+=2)assert.equal(slow.step(at,[{}]).length,0);  // 0.5 fps
  assert.equal(slow.step(10,[{}]).length,1);
  const enter=run([rule('region_enter')]);
  enter.step(0,[{y:.9}]);enter.step(2,[{y:.9}]);assert.equal(enter.step(4,[{y:.6}]).length,1);
});
test('after the frame rate drops for good, judgement recovers within a few frames',()=>{
  const {step,all}=run([rule('region_traverse')]);
  for(let i=0;i<10;i++)step(i/10,[{y:.95}]);   // 10 fps
  let at=1;for(let i=0;i<5;i++){at+=2;step(at,[{y:.95}]);}  // now 0.5 fps
  for(const y of [.6,.4,.05]){at+=2;step(at,[{y}]);}
  assert.equal(all.length,1);
});
