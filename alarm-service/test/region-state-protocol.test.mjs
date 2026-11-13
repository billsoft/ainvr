import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observationEnvelope} from '../src/observation-pump.mjs';
import {digest,validateFrame} from '../src/domain.mjs';
import {evaluate} from '../src/engine.mjs';
import {behaviorEvent} from '../src/behavior-events.mjs';
import {suspectedDownPose} from '../src/region-state.mjs';
const labels=[{class_id:0,label_id:'person',name:'person',description:''}];
const url='rtmp://127.0.0.1/live/region-test',labelVersion='labels-'+digest(['yolo26_pose_bpu',labels]);
const rule={id:'pose',version:1,name:'疑似倒地',channel_id:'ai',input_stream_id:'camera',state:'enabled',
  label_ids:['person'],geometry_revision:'g',label_map_version:labelVersion,behavior:'appearance',duration_ms:0,zone_id:'z',zone_version:1,
  points:[[0,0],[1,0],[1,1],[0,1]],review:{enabled:false},region_state:{operator:'presence',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'suspected_down'},
  source_binding:{stream_fingerprint:createHash('sha256').update(url).digest('hex'),input_stream_id:'camera',geometry_revision:'g',label_map_version:labelVersion,width:1000,height:1000,not_before:'2026-11-01T00:00:00Z'}};
function pose(kind='horizontal'){
  const points=Array.from({length:17},()=>({x:300,y:300,score:.9}));
  for(const [a,b,x,y] of [[5,6,300,300],[11,12,400,300],[13,14,500,300],[15,16,600,300]]){
    points[a]=kind==='horizontal'?{x,y:y-10,score:.9}:{x:400-10,y:x,score:.9};
    points[b]=kind==='horizontal'?{x,y:y+10,score:.9}:{x:400+10,y:x,score:.9};
  }
  return {schema_version:'1.0',type:'keypoints',status:'observed',layout:'coco17',coordinate_space:'original_image',image_size:[1000,1000],visibility_threshold:.5,source_model_sha256:'a'.repeat(64),points};
}
function journal(n=1,{mode='detections',attributes={pose:pose()},capability=true}={}){
  const pts=String(BigInt(n-1)*1000000000n),d={label_id:'person',bbox:{x:250,y:250,w:400,h:100},attributes,source_node:'pose'};
  return {schema_version:'1.0',producer_id:'producer',offset:String(n),channel_id:'ai',stream_url:url,stream_session_id:'s',source_frame_index:String(n),source_pts_ns:pts,
    timestamp:Date.parse('2026-11-01T00:00:01Z')/1000+n,width:1000,height:1000,model:{id:'pose-model',label_catalog:{schema_version:'1.0',adapter:'yolo26_pose_bpu',labels}},observation_mode:mode,
    ...(mode==='detections'?{detections:[d],tracks:[]}:{tracks:[{...d,track_id:'p',state:'confirmed',observation:'detected',last_observed_pts_ns:pts}]}),
    ...(capability?{region_observations:{suspected_down:{state:'valid',source_pts_ns:pts,label_ids:['person']}}}:{})};
}
for(const mode of ['tracks','detections'])test(`journal preserves bounded pose/source_node and capability proof in ${mode}`,()=>{
  const input=journal(1,{mode}),f=observationEnvelope(input,[rule]).envelope.frame;
  assert.deepEqual(f.tracks[0].attributes,input[mode==='tracks'?'tracks':'detections'][0].attributes);
  assert.equal(f.tracks[0].source_node,'pose');assert.deepEqual(f.region_observations,input.region_observations);
  const first=evaluate(null,f,[rule]);const second=evaluate(first.checkpoint,observationEnvelope(journal(2,{mode}),[rule]).envelope.frame,[rule]);
  assert.equal(second.events.length,1);assert.equal(second.events[0].event_kind,'suspected_down');
  assert.equal(second.events[0].analysis_evidence.review_context.samples[0].pose_gate,'coco17-horizontal-v1');
});
test('pose requires complete visible horizontal torso and legs, not a plain person or bent torso',()=>{
  const f=observationEnvelope(journal(),[rule]).envelope.frame,t=f.tracks[0];
  assert.equal(suspectedDownPose(t,f),'candidate');
  assert.equal(suspectedDownPose({...t,attributes:{}},f),'unknown');
  assert.equal(suspectedDownPose({...t,bbox:{x:350,y:250,w:100,h:400},attributes:{pose:pose('upright')}},f),'clear');
  for(const mutate of [p=>{p.points[5].score=.2},p=>{p.points[15].x=1200},p=>{p.association={method:'unknown',iou:1}},p=>{p.source_node='other'},p=>{p.image_size=[640,640]},p=>{p.points[13].y=500;p.points[14].y=500}]){
    const p=pose();mutate(p);assert.equal(suspectedDownPose({...t,attributes:{pose:p}},f),'unknown');
  }
});
test('mere valid person presence cannot produce suspected-down even with capability attestation',()=>{
  const a=observationEnvelope(journal(1,{attributes:{}}),[rule]).envelope.frame;
  const b=observationEnvelope(journal(2,{attributes:{}}),[rule]).envelope.frame;
  const first=evaluate(null,a,[rule]),second=evaluate(first.checkpoint,b,[rule]);
  assert.equal(second.events.length,0);assert.equal(second.checkpoint.region_states.pose.reason,'pose_unconfirmed');
});
test('UTF-8 attributes budget is 2048 bytes, unsupported source identity fails closed',()=>{
  const exact={note:'x'.repeat(2037)};
  assert.equal(Buffer.byteLength(JSON.stringify(exact)),2048);
  assert.doesNotThrow(()=>observationEnvelope(journal(1,{attributes:exact}),[rule]));
  assert.throws(()=>observationEnvelope(journal(1,{attributes:{note:'x'.repeat(2038)}}),[rule]),e=>e.code==='invalid_attributes');
  assert.throws(()=>observationEnvelope(journal(1,{attributes:{note:'中'.repeat(700)}}),[rule]),e=>e.code==='invalid_attributes');
  const f=observationEnvelope(journal(),[rule]).envelope.frame;f.tracks[0].source_node={id:'invalid'};
  assert.throws(()=>validateFrame(f),e=>e.code==='invalid_identity');
});
test('region behavior facts use nullable track identity and retain count/status proof',()=>{
  const a=evaluate(null,observationEnvelope(journal(1),[rule]).envelope.frame,[rule]);
  const event=evaluate(a.checkpoint,observationEnvelope(journal(2),[rule]).envelope.frame,[rule]).events[0];
  const fact=behaviorEvent(event);assert.equal(fact.track_id,null);assert.equal(fact.label_id,null);assert.equal(fact.identity_kind,'region');
  assert.equal(fact.event_kind,'suspected_down');assert.equal(fact.quality.basis,'observed_region');
  assert.equal(fact.analysis_evidence.region_state.validity,'valid');assert.equal(fact.analysis_evidence.region_state.count,1);
  assert.equal(fact.event_id,behaviorEvent(JSON.parse(JSON.stringify(event))).event_id);
});
for(const reason of ['ambiguous_pose_association','attribute_capacity'])for(const mode of ['tracks','detections'])test(`${reason} attestation survives ${mode} pump and cannot recover an active region episode`,()=>{
  let result=evaluate(null,observationEnvelope(journal(1,{mode}),[rule]).envelope.frame,[rule]);
  result=evaluate(result.checkpoint,observationEnvelope(journal(2,{mode}),[rule]).envelope.frame,[rule]);
  const episode=result.events[0].episode_id;
  for(const n of [3,4,5,6,7]){
    const input=journal(n,{mode});input.tracks=[];if(mode==='detections')input.detections=[];
    const ambiguous=n===3||n===5;
    if(ambiguous){Object.assign(input.region_observations.suspected_down,{state:'unknown',reason});if(reason==='attribute_capacity')input.attribute_delivery={state:'omitted',reason:'observation_capacity',targets:1};}
    const f=observationEnvelope(input,[rule]).envelope.frame;
    assert.deepEqual(f.region_observations,input.region_observations);
    result=evaluate(result.checkpoint,f,[rule]);
    const state=result.checkpoint.region_states.pose;
    assert.equal(result.events.length,0);
    if(n<7){assert.equal(state.episode_id,episode);assert.equal((result.ended_episodes??[]).length,0);}
    if(ambiguous){assert.equal(state.phase,'unknown');assert.equal(state.count,null);assert.equal(state.window,null);}
    if(n===4||n===6){assert.equal(state.phase,'recovering');assert.equal(state.window.elapsed_ns,'0');}
  }
  assert.equal(result.checkpoint.region_states.pose.phase,'normal');
  assert.equal(result.ended_episodes[0].end_reason,'condition_cleared');
});
for(const mode of ['tracks','detections'])test(`attribute capacity preserves all 1000 ${mode} boxes and cannot create a pose candidate`,()=>{
  const countRule={...rule,id:'count',region_state:{...rule.region_state,operator:'count_at_least',threshold:1000,event_kind:'region_count'}};
  let checkpoint=null;
  for(const n of [1,2]){
    const input=journal(n,{mode}),field=mode==='tracks'?'tracks':'detections',target=input[field][0];
    input[field]=Array.from({length:1000},(_,i)=>{const {attributes,...box}=target;return {...box,...(mode==='tracks'?{track_id:`p${i}`}:{})};});
    input.attribute_delivery={state:'omitted',reason:'observation_capacity',targets:1000};
    Object.assign(input.region_observations.suspected_down,{state:'unknown',reason:'attribute_capacity'});
    const f=observationEnvelope(input,[rule,countRule]).envelope.frame;
    assert.equal(f.tracks.length,1000);assert.deepEqual(f.attribute_delivery,input.attribute_delivery);
    assert.ok(f.tracks.every((t,i)=>t.attributes===undefined&&JSON.stringify(t.bbox)===JSON.stringify(input[field][i].bbox)));
    assert.equal(new Set(f.tracks.map(t=>t.track_id)).size,1000);
    const result=evaluate(checkpoint,f,[rule,countRule]);checkpoint=result.checkpoint;
    assert.equal(checkpoint.region_states.pose.phase,'unknown');assert.equal(checkpoint.region_states.pose.count,null);
    assert.ok(result.events.every(event=>event.event_kind!=='suspected_down'));
    if(mode==='tracks'){assert.equal(checkpoint.region_states.count.count,1000);if(n===2)assert.equal(result.events[0].event_kind,'region_count');}
  }
});
test('omission marker overrides stale valid pose attestation; diagnostic fields are bounded',()=>{
  for(const capability of [true,false]){
    const input=journal(1,{capability});input.tracks=[];input.detections=[];
    input.attribute_delivery={state:'omitted',reason:'observation_capacity',targets:1};
    const f=observationEnvelope(input,[rule]).envelope.frame;
    assert.equal(f.region_observations.suspected_down.state,'unknown');
    assert.equal(f.region_observations.suspected_down.reason,'attribute_capacity');
  }
  for(const reason of [null,{},'', 'x'.repeat(129),'中'.repeat(43),'invalid\nreason']){
    const input=journal();input.region_observations.suspected_down={state:'unknown',reason};
    assert.throws(()=>observationEnvelope(input,[rule]),e=>e.code==='invalid_observation');
  }
  for(const patch of [{targets:4097},{targets:-1},{targets:1.5},{state:'complete'},{reason:'other'}]){
    const input=journal();input.attribute_delivery={state:'omitted',reason:'observation_capacity',targets:1,...patch};
    assert.throws(()=>observationEnvelope(input,[rule]),e=>e.code==='invalid_observation');
  }
});
