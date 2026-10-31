import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewWorker} from '../src/review-worker.mjs';
const sample={seq:'1',frame_id:'f',source_pts_ns:'1',source_frame_index:'1',captured_at:'2026-10-30T00:00:00Z',track_id:'t',label_id:'person',observation:'detected',event_eligible:true,bbox:{x:10,y:10,w:20,h:20}};
const row={alarm_id:'a',occurred_at:sample.captured_at,channel_id:'c',input_stream_id:'in',frame_id:'f',direction:null,model_snapshot:{label_map_version:'l'},stream_session_id:'s',track_ids:['t'],behavior:'appearance',version:1,handling:{state:'unacknowledged',revision:0},rule:{snapshot:{id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],behavior:'appearance',labels:[{label_id:'person',name:'person'}]}},analysis_evidence:{track:{label_id:'person'},source:{width:100,height:100,coordinate_space:'source_pixels',geometry_revision:'g'},review_context:{trace:[sample]}},review:{state:'running',context_state:'ready',generation:'g',attempt:1,next_attempt_at:0,policy:{enabled:true,reject_below:.05,approve_above:.95}}};
test('malformed model envelopes never save prepared images or acknowledge an alarm',async()=>{
 for(const result of [null,{schema:'other'}, {schema:'ainvr.alarm_review.v1',real_score:1,model:{package_sha256:'bad'}}, {schema:'ainvr.alarm_review.v1',real_score:NaN,model:{package_sha256:'a'.repeat(64)},prepared_image:{}}]){
  const writes=[];
  const events={findOneAndUpdate:async()=>structuredClone(row),findOne:async()=>({alarm_id:'a'}),updateOne:async(f,u)=>writes.push(u)};
  const worker=new ReviewWorker({events},{readiness:async()=>false,authorization:async()=>null,context:{image:async()=>({data:Buffer.from('fixture')}),savePrepared:async()=>assert.fail('must validate before saving')},invoke:async()=>result});
  await worker.step();
  assert.equal(writes[0].$set['review.reason'],'invalid_model_result');
  assert.ok(writes.every(u=>!u.$set?.handling));
 }
});
