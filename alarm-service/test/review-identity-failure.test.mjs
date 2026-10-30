import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewWorker} from '../src/review-worker.mjs';
import {reviewSamples} from '../src/review-context.mjs';
import {evaluate} from '../src/engine.mjs';
test('an identity mismatch stays an explicit permanent evidence failure, not an automatic transient retry',async()=>{
 const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'person',reject_below:.05,approve_above:.95};
 const rule={id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],labels:[{label_id:'person',name:'person'}],behavior:'region_enter',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy};
 let checkpoint=null,event;
 for(const [i,x] of [.2,.4,.5].entries()){
  const n=String(i+1),pts=String((i+1)*1000000000);
  const result=evaluate(checkpoint,{schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(Date.now()-3000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-25,y:500,w:50,h:50}}]},[rule]);
  checkpoint=result.checkpoint;event??=result.events[0];
 }
 const row={...event,alarm_id:'a',handling:{state:'unacknowledged',revision:0},review:{state:'running',context_state:'ready',generation:'g',attempt:1,policy}};
 assert.equal(reviewSamples(row).ok,true);
 const writes=[],events={findOneAndUpdate:async()=>structuredClone(row),updateOne:async(filter,update)=>{if(filter['handling.state']==='unacknowledged')writes.push(update);}};
 const worker=new ReviewWorker({events},{readiness:async()=>false,authorization:async()=>null,
  context:{prepareInputs:async()=>{throw Error('evidence_identity_mismatch')}},invoke:async()=>assert.fail('Unbound image must never reach model')});
 assert.equal(await worker.step(),true);
 assert.equal(writes[0].$set['review.reason'],'evidence_identity_mismatch');
 assert.equal(writes[0].$set['review.state'],'failed');
});
