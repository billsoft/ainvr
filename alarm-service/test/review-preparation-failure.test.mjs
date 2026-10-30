import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../src/engine.mjs';
import {ReviewContext,reviewSamples} from '../src/review-context.mjs';
const jpeg=Buffer.from('ffd8ffc00011080040004003012200021101031101ffd9','hex');
function alarm(id='a'){
 const policy={enabled:true,version:1,profile_id:'alarm-review-zh-v1',description:'person',reject_below:.05,approve_above:.95};
 const rule={id:'r',version:1,name:'r',channel_id:'c',state:'enabled',geometry_revision:'g',label_map_version:'l',label_ids:['person'],labels:[{label_id:'person',name:'person'}],behavior:'region_enter',anchor:'center',points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],review:policy};
 let checkpoint=null,event;
 for(const [i,x] of [.2,.4,.5].entries()){
  const n=String(i+1),pts=String((i+1)*1000000000);
  const result=evaluate(checkpoint,{schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:'s',seq:n,frame_id:n,source_frame_index:n,source_pts_ns:pts,captured_at:new Date(Date.now()-3000+i*1000).toISOString(),source:{width:1920,height:1080,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*1920-25,y:500,w:50,h:50}}]},[rule]);
  checkpoint=result.checkpoint;event??=result.events[0];
 }
 const row={...event,alarm_id:id,version:1,handling:{state:'unacknowledged',revision:0},review:{generation:'g',state:'queued',attempt:0,policy}};
 assert.equal(reviewSamples(row).ok,true);return row;
}
const get=(row,path)=>path.split('.').reduce((value,key)=>value?.[key],row);
function match(row,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$or')return value.some(branch=>match(row,branch));
 const actual=get(row,key);
 if(value&&typeof value==='object'){
  if('$exists' in value)return (actual!==undefined)===value.$exists;
  if('$lte' in value)return actual<=value.$lte;
 }
 return actual===value;
});}
function fixture(rows=[alarm()]){
 let now=Date.now();const docs=new Map(rows.map(row=>[row.alarm_id,row]));
 const events={find(filter){let limit=Infinity;return {sort(){return this},limit(n){limit=n;return this},async toArray(){return structuredClone([...docs.values()].filter(row=>match(row,filter)).slice(0,limit));}};},
  async updateOne(filter,patch){const row=docs.get(filter.alarm_id);if(!row||!match(row,filter))return {modifiedCount:0};
   for(const [path,value] of Object.entries(patch.$set??{})){const keys=path.split('.'),last=keys.pop();let object=row;for(const key of keys)object=object[key]??={};object[last]=structuredClone(value);}
   for(const [path,value] of Object.entries(patch.$inc??{})){const keys=path.split('.'),last=keys.pop();let object=row;for(const key of keys)object=object[key]??={};object[last]=(object[last]??0)+value;}
   return {modifiedCount:1};}};
 const context=new ReviewContext({events},'/mnt/ainvr-ssd/preparation-test-no-files',{clock:()=>now});
 context.publish=async()=>{};context.processCaptureJobs=async()=>{};context.maintain=async()=>{};
 return {context,docs,advance:ms=>{now+=ms},due:row=>{now=row.review.context_next_at+1}};
}
function plan(row){return {mode:'all_keyframes',missing_frame_ids:[],items:reviewSamples(row).samples.map(sample=>({sample,key:'f'.repeat(64),data:jpeg,source_kind:'full_frame'}))};}
test('known behavior and label preparation faults become explicit manual-review reasons',async()=>{
 for(const reason of ['incomplete_trajectory','missing_label']){
  const row=alarm(),{context}=fixture([row]);context.prepareInputs=async()=>{throw Error(reason)};
  await context.step();assert.equal(row.review.state,'uncertain');assert.equal(row.review.context_state,'incomplete');assert.equal(row.review.reason,reason);
 }
});
test('unknown preparation faults retry with a due time and stop after three attempts without model calls',async()=>{
 const row=alarm(),f=fixture([row]);let calls=0;f.context.prepareInputs=async()=>{calls++;throw Error('private path/token must not be exposed')};
 await f.context.step();assert.equal(row.review.reason,'evidence_preparation_retry');assert.equal(row.review.context_failures,1);assert.ok(row.review.context_next_at>Date.now());
 await f.context.step();assert.equal(calls,1,'not eligible before its backoff');
 f.due(row);await f.context.step();assert.equal(row.review.context_failures,2);
 f.due(row);await f.context.step();assert.equal(row.review.context_failures,3);assert.equal(row.review.state,'failed');assert.equal(row.review.context_state,'incomplete');assert.equal(row.review.reason,'evidence_preparation_failed');assert.equal(row.review.attempt,0);
 assert.equal(JSON.stringify(row).includes('private path/token'),false);
});
test('100 failing old preparations cannot permanently occupy the batch ahead of a healthy alarm',async()=>{
 const bad=Array.from({length:100},(_,i)=>alarm('bad-'+i)),healthy=alarm('healthy'),f=fixture([...bad,healthy]);
 f.context.prepareInputs=async row=>{if(row.alarm_id!=='healthy')throw Error('unexpected');return plan(row)};
 await f.context.step();assert.equal(healthy.review.context_state,undefined);
 await f.context.step();assert.equal(healthy.review.context_state,'ready');assert.equal(healthy.review.reason,null);
});
test('storage faults remain retryable and visible, and do not become missing pixels or spend generic/model attempts',async()=>{
 const row=alarm(),f=fixture([row]);let busy=true;
 f.context.prepareInputs=async r=>{if(busy)throw Object.assign(Error('busy'),{code:50});return plan(r)};
 await f.context.step();assert.equal(row.review.state,'queued');assert.equal(row.review.context_state,undefined);assert.equal(row.review.reason,'storage_busy');assert.equal(row.review.context_storage_retries,1);assert.equal(row.review.context_failures,undefined);assert.equal(row.review.attempt,0);
 busy=false;f.due(row);await f.context.step();assert.equal(row.review.context_state,'ready');assert.equal(row.review.reason,null);
});
test('a human decision during failed preparation wins over the diagnostic write',async()=>{
 const row=alarm(),f=fixture([row]);f.context.prepareInputs=async()=>{row.handling={state:'acknowledged',revision:1,reviewed_by_kind:'human'};throw Error('unexpected')};
 await f.context.step();assert.equal(row.handling.reviewed_by_kind,'human');assert.equal(row.review.reason,undefined);
});
