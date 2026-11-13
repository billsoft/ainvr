import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {validateRule} from '../src/domain.mjs';

const base={id:'r',version:1,name:'区域人数不足',channel_id:'ai',input_stream_id:'camera',state:'enabled',
  label_ids:['person'],geometry_revision:'g',label_map_version:'lm',behavior:'appearance',duration_ms:0,
  zone_id:'zone',zone_version:1,points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],review:{enabled:false},
  region_state:{operator:'count_below',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'region_absence'}};
const clone=v=>JSON.parse(JSON.stringify(v));
function frame(seq,ms,{count=0,session='s',capturedMs=ms,patch={},trackPatch={}}={}){
  const pts=String(BigInt(ms)*1000000n);
  return {schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:session,
    seq:String(seq),source_pts_ns:pts,source_frame_index:String(seq),frame_id:`${session}-${seq}`,
    captured_at:new Date(1793940000000+capturedMs).toISOString(),
    source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},
    tracks:Array.from({length:count},(_,i)=>({track_id:`p${i}`,label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:300+i*20,y:300,w:20,h:50},...trackPatch})),...patch};
}
function scenario(rule=base){
  let checkpoint=null;const events=[],ended=[];
  return {events,ended,get checkpoint(){return checkpoint;},step(f,rules=[rule]){
    const before=clone(checkpoint),result=evaluate(checkpoint,f,rules);
    assert.deepEqual(checkpoint,before,'evaluate must not mutate its input checkpoint');
    checkpoint=clone(result.checkpoint);events.push(...result.events);ended.push(...result.ended_episodes);return result;
  }};
}
const state=s=>s.checkpoint.region_states.r;
test('starts at first valid source PTS, needs multiple samples, uses no time before first frame',()=>{
  const s=scenario();s.step(frame(1,100000));assert.equal(state(s).phase,'pending');assert.equal(state(s).window.elapsed_ns,'0');
  s.step(frame(2,100500));assert.equal(s.events.length,0);
  s.step(frame(3,101000));assert.equal(s.events.length,1);
  const e=s.events[0];assert.equal(e.analysis_evidence.region_state.valid_duration_ms,1000);
  assert.equal(e.analysis_evidence.region_state.sample_count,3);assert.equal(e.review.state,'skipped');
  assert.equal(e.event_kind,'region_absence');assert.equal(e.incident_scope,'region');assert.deepEqual(e.track_ids,[]);
  assert.equal(e.analysis_evidence.track,undefined);
  assert.ok(e.analysis_evidence.review_context.samples.every(x=>x.observation==='region'&&x.identity_kind==='region'&&!x.bbox));
});
test('elapsed time comes only from PTS even when captured_at jumps forward',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,200,{capturedMs:3600000}));assert.equal(s.events.length,0);
  s.step(frame(3,1000,{capturedMs:3600001}));assert.equal(s.events.length,1);
});
test('large first inter-frame interval cannot establish baseline or create zero-person event',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,60000));assert.equal(state(s).phase,'unknown');
  assert.equal(state(s).count,null);assert.equal(s.events.length,0);
  s.step(frame(3,61000));assert.equal(state(s).window.elapsed_ns,'0');assert.equal(s.events.length,0);
  s.step(frame(4,62000));assert.equal(s.events.length,1);
});
for(const [name,patch] of [['unavailable',{observation_status:'unknown'}],['invalid PTS provenance',{source_pts_valid:false}],['explicit gap',{gap:true}],['missing source identity',{source_frame_index:undefined}]]){
  test(`${name} is unknown, not zero, and breaks pending continuity`,()=>{
    const s=scenario();s.step(frame(1,0));s.step(frame(2,500,{patch}));assert.equal(state(s).validity,'unknown');assert.equal(state(s).count,null);
    s.step(frame(3,1000));assert.equal(s.events.length,0);s.step(frame(4,2000));assert.equal(s.events.length,1);
  });
}
for(const trackPatch of [{observation:'lost',last_observed_pts_ns:'0'},{observation:'predicted',last_observed_pts_ns:'0'},{state:'tentative'},{event_eligible:false}]){
  test(`incomplete target ${JSON.stringify(trackPatch)} cannot prove a lower count`,()=>{
    const s=scenario({...base,region_state:{...base.region_state,threshold:2,event_kind:'region_count'}});
    s.step(frame(1,0));s.step(frame(2,1000,{count:1,trackPatch}));assert.equal(state(s).phase,'unknown');assert.equal(s.events.length,0);
  });
}
test('count_below is strict, count_at_least includes equality, outside-region targets do not count',()=>{
  const below=scenario({...base,region_state:{...base.region_state,threshold:2,event_kind:'region_count'}});
  below.step(frame(1,0,{count:2}));below.step(frame(2,1000,{count:2}));assert.equal(below.events.length,0);
  below.step(frame(3,2000,{count:1}));below.step(frame(4,3000,{count:1}));assert.equal(below.events.length,1);
  const above=scenario({...base,region_state:{...base.region_state,operator:'count_at_least',threshold:2,event_kind:'region_count'}});
  above.step(frame(1,0,{count:2}));above.step(frame(2,1000,{count:2}));assert.equal(above.events.length,1);
  const outside=scenario();outside.step(frame(1,0,{count:1,trackPatch:{bbox:{x:0,y:0,w:20,h:20}}}));outside.step(frame(2,1000,{count:1,trackPatch:{bbox:{x:0,y:0,w:20,h:20}}}));assert.equal(outside.events.length,1);
});
test('boundary ambiguity and detection-only mode cannot establish region counts',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,1000,{count:1,trackPatch:{bbox:{x:90,y:300,w:20,h:20}}}));assert.equal(state(s).reason,'boundary_uncertain');
  s.step(frame(3,2000,{patch:{observation_mode:'detections'}}));assert.equal(state(s).reason,'tracking_required');
});
const track=(id,label,x,y,extra={})=>({track_id:id,label_id:label,state:'confirmed',observation:'detected',bbox:{x,y,w:20,h:50},...extra});
const at=(ms,tracks)=>tracks.map(t=>({...t,last_observed_pts_ns:t.observation==='detected'?String(BigInt(ms)*1000000n):'0'}));
test('uncertain targets clearly outside the zone do not interrupt a sustained presence inside it',()=>{
  const rule={...base,label_ids:['smoke'],region_state:{...base.region_state,operator:'presence',event_kind:'fire_smoke'}};
  const valid=ms=>({state:'valid',source_pts_ns:String(BigInt(ms)*1000000n),label_ids:['smoke']});
  for(const stray of [{state:'tentative'},{observation:'predicted'},{event_eligible:false}]){
    const s=scenario(rule);
    for(const [seq,ms] of [[1,1000],[2,1500],[3,2000]])s.step(frame(seq,ms,{patch:{region_observations:{fire_smoke:valid(ms)},
      tracks:at(ms,[track('in','smoke',400,400),track('out','smoke',5,5,stray)])}}));
    assert.equal(s.events.length,1,JSON.stringify(stray));assert.equal(s.events[0].analysis_evidence.region_state.count,1);
  }
});
test('an uncertain target that may be inside keeps the state unknown instead of declaring recovery',()=>{
  const rule={...base,region_state:{...base.region_state,operator:'count_at_least',threshold:1,event_kind:'region_count'}};
  const s=scenario(rule);s.step(frame(1,0,{count:1}));s.step(frame(2,1000,{count:1}));assert.equal(s.events.length,1);
  s.step(frame(3,2000,{patch:{tracks:at(2000,[track('p0','person',300,300,{observation:'predicted'})])}}));
  assert.equal(state(s).phase,'unknown');assert.equal(state(s).reason,'incomplete_target_observation');
  s.step(frame(4,3000,{patch:{tracks:at(3000,[track('p0','person',300,300,{state:'tentative'})])}}));assert.equal(state(s).phase,'unknown');
  s.step(frame(5,4000,{patch:{tracks:at(4000,[track('edge','person',90,300)])}}));assert.equal(state(s).reason,'boundary_uncertain');
  assert.equal(s.ended.length,0);
});
test('absence ignores a detected candidate clearly outside but not a target whose position is unknown',()=>{
  const outside=scenario();
  outside.step(frame(1,0,{patch:{tracks:at(0,[track('t','person',5,5,{state:'tentative'})])}}));
  outside.step(frame(2,1000,{patch:{tracks:at(1000,[track('t','person',5,5,{state:'tentative'})])}}));assert.equal(outside.events.length,1);
  const hidden=scenario();hidden.step(frame(1,0));
  hidden.step(frame(2,1000,{patch:{tracks:at(1000,[track('t','person',5,5,{observation:'predicted'})])}}));
  assert.equal(hidden.events.length,0);assert.equal(state(hidden).reason,'incomplete_target_observation');
  const inside=scenario();inside.step(frame(1,0));
  inside.step(frame(2,1000,{patch:{tracks:at(1000,[track('t','person',400,400,{state:'tentative'})])}}));
  assert.equal(inside.events.length,0);assert.equal(state(inside).reason,'incomplete_target_observation');
});
test('presence requires a current explicit capability proof and cannot reuse stale semantic output',()=>{
  const rule={...base,label_ids:['smoke'],region_state:{...base.region_state,operator:'presence',event_kind:'fire_smoke'}};
  const s=scenario(rule),valid=ms=>({region_observations:{fire_smoke:{state:'valid',source_pts_ns:String(BigInt(ms)*1000000n),label_ids:['smoke']}}});
  s.step(frame(1,0,{count:1,trackPatch:{label_id:'smoke'}}));assert.equal(state(s).phase,'unknown');
  s.step(frame(2,1000,{count:1,trackPatch:{label_id:'smoke'},patch:valid(1000)}));assert.equal(s.events.length,0);
  s.step(frame(3,2000,{count:1,trackPatch:{label_id:'smoke'},patch:valid(1000)}));assert.equal(state(s).phase,'unknown');
  s.step(frame(4,3000,{count:1,trackPatch:{label_id:'smoke'},patch:valid(3000)}));
  s.step(frame(5,4000,{count:1,trackPatch:{label_id:'smoke'},patch:valid(4000)}));assert.equal(s.events.length,1);
  assert.equal(s.events[0].event_kind,'fire_smoke');
});
test('active episode survives session/gap/PTS resets without duplicate or false recovery',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,1000));const id=s.events[0].episode_id;
  s.step(frame(4,2000));assert.equal(state(s).phase,'unknown');assert.equal(state(s).episode_id,id);
  s.step(frame(1,0,{session:'new',count:1}));assert.equal(state(s).phase,'unknown');assert.equal(s.ended.length,0);
  s.step(frame(2,1000,{session:'new',count:1}));assert.equal(state(s).phase,'recovering');
  s.step(frame(3,500,{session:'new',count:1}));assert.equal(state(s).phase,'unknown');
  s.step(frame(4,1000,{session:'new'}));assert.equal(state(s).phase,'active');assert.equal(s.events.length,1);assert.equal(s.ended.length,0);
});
test('recovery needs multiple valid observations and resets after unknown; same risk rearms once',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,1000));
  s.step(frame(3,2000,{count:1}));assert.equal(s.ended.length,0);
  s.step(frame(4,3000,{patch:{observation_status:'unknown'}}));assert.equal(s.ended.length,0);
  s.step(frame(5,4000,{count:1}));assert.equal(s.ended.length,0);
  s.step(frame(6,5000,{count:1}));assert.equal(s.ended.length,1);assert.equal(s.ended[0].end_reason,'condition_cleared');
  s.step(frame(7,6000));s.step(frame(8,7000));assert.equal(s.events.length,2);assert.notEqual(s.events[0].episode_id,s.events[1].episode_id);
});
test('JSON checkpoint restore and replay are deterministic and idempotent before and after activation',()=>{
  const first=evaluate(null,frame(1,0),[base]);
  const a=evaluate(clone(first.checkpoint),frame(2,1000),[base]);
  const b=evaluate(clone(first.checkpoint),frame(2,1000),[base]);assert.deepEqual(a,b);
  const replay=evaluate(clone(a.checkpoint),frame(2,1000),[base]);assert.equal(replay.events.length,0);
  const resumed=evaluate(clone(a.checkpoint),frame(3,2000),[base]);assert.equal(resumed.events.length,0);
  assert.equal(resumed.active_episodes[0].episode_id,a.events[0].episode_id);
});
test('state and evidence remain bounded through thousands of active observations',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,1000));
  const initialBytes=JSON.stringify(s.checkpoint.region_states).length;
  for(let i=3;i<1003;i++)s.step(frame(i,(i-1)*1000));
  assert.equal(s.events.length,1);assert.equal(state(s).window,null);
  assert.ok(JSON.stringify(s.checkpoint.region_states).length<initialBytes+100);
});
test('rule replacement/removal ends only its regional contract',()=>{
  const s=scenario();s.step(frame(1,0));s.step(frame(2,1000));s.step(frame(3,2000),[{...base,version:2}]);
  assert.equal(s.ended.length,1);assert.equal(s.ended[0].end_reason,'configuration_changed');
  s.step(frame(4,3000),[{...base,version:2}]);assert.equal(s.events.length,2);
  s.step(frame(5,4000),[]);assert.equal(s.ended.length,2);assert.deepEqual(s.checkpoint.region_states,{});
});
test('adding region rules does not change legacy counter events, coverage or per-target checkpoint',()=>{
  const counter={...base,id:'counter',region_state:undefined,behavior:'region_traverse',alarm_enabled:false,counter_id:'c',duration_ms:0};
  let legacy=null,mixed=null;
  for(let i=1;i<=5;i++){
    const f=frame(i,i*500,{count:1,trackPatch:{bbox:{x:[0,150,400,800,950][i-1],y:300,w:20,h:20}}});
    const a=evaluate(legacy,f,[counter]),b=evaluate(mixed,f,[counter,base]);legacy=clone(a.checkpoint);mixed=clone(b.checkpoint);
    assert.deepEqual(b.events.filter(e=>!e.identity_kind),a.events);assert.deepEqual(b.coverage,a.coverage);
    for(const k of ['states','episodes','flow_coverage'])assert.deepEqual(b.checkpoint[k],a.checkpoint[k]);
  }
});
test('invalid or contradictory region contracts fail closed',()=>{
  for(const change of [{behavior:'region_enter'},{counter_id:'c'},{alarm_enabled:false},{duration_ms:1000},{zone_id:null},
    {review:{enabled:true}},{region_state:{...base.region_state,duration_ms:0}},
    {region_state:{...base.region_state,max_gap_ms:5001}},{region_state:{...base.region_state,threshold:0}},
    {region_state:{...base.region_state,operator:'presence'}},{region_state:{...base.region_state,unexpected:true}}]){
    assert.throws(()=>validateRule({...base,...change}));
  }
});

test('removed labels invalidate pending region evidence; restoring a compatible label starts a fresh duration',()=>{
 const s=scenario();s.step(frame(1,0));
 const changed={model:{label_map_version:'without-person',compatible_label_versions:[{version:'lm',label_ids:['car']}]}};
 s.step(frame(2,500,{patch:changed}));s.step(frame(3,1500,{patch:changed}));
 assert.equal(state(s).validity,'unknown');assert.equal(s.events.length,0);
 const restored={model:{label_map_version:'restored',compatible_label_versions:[{version:'lm',label_ids:['person']}]}};
 s.step(frame(4,2000,{patch:restored}));assert.equal(s.events.length,0);
 s.step(frame(5,3000,{patch:restored}));assert.equal(s.events.length,1);
});
