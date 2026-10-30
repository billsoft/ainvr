import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {ReviewContext} from '../src/review-context.mjs';

const jpeg=Buffer.from('ffd8ffc00011080040004003012200021101031101ffd9','hex');
const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'核对人',reject_below:.05,approve_above:.95};
function entering(){
 const rule={id:'r',version:1,name:'test',channel_id:'c',state:'enabled',label_ids:['person'],labels:[{label_id:'person',name:'人'}],geometry_revision:'g',label_map_version:'l',behavior:'region_enter',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy};
 let checkpoint=null,event;
 for(const [i,x] of [.2,.4,.5].entries()){
  const n=String(i+1),pts=String((i+1)*1000000000);
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(Date.now()-3000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-25,y:500,w:50,h:50}}]};
  const result=evaluate(checkpoint,frame,[rule]);checkpoint=result.checkpoint;event??=result.events[0];
 }
 assert.ok(event);
 return {...event,alarm_id:'alarm',handling:{state:'unacknowledged',revision:0},review:{generation:'g',policy,state:'uncertain',context_state:'incomplete',reason:'missing_context',recovery:{attempt:1,next_at:0,reason:'recording_expired'}}};
}
function fixture(row){
 const patches=[];
 const events={findOneAndUpdate:async()=>structuredClone(row),findOne:async()=>({alarm_id:row.alarm_id}),updateOne:async(filter,update)=>{patches.push({filter,update});return {modifiedCount:1};}};
 const context=new ReviewContext({events},'/mnt/ainvr-ssd/recovery-source-no-files');
 context.images={put:async()=>{}};
 return {context,patches};
}
test('retained visuals become visual_completed without falsely claiming recording recovery or losing provenance',async()=>{
 const row=entering(),{context,patches}=fixture(row);
 const sample=row.analysis_evidence.review_context.samples.at(-1);
 const plan={mode:'verified_behavior_available_visuals',missing_frame_ids:['before'],items:[{sample,key:'a'.repeat(64),data:jpeg,source_kind:'retained_target',event_id:'b'.repeat(64),width:64,height:64}]};
 await context.ready(row,{alarm_id:row.alarm_id},plan,true);
 const patch=patches.at(-1).update;
 assert.equal(patch.$set['review.recovery.state'],'visual_completed');
 assert.equal(patch.$set['review.recovery.method'],'retained_evidence');
 assert.equal(patch.$set['review.recovery.reason'],null);
 assert.ok(Number.isFinite(Date.parse(patch.$set['review.recovery.completed_at'])));
 assert.equal(patch.$set['review.recovery.frames'],undefined);
 assert.equal(patch.$unset,undefined);
});
test('actual recorder recovery keeps completed and names the exact-SEI source',async()=>{
 const row=entering(),{context,patches}=fixture(row);
 context.prepareInputs=async()=>{throw Error('missing_context');};
 context.image=async()=>{throw Error('missing_context');};
 let calls=0;
 context.recoverEvidence=async()=>{calls++;return {data:jpeg,provenance:{kind:'recording_exact_sei_v1',segment_id:'segment'}};};
 await context.recoverOne();
 assert.ok(calls>=2);
 const patch=patches.at(-1).update;
 assert.equal(patch.$set['review.recovery.state'],'completed');
 assert.equal(patch.$set['review.recovery.method'],'recording_exact_sei_v1');
 assert.equal(patch.$set['review.recovery.reason'],null);
 assert.ok(patch.$set['review.frames'].every(frame=>frame.provenance.kind==='recording_exact_sei_v1'));
});
