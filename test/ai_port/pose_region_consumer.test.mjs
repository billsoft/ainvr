// Copyright AINVR. Producer-invalidated joints must not accrue region duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observationEnvelope} from '../../alarm-service/src/observation-pump.mjs';
import {digest} from '../../alarm-service/src/domain.mjs';
import {evaluate} from '../../alarm-service/src/engine.mjs';
import {suspectedDownPose} from '../../alarm-service/src/region-state.mjs';
const labels=[{class_id:0,label_id:'person',name:'person',description:''}];
const url='rtmp://127.0.0.1/live/pose-boundary-test';
const version='labels-'+digest(['yolo26_pose_bpu',labels]);
const rule={id:'pose',version:1,name:'pose boundary test',channel_id:'ai',input_stream_id:'camera',state:'enabled',
  label_ids:['person'],geometry_revision:'g',label_map_version:version,behavior:'appearance',duration_ms:0,
  zone_id:'z',zone_version:1,points:[[0,0],[1,0],[1,1],[0,1]],review:{enabled:false},
  region_state:{operator:'presence',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'suspected_down'},
  source_binding:{stream_fingerprint:createHash('sha256').update(url).digest('hex'),input_stream_id:'camera',
    geometry_revision:'g',label_map_version:version,width:1000,height:1000,not_before:'2026-11-01T00:00:00Z'}};
function frame(n,ms,invalid=false){
  const pts=String(BigInt(ms)*1000000n);
  const points=Array.from({length:17},()=>({x:300,y:300,score:.9,visible:1}));
  for(const [a,b,x] of [[5,6,300],[11,12,400],[13,14,500],[15,16,600]]){
    points[a]={x,y:290,score:.9,visible:1};points[b]={x,y:310,score:.9,visible:1};
  }
  if(invalid)points[5]={x:-12,y:290,score:0,visible:0};
  const pose={schema_version:'1.0',type:'keypoints',status:'observed',layout:'coco17',
    coordinate_space:'original_image',image_size:[1000,1000],visibility_threshold:.5,
    source_model_sha256:'a'.repeat(64),points};
  const j={schema_version:'1.0',producer_id:'producer',offset:String(n),channel_id:'ai',stream_url:url,
    stream_session_id:'s',source_frame_index:String(n),source_pts_ns:pts,
    timestamp:Date.parse('2026-11-01T00:00:01Z')/1000+ms/1000,width:1000,height:1000,
    model:{id:'pose-model',label_catalog:{schema_version:'1.0',adapter:'yolo26_pose_bpu',labels}},
    observation_mode:'detections',tracks:[],detections:[{label_id:'person',source_node:'pose',
      bbox:{x:250,y:250,w:400,h:100},attributes:{pose}}],
    region_observations:{suspected_down:{state:'valid',source_pts_ns:pts,label_ids:['person']}}};
  return observationEnvelope(j,[rule]).envelope.frame;
}
test('score0 visible0 retains 17 points but invalidates pose predicate and duration',()=>{
  const bad=frame(2,500,true);
  assert.equal(bad.tracks[0].attributes.pose.points.length,17);
  assert.equal(suspectedDownPose(bad.tracks[0],bad),'unknown');
  let r=evaluate(null,frame(1,0),[rule]);assert.equal(r.checkpoint.region_states.pose.phase,'pending');
  r=evaluate(r.checkpoint,bad,[rule]);
  assert.equal(r.events.length,0);assert.equal(r.checkpoint.region_states.pose.phase,'unknown');
  assert.equal(r.checkpoint.region_states.pose.window,null);
  r=evaluate(r.checkpoint,frame(3,1000),[rule]);
  assert.equal(r.events.length,0);assert.equal(r.checkpoint.region_states.pose.window.elapsed_ns,'0');
  r=evaluate(r.checkpoint,frame(4,1500),[rule]);assert.equal(r.events.length,0);
  r=evaluate(r.checkpoint,frame(5,2000),[rule]);assert.equal(r.events.length,1);
});
