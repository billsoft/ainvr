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

for (const fps of [2, 3, 5]) {
 test(`${fps} FPS: a continuous observed intrusion emits only once`,()=>{
  const {step,all}=run([rule('region_enter')]);
  step(0,[{x:.1}]);
  for(let i=1;i<=fps*10;i++)step(i/fps,[{x:.5}]);
  assert.equal(all.length,1);
  assert.equal(all[0].behavior,'region_enter');
 });
 test(`${fps} FPS: traversing two different edges has one event and observed evidence`,()=>{
  const {step,all}=run([rule('region_traverse',{entry_edges:[2],exit_edges:[0]})]);
  for(const [i,y] of [.95,.6,.4,.05].entries())step(i/fps,[{y}]);
  assert.equal(all.length,1);
  assert.equal(all[0].direction.entry_edge,2);
  assert.equal(all[0].direction.exit_edge,0);
 });
 test(`${fps} FPS: predicted positions cannot invent traversal`,()=>{
  const {step,all}=run([rule('region_traverse')]);
  step(0,[{y:.95}]);step(1/fps,[{y:.6,obs:'pred'}]);step(2/fps,[{y:.05,obs:'pred'}]);
  assert.equal(all.length,0);
 });
}
