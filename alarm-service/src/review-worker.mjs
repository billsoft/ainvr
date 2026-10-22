// Durable single-document jobs. Model calls never run on observation ingestion.
import {reviewSamples} from './review-context.mjs';
import {randomUUID} from 'node:crypto';
import {digest} from './domain.mjs';
export function reviewFor(event){
 const policy=event.rule?.snapshot?.review;
 const evidence=event.behavior_event_ids?.[0]??null;
 return policy?.enabled?{state:'queued',attempt:0,next_attempt_at:0,lease_until:0,
   generation:digest([event.rule.id,event.rule.version,event.frame_id,evidence]),evidence_id:evidence,
   policy:structuredClone(policy)}:
   {state:'skipped',attempt:0,reason:'policy_disabled'};
}
export function classify(score,policy){
 if(!Number.isFinite(score)||score<0||score>1)throw Error('invalid_model_result');
 return score<=policy.reject_below?'not_supported':score>=policy.approve_above?'supported':'uncertain';
}
// Same 896x448 centered letterbox as the hardware image path (ties-to-even).
export function reviewBox(b,width,height,imageWidth=width,imageHeight=height){
 const even=x=>{const n=Math.floor(x),f=x-n;return f===.5?(n%2?n+1:n):Math.round(x)};
 const scale=Math.min(896/imageWidth,448/imageHeight),w=even(imageWidth*scale),h=even(imageHeight*scale);
 const x=Math.floor((896-w)/2),y=Math.floor((448-h)/2);
 return [(x+b.x/width*w)/896,(y+b.y/height*h)/448,(x+(b.x+b.w)/width*w)/896,(y+(b.y+b.h)/height*h)/448].map(v=>Number(Math.max(0,Math.min(1,v)).toFixed(4)));
}
// Coordinates refer to the actual letterboxed model input, not the UI overlay.
// The complete immutable trace stays in evidence; this is an explicitly sampled
// context summary, never a replacement for deterministic replay.
export function reviewDescription(row,proof,sample,imageWidth,imageHeight){
 const r=row.rule.snapshot,{width,height}=row.analysis_evidence.source;
 const label=(r.labels??row.analysis_evidence.review_context.labels).find(l=>l.label_id===row.analysis_evidence.track.label_id)?.name;
 if(!label)throw Error('missing_label');
 const map=(x,y)=>reviewBox({x:x*width,y:y*height,w:0,h:0},width,height,imageWidth,imageHeight).slice(0,2);
 const real=row.analysis_evidence.review_context.trace.filter(s=>s.event_eligible&&s.observation==='detected');
 const indices=[...new Set(Array.from({length:Math.min(6,real.length)},(_,i)=>Math.round(i*(real.length-1)/Math.max(1,Math.min(6,real.length)-1))))];
 const context={schema:'ainvr.review_context.v2',behavior:r.behavior,anchor:r.anchor,
  duration_ms:r.duration_ms,approach_px:r.approach_px,
  entry_edges:r.entry_edges,exit_edges:r.exit_edges,region:r.points?.map(([x,y])=>map(x,y))??null,
  direction:proof.verification?.direction??row.direction,
  frame:{id:sample.frame_id,at:sample.captured_at,index:proof.samples.findIndex(s=>s.frame_id===sample.frame_id)+1,total:proof.samples.length,
   box:reviewBox(sample.bbox,width,height,imageWidth,imageHeight)},
  trajectory_summary:indices.map(i=>{const t=real[i],b=t.bbox;return {at:t.captured_at,point:map((b.x+b.w/2)/width,(b.y+b.h*(r.anchor==='center'?.5:1))/height)}})};
 const description=`核对当前图像框内目标是否为${label}，不可用其他目标代替。下列热区、轨迹摘要和条件来自同一目标的冻结证据，坐标为补边图像的0至1范围；当前图片只是完整过程的一帧，不要把摘要当作亲眼看到的连续视频。行为由同一正式判定引擎重放验证。证据：${JSON.stringify(context)}。补充：${row.review.policy.description}`;
 if(Buffer.byteLength(description)>8192)throw Error('review_context_too_large');
 return {label,description,context};
}
export class ReviewWorker{
 constructor(repository,{source,vault,invoke,context,clock=()=>Date.now()}){
  this.context=context;this.repository=repository;this.rows=repository.events;this.source=source;this.vault=vault;this.invoke=invoke;this.clock=clock;
  this.closing=false;this.inFlight=null;this.timer=null;this.lastError=null;
 }
 async initialize(){await this.rows.createIndex({'review.state':1,'review.next_attempt_at':1,occurred_at:1});}
 async step(){
  const now=this.clock(),token=randomUUID();
  const row=await this.rows.findOneAndUpdate({'handling.state':'unacknowledged','handling.disposition':{$ne:'false_positive'},
   'review.generation':{$exists:true},'review.context_state':'ready',$or:[{'review.state':'queued','review.next_attempt_at':{$lte:now}}, {'review.state':'running','review.lease_until':{$lte:now}}]},
   {$set:{'review.state':'running','review.token':token,'review.lease_until':now+1500000},$inc:{'review.attempt':1}},
   {sort:{occurred_at:1,alarm_id:1},returnDocument:'after'});
  if(!row)return false;
  const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'review.token':token,'review.state':'running',
   'handling.state':'unacknowledged','handling.revision':row.handling.revision};
  try{
   if(row.review.attempt>3)throw Error('retry_exhausted');
   const proof=reviewSamples(row);if(!proof.ok)throw Error('incomplete_trajectory');
   const labels=row.rule.snapshot.labels??row.analysis_evidence.review_context.labels;
   const label=labels.find(l=>l.label_id===row.analysis_evidence.track.label_id)?.name;
   if(!label)throw Error('missing_label');
   const results=[];
   for(const sample of proof.samples){
    if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
    const {data,width:imageWidth,height:imageHeight}=await this.context.image(row,sample);
    const prompt=reviewDescription(row,proof,sample,imageWidth,imageHeight);
    const result=await this.invoke({request_id:digest([row.alarm_id,row.review.generation,sample.frame_id,'evidence-v2']),image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},
      alarm:{kind:prompt.label,description:prompt.description}});
    if(result.schema!=='ainvr.alarm_review.v1'||typeof result.model?.package_sha256!=='string')throw Error('invalid_model_result');
    classify(result.real_score,row.review.policy);results.push(result);
   }
   // Multiple keyframes must agree. Mixed results cannot automatically hide an alarm.
   if(new Set(results.map(r=>r.model.package_sha256)).size!==1)throw Error('model_changed');
   const scores=results.map(r=>r.real_score),score=Math.max(...scores);
   const state=scores.every(v=>v<=row.review.policy.reject_below)?'not_supported':scores.every(v=>v>=row.review.policy.approve_above)?'supported':'uncertain';
   const result={real_score:score,model:results[0].model},at=new Date(this.clock()).toISOString();
   const review={...row.review,state,score:result.real_score,model:result.model,completed_at:at,frame_scores:scores,geometry_verified:true,verification:proof.verification,evidence_digest:digest(row.analysis_evidence.review_context),review_scope:'visual_target_with_verified_behavior',
    lease_until:0,reason:state==='uncertain'?'ambiguous_result':null};
   delete review.token;
   const handled=state==='supported'||state==='not_supported';
   const disposition=state==='supported'?'handled':'false_positive';
   const handling=handled?{...row.handling,state:'acknowledged',revision:row.handling.revision+1,reviewed_by_kind:'ai',acknowledged_by:'AI',acknowledged_at:at,disposition,note:'AI 核对关键帧目标，行为条件由共用引擎复验'}:null;
   await this.rows.updateOne(fence,{$set:{review,...(handling?{handling}:{})},$inc:{version:1},$push:{logs:{$each:[{operation_id:token,action:'ai_review',actor:'ai-review',at,
     evidence_generation:row.review.generation,model:result.model,frame_ids:proof.samples.map(s=>s.frame_id),frame_scores:scores,
     note:`${state}; score=${result.real_score}; ${handled?disposition:'unreviewed'}`}],$slice:-1024}}});
   this.lastError=null;
  }catch(error){
   const reason=['incomplete_trajectory','missing_context','missing_label','model_changed','missing_evidence','invalid_model_result','retry_exhausted','unsupported_image','review_context_too_large'].includes(error.message)?error.message:'review_unavailable';
   const exhausted=row.review.attempt>=3||['unsupported_image','review_context_too_large','incomplete_trajectory','missing_label'].includes(reason);
   await this.rows.updateOne(fence,{$set:{'review.state':exhausted?'failed':'queued','review.reason':reason,
    'review.next_attempt_at':this.clock()+Math.min(300000,30000*2**(row.review.attempt-1)),'review.lease_until':0},$unset:{'review.token':''}});
   this.lastError=reason;
  }finally{
   // A manual decision during inference wins; only annotate the abandoned job.
   await this.rows.updateOne({alarm_id:row.alarm_id,'review.token':token,'handling.state':'acknowledged'},
    {$set:{'review.state':'skipped','review.reason':'human_handled','review.lease_until':0},$unset:{'review.token':''}});
  }
  return true;
 }
 tick(){if(this.inFlight)return this.inFlight;if(this.closing)return Promise.resolve();this.inFlight=this.step().finally(()=>{this.inFlight=null});return this.inFlight;}
 run(){const work=async()=>{try{await this.tick()}catch{this.lastError='storage_unavailable'}if(!this.closing)this.timer=setTimeout(work,3000)};void work();}
 async close(){this.closing=true;clearTimeout(this.timer);await this.inFlight;}
 async status(){const counts=await this.rows.aggregate([{$match:{'review.generation':{$exists:true},'handling.state':'unacknowledged'}},{$group:{_id:'$review.state',count:{$sum:1}}}],{maxTimeMS:2000}).toArray();return {available:!!this.invoke,concurrency:1,counts:Object.fromEntries(counts.map(v=>[v._id,v.count])),last_error:this.lastError};}
}
