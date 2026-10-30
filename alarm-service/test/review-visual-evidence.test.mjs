import test from 'node:test';
import assert from 'node:assert/strict';
import {selectVisualEvidence} from '../src/review-visual-evidence.mjs';
import {retainedTarget} from '../src/retained-target.mjs';
const id='a'.repeat(64),data=Buffer.from('ffd8ffc00011080040004003012200021101031101ffd9','hex');
const before={frame_id:'before',seq:'1',source_pts_ns:'1',source_frame_index:'1'};
const trigger={frame_id:'trigger',seq:'2',source_pts_ns:'2',source_frame_index:'2'};
const row=()=>({channel_id:'c',stream_session_id:'s',frame_id:'trigger',source_pts_ns:'2',track_ids:['t'],behavior_event_ids:[id],
 review:{evidence_id:id},rule:{snapshot:{labels:[{label_id:'person',name:'人'}]}},
 analysis_evidence:{source_frame_index:'2',track:{label_id:'person'},source:{width:1920,height:1080}}});
const proof={ok:true,samples:[before,trigger]};
const missing=async()=>{throw Error('missing_context')};
test('complete frames preserve the existing full-keyframe decision contract',async()=>{
 const plan=await selectVisualEvidence(row(),proof,{image:async sample=>({key:sample.frame_id,data}),retained:()=>assert.fail('no crop needed')});
 assert.equal(plan.mode,'all_keyframes');assert.equal(plan.confirm_only,false);assert.equal(plan.items.length,2);
});
test('verified behavior can use an exact trigger crop without fabricating missing moments',async()=>{
 const plan=await selectVisualEvidence(row(),proof,{image:missing,retained:async()=>({data,width:64,height:64,sha256:'f'.repeat(64),event_id:id})});
 assert.equal(plan.mode,'verified_behavior_available_visuals');assert.equal(plan.confirm_only,true);
 assert.deepEqual(plan.missing_frame_ids,['before','trigger']);assert.equal(plan.items.length,1);
 assert.equal(plan.items[0].source_kind,'retained_target');assert.equal(plan.items[0].sample,trigger);
});
test('a missing earlier image needs no crop when the real trigger full frame exists',async()=>{
 const plan=await selectVisualEvidence(row(),proof,{image:async sample=>{if(sample===before)throw Error('missing_context');return {key:'trigger',data}},retained:()=>assert.fail('trigger already visible')});
 assert.equal(plan.items.length,1);assert.equal(plan.items[0].source_kind,'full_frame');assert.equal(plan.confirm_only,true);
});
test('available earlier visuals cannot be discarded to outvote a contradictory image',async()=>{
 const plan=await selectVisualEvidence(row(),proof,{image:async sample=>{if(sample===trigger)throw Error('missing_context');return {key:'before',data}},retained:async()=>({data,sha256:'f'.repeat(64)})});
 assert.deepEqual(plan.items.map(x=>x.sample.frame_id),['before','trigger']);
});
test('no picture, invalid behavior, stale trigger or corrupt storage never becomes reviewable',async()=>{
 await assert.rejects(selectVisualEvidence(row(),proof,{image:missing,retained:missing}),/missing_context/);
 await assert.rejects(selectVisualEvidence(row(),{ok:false,samples:[]},{image:()=>assert.fail(),retained:()=>assert.fail()}),/incomplete_trajectory/);
 await assert.rejects(selectVisualEvidence({...row(),source_pts_ns:'3'},proof,{image:missing,retained:()=>assert.fail()}),/incomplete_trajectory/);
 for(const error of [Error('evidence_integrity_mismatch'),Object.assign(Error('slow'),{code:50})])
  await assert.rejects(selectVisualEvidence(row(),proof,{image:async()=>{throw error},retained:()=>assert.fail()}),e=>e===error);
});
const meta=()=>({state:'available',evidence:{kind:'target_crop',variants:['processed','original'],channel_id:'c',stream_session_id:'s',track_id:'t',source_pts_ns:'2',source_frame_index:'2',frame_width:1920,frame_height:1080,image_width:64,image_height:64,label_id:'person'}});
test('retained original binds current stage, label, source geometry and exact frame, not the first episode stage',async()=>{
 let chosen;const r=row();r.behavior_event_ids=['b'.repeat(64),id];
 const vault={metadata:async event=>{chosen=event;return meta()},image:async(event,variant)=>{assert.equal(event,id);assert.equal(variant,'original');return data}};
 const crop=await retainedTarget(vault,r);assert.equal(chosen,id);assert.equal(crop.data,data);assert.equal(crop.label,'人');
 for(const field of ['channel_id','stream_session_id','track_id','source_pts_ns','source_frame_index','label_id','frame_width','frame_height']){
  const m=meta();m.evidence[field]=typeof m.evidence[field]==='number'?42:'wrong';
  await assert.rejects(retainedTarget({...vault,metadata:async()=>m},r),/evidence_identity_mismatch/);
 }
 const m=meta();m.evidence.variants=['processed'];await assert.rejects(retainedTarget({...vault,metadata:async()=>m},r),/missing_context/);
 m.evidence.variants=['original'];m.evidence.image_width=16;await assert.rejects(retainedTarget({...vault,metadata:async()=>m},r),/insufficient_target_pixels/);
});
