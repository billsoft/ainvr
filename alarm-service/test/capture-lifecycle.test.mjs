import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {evidenceCaptureIntents} from '../src/ingestion.mjs';
import {ReviewContext,reviewSamples} from '../src/review-context.mjs';
function scenario(behavior){
 const rule={id:'r',version:1,name:'test',channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior,anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],...(behavior==='region_approach'?{approach_px:200}:{}),duration_ms:0,review:{enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'person',reject_below:.05,approve_above:.95}};
 let checkpoint=null;const outcomes=[];
 for(const [i,x] of [.1,.25,.4,.5,.6,.8].entries()){
  const n=String(i+1),pts=String((i+1)*1000000000);
  const frame={schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(1760918400000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-5,y:535,w:10,h:10}}]};
  const result=evaluate(checkpoint,frame,[rule]);checkpoint=result.checkpoint;outcomes.push(result);
 }
 return outcomes;
}
for(const behavior of ['appearance','region_approach','region_enter','region_traverse'])test(`${behavior}: all sealed evidence frames enter durable capture queue`,()=>{
 const outcomes=scenario(behavior);const emitted=outcomes.filter(x=>x.events.length);assert.ok(emitted.length);
 for(const result of emitted){
  const captures=evidenceCaptureIntents(result);
  for(const event of result.events){const proof=reviewSamples(event);assert.equal(proof.ok,true);for(const sample of proof.samples)assert.ok(captures.some(c=>c.sample.frame_id===sample.frame_id));}
  assert.equal(new Set(captures.map(c=>c.sample.frame_id)).size,captures.length);
 }
});
test('old video timestamps do not prematurely fail new capture; delayed image recovers',async()=>{
 const event=scenario('region_enter').flatMap(x=>x.events)[0];event.review={state:'queued',generation:1};
 const order=[];let available=false;
 const repo={events:{find:()=>({sort:()=>({limit:()=>({toArray:async()=>[event]})})}),updateOne:async(f,u)=>{for(const [k,v] of Object.entries(u.$set))event.review[k.slice(7)]=v;}}};
 const context=new ReviewContext(repo,'/mnt/ainvr-ssd/unit-test-no-writes');
 context.publish=async()=>{};context.processCaptureJobs=async()=>order.push('capture');context.maintain=async()=>order.push('maintenance');
 context.image=async()=>{order.push('image');if(!available)throw Error('pending');return {key:'exact',data:Buffer.from('test')};};
 await context.step();assert.equal(event.review.state,'queued');assert.ok(event.review.context_started_at>Date.parse(event.last_seen_at));assert.equal(order[0],'capture');assert.equal(order.at(-1),'maintenance');
 available=true;await context.step();assert.equal(event.review.context_state,'ready');assert.equal(event.review.frames.length,reviewSamples(event).samples.length);
});
test('capture retries within bounded wall-clock window and expires with diagnostics',async()=>{
 const job={_id:'a',channel_id:'c',stream_session_id:'s',source:{width:100,height:100},sample:{frame_id:'f',source_pts_ns:'1',source_frame_index:'1'},created_at:Date.now()-15000};const updates=[];
 const repo={captureJobs:{find:()=>({sort:()=>({limit:()=>({toArray:async()=>[job]})})}),updateOne:async(f,u)=>updates.push(u.$set)}};
 const context=new ReviewContext(repo,'/mnt/ainvr-ssd/unit-test-no-writes');context.image=async()=>{throw Error('pending')};
 await context.processCaptureJobs();assert.equal(updates.at(-1).state,'queued');
 job.created_at=Date.now()-31000;await context.processCaptureJobs();assert.equal(updates.at(-1).state,'missing');assert.equal(updates.at(-1).last_error,'exact_frame_unavailable');
});
