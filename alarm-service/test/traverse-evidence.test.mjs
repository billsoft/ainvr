import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {validateRule} from '../src/domain.mjs';
import {compactProof} from '../src/compact-evidence.mjs';
// A traversal alarm is reviewed only with all four keyframes. On 190 footage every
// traversal alarm lacked "进入前": the last frame before entering often falls inside the
// boundary hysteresis band, and the last stable outside observation had been discarded.
const rule=validateRule({id:'r',version:1,name:'p',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]]});
rule.labels=[{label_id:'person',name:'person'}];
function run(xs){
  let cp=null;const events=[];
  xs.forEach((x,i)=>{
    const pts=String((i+1)*200000000);
    const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:String(i+1),frame_id:'f'+(i+1),source_pts_ns:pts,source_frame_index:String(i+1),
      captured_at:new Date(1794700000000+i*200).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},
      tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1000-10,y:400,w:20,h:100}}]};
    const result=evaluate(cp,frame,[rule]);cp=result.checkpoint;events.push(...result.events);
  });
  return events;
}
const roles=event=>event.analysis_evidence.review_context.samples.flatMap(s=>s.roles);
test('the last stable outside frame is kept as "进入前" when the frame just before entering is on the boundary',()=>{
  const [event]=run([.1,.2,.298,.4,.5,.6,.8,.9]);
  assert.ok(event,'the passage is raised');
  for(const role of ['进入前','进入后','离开前','离开后'])assert.ok(roles(event).includes(role),role);
  assert.equal(event.analysis_evidence.review_context.samples.find(s=>s.roles.includes('进入前')).frame_id,'f2');
  assert.equal(compactProof({...event,track_ids:['t']}).ok,true);
});
test('a clean passage still uses the frame just before entering',()=>{
  const [event]=run([.1,.2,.25,.4,.5,.6,.8,.9]);
  assert.equal(event.analysis_evidence.review_context.samples.find(s=>s.roles.includes('进入前')).frame_id,'f3');
  assert.equal(compactProof({...event,track_ids:['t']}).ok,true);
});
