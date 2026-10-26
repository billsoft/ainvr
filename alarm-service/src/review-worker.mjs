import {reviewAuthorization,authorizedResult,authorizedScores} from './review-authorization.mjs';
import {qualifiedReview,validationAvailable} from './review-qualification.mjs';
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
export {reviewDescription} from './review-prompt.mjs';
import {reviewDescription,REVIEW_PROMPT_VERSION} from './review-prompt.mjs';
export class ReviewWorker{
 constructor(repository,{invoke,context,policy,qualification=qualifiedReview,readiness=qualification===qualifiedReview?validationAvailable:async()=>true,authorization=reviewAuthorization,clock=()=>Date.now()}){
  this.authorization=authorization;this.qualification=qualification;this.policy={max_attempts:3,timeout_s:120,retry_delay_s:30,...policy};this.context=context;this.repository=repository;this.rows=repository.events;this.readiness=readiness;this.invoke=invoke;this.clock=clock;
  this.closing=false;this.inFlight=null;this.timer=null;this.lastError=null;
 }
 async initialize(){await this.rows.createIndex({'review.state':1,'review.next_attempt_at':1,occurred_at:1});}
 async step(){
  const now=this.clock(),token=randomUUID();
  const validated=await this.readiness();
  const authorization=await this.authorization();
  const authorizationId=authorization?.id??null;
  const row=await this.rows.findOneAndUpdate({'handling.state':'unacknowledged','handling.disposition':{$ne:'false_positive'},
   'review.policy.enabled':true,'review.generation':{$exists:true},'review.context_state':'ready',...(!validated?{$expr:{$or:[{$ne:[{$ifNull:['$review.reference.generation',null]},'$review.generation']},{$ne:[{$ifNull:['$review.reference.prompt_version',null]},REVIEW_PROMPT_VERSION]},{$ne:[{$ifNull:['$review.reference.authorization_id',null]},authorizationId]}]}}:{}),$or:[{'review.state':'waiting_validation'},{'review.state':'queued','review.next_attempt_at':{$lte:now}}, {'review.state':'running','review.lease_until':{$lte:now}}]},
   {$set:{'review.state':'running','review.token':token,'review.lease_until':now+(this.policy.timeout_s*4+30)*1000},$inc:{'review.attempt':1}},
   {sort:{occurred_at:-1,alarm_id:-1},returnDocument:'after'});
  if(!row)return false;
  const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'review.token':token,'review.state':'running',
   'handling.state':'unacknowledged','handling.revision':row.handling.revision};
  try{
   if(row.review.attempt>this.policy.max_attempts)throw Error('retry_exhausted');
   const proof=reviewSamples(row);if(!proof.ok)throw Error('incomplete_trajectory');
   const labels=row.rule.snapshot.labels??row.analysis_evidence.review_context.labels;
   const label=labels.find(l=>l.label_id===row.analysis_evidence.track.label_id)?.name;
   if(!label)throw Error('missing_label');
   const results=[],submittedPrompts=[];let authorized=!!authorization;
   row.review.prepared_frames=[];row.review.context_frames=[];
   for(const sample of proof.samples){
    if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
    const {data}=await this.context.image(row,sample);
    const prompt=reviewDescription(row,sample);
    submittedPrompts.push({frame_id:sample.frame_id,label:prompt.label,description:prompt.description,caller_template:REVIEW_PROMPT_VERSION,scope:'target_category_only'});
    const result=await this.invoke({request_id:digest([row.alarm_id,row.review.generation,sample.frame_id,REVIEW_PROMPT_VERSION]),image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},
      preparation:{version:1,layout:'target-crop-v1',region:row.rule.snapshot.points??[],approach_width_fraction:row.rule.snapshot.behavior==='region_approach'?row.rule.snapshot.approach_px/row.analysis_evidence.source.width:0,target:[sample.bbox.x/row.analysis_evidence.source.width,sample.bbox.y/row.analysis_evidence.source.height,(sample.bbox.x+sample.bbox.w)/row.analysis_evidence.source.width,(sample.bbox.y+sample.bbox.h)/row.analysis_evidence.source.height]},
      alarm:{kind:prompt.label,description:prompt.description}},{timeoutMs:this.policy.timeout_s*1000});
    if(result.prepared_image&&this.context.savePrepared){const prepared=await this.context.savePrepared(row,sample,result.prepared_image);row.review.prepared_frames=[...(row.review.prepared_frames??[]),prepared];}
    if(result.context_image&&this.context.savePrepared){const context=await this.context.savePrepared(row,sample,result.context_image);row.review.context_frames=[...(row.review.context_frames??[]),context];}
    authorized=authorized&&authorizedResult(authorization,{...result,caller_template:REVIEW_PROMPT_VERSION,target_label:prompt.label});
    if(validated&&!await this.qualification({...result,caller_template:REVIEW_PROMPT_VERSION,target_label:prompt.label},row.review.policy))throw Error('unvalidated_profile');
    if(result.schema!=='ainvr.alarm_review.v1'||typeof result.model?.package_sha256!=='string')throw Error('invalid_model_result');
    classify(result.real_score,row.review.policy);results.push(result);
   }
   // Multiple keyframes must agree. Mixed results cannot automatically hide an alarm.
   if(new Set(results.map(r=>r.model.package_sha256)).size!==1)throw Error('model_changed');
   const scores=results.map(r=>r.real_score),score=Math.max(...scores);
   const state=scores.every(v=>v<=row.review.policy.reject_below)?'not_supported':scores.every(v=>v>=row.review.policy.approve_above)?'supported':'uncertain';
   const result={real_score:score,model:results[0].model},at=new Date(this.clock()).toISOString();
   const review={...row.review,state,score:result.real_score,model:result.model,completed_at:at,frame_scores:scores,submitted_prompts:submittedPrompts,caller_template:REVIEW_PROMPT_VERSION,geometry_verified:true,verification:proof.verification,evidence_digest:digest(row.analysis_evidence.review_context),review_scope:'visual_target_with_verified_behavior',
    lease_until:0,reason:state==='uncertain'?'ambiguous_result':null};
   delete review.token;
   // Re-read authorization after inference: disabling/replacing the policy wins.
   const stillAuthorized=authorized&&(await this.authorization())?.id===authorizationId;
   const operatorConfirmed=stillAuthorized&&authorizedScores(authorization,scores,row.review.policy);
   const handled=(validated&&(state==='supported'||state==='not_supported'))||operatorConfirmed;
   review.decision_basis=handled?(validated?'validated_model':'operator_authorized_confirm_only'):'reference_only';
   if(operatorConfirmed&&!validated)review.authorization={id:authorizationId,mode:'confirm_only',authorized_by:authorization.authorized_by,authorized_at:authorization.authorized_at,threshold:Math.max(authorization.approve_above,row.review.policy.approve_above),minimum_frame_score:Math.max(authorization.minimum_frame_score??authorization.approve_above,row.review.policy.approve_above),accuracy_validated:false};
   if(handled)delete review.reference;
   if(!validated&&!handled){
    review.state='waiting_validation';review.reason=stillAuthorized?'manual_review_required':'unvalidated_profile';review.attempt=0;
    review.reference={state:'completed',generation:row.review.generation,score,frame_scores:scores,model:result.model,completed_at:at,scope:'target_category_only',automatic_decision:false,reason:review.reason,authorization_id:authorizationId,prompt_version:REVIEW_PROMPT_VERSION,layout:'target-crop-v1'};
   }
   const disposition=state==='supported'?'handled':'false_positive';
   const handling=handled?{...row.handling,state:'acknowledged',revision:row.handling.revision+1,reviewed_by_kind:'ai',acknowledged_by:'AI',acknowledged_at:at,disposition,note:validated?'AI 核对关键帧目标，行为条件由共用引擎判定':'按用户授权策略自动确认：各关键帧目标类别一致，行为由规则引擎判定；准确率尚未全面验证，可人工改判'}:null;
   await this.rows.updateOne(fence,{$set:{review,...(handling?{handling}:{})},$inc:{version:1},$push:{logs:{$each:[{operation_id:token,action:handled?'ai_review':'ai_reference',actor:'ai-review',at,
     decision_basis:review.decision_basis,authorization_id:operatorConfirmed?authorizationId:null,evidence_generation:row.review.generation,model:result.model,frame_ids:proof.samples.map(s=>s.frame_id),frame_scores:scores,
     note:`${state}; score=${result.real_score}; ${handled?disposition:'unreviewed'}`}],$slice:-1024}}});
   this.lastError=null;
  }catch(error){
   const reason=['evidence_integrity_mismatch','incomplete_trajectory','missing_context','missing_label','model_changed','missing_evidence','invalid_model_result','retry_exhausted','input_too_long','invalid_request','insufficient_target_pixels','unvalidated_profile','unsupported_image','review_context_too_large'].includes(error.message)?error.message:'review_unavailable';
   const exhausted=row.review.attempt>=this.policy.max_attempts||['evidence_integrity_mismatch','input_too_long','invalid_request','insufficient_target_pixels','unvalidated_profile','unsupported_image','review_context_too_large','incomplete_trajectory','missing_label'].includes(reason);
   await this.rows.updateOne(fence,{$set:{'review.state':exhausted?'failed':'queued','review.reason':reason,
    'review.next_attempt_at':this.clock()+Math.min(300000,this.policy.retry_delay_s*1000*2**(row.review.attempt-1)),'review.lease_until':0},$unset:{'review.token':''}});
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
 async status(){const counts=await this.rows.aggregate([{$match:{'review.generation':{$exists:true},'handling.state':'unacknowledged'}},{$group:{_id:'$review.state',count:{$sum:1}}}],{maxTimeMS:2000}).toArray();return {available:!!this.invoke,concurrency:1,counts:Object.fromEntries(counts.map(v=>[v._id,v.count])),last_error:this.lastError,evidence:await this.context?.status?.()};}
}
