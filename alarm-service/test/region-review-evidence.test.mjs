import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {buildReviewEvidence} from '../src/review-evidence.mjs';
import {evidenceCaptureIntents} from '../src/ingestion.mjs';
const rule={id:'r',version:1,name:'区域连续无人',channel_id:'ai',input_stream_id:'camera',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'lm',behavior:'appearance',duration_ms:0,zone_id:'zone',zone_version:1,points:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],review:{enabled:false},region_state:{operator:'count_below',threshold:1,duration_ms:1000,recovery_ms:1000,event_kind:'region_absence'}};
function event(){
 let cp=null,alarm;
 for(let i=0;i<3;i++){
  const f={schema_version:'1.0',channel_id:'ai',input_stream_id:'camera',stream_session_id:'s',seq:String(i),source_pts_ns:String(i*500000000),source_frame_index:String(i),frame_id:`s-${i}`,captured_at:new Date(1793940000000+i*500).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'lm'},tracks:[]};
  const result=evaluate(cp,f,[rule]);cp=result.checkpoint;alarm=result.events[0]??alarm;
 }
 return alarm;
}
test('actual region event has readable proof and full-frame evidence intents without fictitious target',()=>{
 const row=event();assert.ok(row);
 const proof=buildReviewEvidence(row);
 assert.equal(proof.scope,'region');assert.equal(proof.blocking,false);
 assert.ok(proof.checks.some(c=>c.id==='semantic_review'&&c.status==='unknown'));
 assert.ok(proof.observations.every(o=>o.region_count===0&&o.point===null));
 const intents=evidenceCaptureIntents({events:[row]});
 assert.equal(intents.length,row.analysis_evidence.review_context.samples.length);
 assert.ok(intents.every(i=>!i.sample.bbox&&!i.sample.track_id));
});
test('changed region proof and trigger identity cannot pass evidence validation',()=>{
 const altered=event();altered.analysis_evidence.review_context.samples[0].count=3;
 assert.equal(buildReviewEvidence(altered).blocking,true);
 const wrongFrame=event();wrongFrame.frame_id='other';
 assert.equal(buildReviewEvidence(wrongFrame).blocking,true);
});
