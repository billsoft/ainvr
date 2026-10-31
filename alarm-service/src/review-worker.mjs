import {SECONDARY_REVIEW_VERSION,secondaryPrompt,secondaryAssessment,expandedTarget,nonTargetPrompt} from './review-secondary.mjs';
import {reviewAuthorization,authorizedResult,confirmationAssessment} from './review-authorization.mjs';
import {qualifiedReview,validationAvailable} from './review-qualification.mjs';
// Durable single-document jobs. Model calls never run on observation ingestion.
import {reviewSamples} from './review-context.mjs';
import {randomUUID} from 'node:crypto';
import {digest} from './domain.mjs';
import {requeueFailedReviews} from './review-requeue.mjs';
import {isStorageBusy} from './review-storage.mjs';
import {ReviewCheckpoint} from './review-checkpoint.mjs';
export {isStorageBusy} from './review-storage.mjs';
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
// Database trouble (time limit, network, no server, full image pool) says nothing about the model result:
// retry later without spending one of the model attempts, up to a bounded number of storage retries.
export const MAX_STORAGE_RETRIES=20;
import {reviewDescription,REVIEW_PROMPT_VERSION} from './review-prompt.mjs';
export class ReviewWorker{
 constructor(repository,{invoke,context,policy,qualification=qualifiedReview,readiness=qualification===qualifiedReview?validationAvailable:async()=>true,authorization=reviewAuthorization,clock=()=>Date.now()}){
  this.authorization=authorization;this.qualification=qualification;this.policy={max_attempts:3,timeout_s:120,retry_delay_s:30,...policy};this.context=context;this.repository=repository;this.rows=repository.events;this.readiness=readiness;this.invoke=invoke;this.clock=clock;
  this.closing=false;this.inFlight=null;this.timer=null;this.lastError=null;
  // Transient failures (model busy, restarts, storage) are retried automatically, bounded per alarm.
  this.autoRequeue={interval_ms:10*60_000,max:5,cooldown_ms:5*60_000,batch:50,...(policy?.auto_requeue??{})};this.lastSweep=this.clock();this.autoRequeued=0;
 }
 async initialize(){await this.rows.createIndex({'review.state':1,'review.next_attempt_at':1,occurred_at:1});}
 async step(){
  const now=this.clock(),token=randomUUID();
  const validated=await this.readiness();
  const authorization=await this.authorization();
  const authorizationId=authorization?.id??null;
  const row=await this.rows.findOneAndUpdate({'handling.state':'unacknowledged','handling.disposition':{$ne:'false_positive'},
   'review.policy.enabled':true,'review.generation':{$exists:true},'review.context_state':'ready',...(!validated?{$expr:{$or:[{$ne:[{$ifNull:['$review.reference.generation',null]},'$review.generation']},{$ne:[{$ifNull:['$review.reference.prompt_version',null]},REVIEW_PROMPT_VERSION]},{$ne:[{$ifNull:['$review.reference.authorization_id',null]},authorizationId]}]}}:{}),$or:[{'review.state':'waiting_validation'},{'review.state':'queued','review.next_attempt_at':{$lte:now}}, {'review.state':'running','review.lease_until':{$lte:now}}]},
   {$set:{'review.state':'running','review.token':token,'review.lease_until':now+(this.policy.timeout_s*12+30)*1000},$inc:{'review.attempt':1}},
   {sort:{occurred_at:-1,alarm_id:-1},returnDocument:'after'});
  if(!row)return false;
  const fence={alarm_id:row.alarm_id,'review.generation':row.review.generation,'review.token':token,'review.state':'running',
   'handling.state':'unacknowledged','handling.revision':row.handling.revision,
   'review.frames':row.review.frames===undefined?{$exists:false}:row.review.frames,
   'review.evidence_id':row.review.evidence_id===undefined?{$exists:false}:row.review.evidence_id,
   'review.policy':row.review.policy,rule:row.rule,analysis_evidence:row.analysis_evidence};
  try{
   if(row.review.attempt>this.policy.max_attempts)throw Error('retry_exhausted');
   const proof=reviewSamples(row);if(!proof.ok||!proof.samples.length||proof.samples.length>4)throw Error('incomplete_trajectory');
   const plan=this.context.prepareInputs?await this.context.prepareInputs(row,proof):null;
   const limited=plan?.confirm_only===true;
   const labels=row.rule.snapshot.labels??row.analysis_evidence.review_context.labels;
   const label=labels.find(l=>l.label_id===row.analysis_evidence.track.label_id)?.name;
   if(!label)throw Error('missing_label');
   const results=[],submittedPrompts=[];let authorized=!!authorization;
   row.review.prepared_frames=[];row.review.context_frames=[];row.review.secondary_frames=[];delete row.review.secondary;
   const inputs=plan?.items??proof.samples.map(sample=>({sample,source_kind:'full_frame'}));
   const checkpoints=new ReviewCheckpoint({rows:this.rows,row,fence,authorization,
    currentAuthorization:this.authorization,invoke:body=>this.invoke(body,{timeoutMs:this.policy.timeout_s*1000}),
    binding:{alarm_id:row.alarm_id,generation:row.review.generation,handling_revision:row.handling.revision,
     rule:row.rule,policy:row.review.policy,evidence:row.analysis_evidence,model_snapshot:row.model_snapshot,
     context_frames:row.review.frames,evidence_id:row.review.evidence_id,proof,limited,
     mode:plan?.mode??'all_keyframes',missing_frame_ids:plan?.missing_frame_ids??[],
     inputs:inputs.map(i=>({sample:i.sample,source_kind:i.source_kind})),
     primary_prompt:REVIEW_PROMPT_VERSION,secondary_prompt:SECONDARY_REVIEW_VERSION}});
   await checkpoints.initialize();
   for(const input of inputs){
    const sample=input.sample;
    if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
    const {data}=input.data?input:await this.context.image(row,sample);
    const prompt=reviewDescription(row,sample);
    const crop=input.source_kind==='retained_target';
    submittedPrompts.push({frame_id:sample.frame_id,label:prompt.label,description:prompt.description,caller_template:REVIEW_PROMPT_VERSION,scope:'target_category_only',source_kind:input.source_kind,input_sha256:digest(data.toString('base64'))});
    const result=await checkpoints.run('primary',sample.frame_id,{image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},
      preparation:{version:1,layout:'target-crop-v1',region:crop?[]:row.rule.snapshot.points??[],approach_width_fraction:!crop&&row.rule.snapshot.behavior==='region_approach'?row.rule.snapshot.approach_px/row.analysis_evidence.source.width:0,target:crop?[0,0,1,1]:[sample.bbox.x/row.analysis_evidence.source.width,sample.bbox.y/row.analysis_evidence.source.height,(sample.bbox.x+sample.bbox.w)/row.analysis_evidence.source.width,(sample.bbox.y+sample.bbox.h)/row.analysis_evidence.source.height]},
      alarm:{kind:prompt.label,description:prompt.description}},async result=>{
      if(result?.schema!=='ainvr.alarm_review.v1'||!/^[a-f0-9]{64}$/.test(result?.model?.package_sha256??''))throw Error('invalid_model_result');
      classify(result.real_score,row.review.policy);
      if(validated&&!await this.qualification({...result,caller_template:REVIEW_PROMPT_VERSION,target_label:prompt.label},row.review.policy))throw Error('unvalidated_profile');
    });
    if(result.prepared_image&&this.context.savePrepared){const prepared=await this.context.savePrepared(row,sample,result.prepared_image);row.review.prepared_frames=[...(row.review.prepared_frames??[]),prepared];}
    if(result.context_image&&this.context.savePrepared){const context=await this.context.savePrepared(row,sample,result.context_image);row.review.context_frames=[...(row.review.context_frames??[]),context];}
    authorized=authorized&&authorizedResult(authorization,{...result,caller_template:REVIEW_PROMPT_VERSION,target_label:prompt.label});
    results.push(result);
   }
   // Multiple keyframes must agree. Mixed results cannot automatically hide an alarm.
   if(new Set(results.map(r=>r.model.package_sha256)).size!==1)throw Error('model_changed');
   const scores=results.map(r=>r.real_score),score=Math.max(...scores);
   let state=!limited&&scores.every(v=>v<=row.review.policy.reject_below)?'not_supported':scores.every(v=>v>=row.review.policy.approve_above)?'supported':'uncertain';
   const result={real_score:score,model:results[0].model};let at=new Date(this.clock()).toISOString();
   const validatedDecision=validated&&(state==='supported'||state==='not_supported');
   const review={...row.review,state,score:result.real_score,model:result.model,completed_at:at,frame_scores:scores,submitted_prompts:submittedPrompts,caller_template:REVIEW_PROMPT_VERSION,geometry_verified:true,verification:proof.verification,evidence_digest:digest(row.analysis_evidence.review_context),review_scope:'visual_target_with_verified_behavior',
    lease_until:0,reason:state==='uncertain'?'ambiguous_result':null};
   delete review.token;
   review.evidence_mode=plan?.mode??'all_keyframes';review.missing_frame_ids=plan?.missing_frame_ids??[];
   review.required_frame_ids=proof.samples.map(s=>s.frame_id);review.reviewed_frame_ids=inputs.map(i=>i.sample.frame_id);
   // Re-read authorization after inference: disabling/replacing the policy wins.
   let stillAuthorized=authorized&&(await this.authorization())?.id===authorizationId;
   review.auto_confirmation=confirmationAssessment(stillAuthorized?authorization:null,scores,row.review.policy);
   let operatorConfirmed=review.auto_confirmation.outcome==='confirmed',operatorRejected=false;
   // One bounded, different visual input per required frame. Never reroll the
   // same image or let another person elsewhere in the full scene vote for it.
   if(!operatorConfirmed&&stillAuthorized&&authorization.mode==='confirm_or_reject'){
    const complete=!limited&&inputs.length===proof.samples.length&&inputs.every((input,i)=>input.source_kind==='full_frame'&&input.sample.frame_id===proof.samples[i].frame_id);
    const promising=scores.every(v=>v>Math.max(.5,row.review.policy.reject_below))&&scores.some(v=>v>=Math.max(.99,row.review.policy.approve_above,authorization.approve_above));
    const negative=scores.every(v=>v<=Math.min(.05,row.review.policy.reject_below));
    review.secondary={version:SECONDARY_REVIEW_VERSION,state:'unavailable',outcome:'uncertain',reason:complete?'conflicting_or_weak_primary':'incomplete_frames',frame_scores:[],frames:[],prompt:secondaryPrompt(label),confirm_above:Math.max(authorization.secondary.confirm_above,row.review.policy.approve_above,authorization.approve_above),reject_below:Math.min(authorization.secondary.reject_below,row.review.policy.reject_below),completed_at:at};
    if(complete&&(promising||negative)){
     const secondaryImages=[];
     for(const input of inputs){
      if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
      if((await this.authorization())?.id!==authorizationId){stillAuthorized=false;break;}
      const {data}=input.data?input:await this.context.image(row,input.sample);
      const target=expandedTarget(input.sample,row.analysis_evidence.source);
      const second=await checkpoints.run('expanded',input.sample.frame_id,{image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},preparation:{version:1,layout:'target-crop-v1',region:[],target},alarm:{kind:label,description:review.secondary.prompt}},async second=>{
       if(second?.schema!=='ainvr.alarm_review.v1'||second.model?.package_sha256!==result.model.package_sha256||!authorizedResult(authorization,{...second,caller_template:REVIEW_PROMPT_VERSION,target_label:label})||second.prepared_image?.target?.length!==4||second.prepared_image.target.some((v,i)=>!Number.isFinite(v)||Math.abs(v-target[i])>1e-6))throw Error('invalid_model_result');
       classify(second.real_score,row.review.policy);
      });
      if(!this.context.savePrepared)throw Error('missing_context');
      const prepared=await this.context.savePrepared(row,input.sample,second.prepared_image,{secondary:true});
      review.secondary_frames.push(prepared);
      review.secondary.frame_scores.push(second.real_score);
      review.secondary.frames.push({frame_id:input.sample.frame_id,key:prepared.key,score:second.real_score,preparation_target:target,input_sha256:digest(data.toString('base64'))});
      review.secondary.model=second.model;
      secondaryImages.push({frame_id:input.sample.frame_id,jpeg_base64:second.prepared_image.jpeg_base64});
     }
     // A low person score can mean darkness or missing detail. Dismiss only
     // after a separate explicit, high-confidence non-person evidence check.
     if(stillAuthorized&&negative&&review.secondary.frame_scores.length===inputs.length&&review.secondary.frame_scores.every(v=>v<=Math.min(.01,authorization.secondary.reject_below,row.review.policy.reject_below))){
      review.secondary.non_target_evidence={frame_scores:[],frame_ids:[],prompt:nonTargetPrompt(label)};
      for(const image of secondaryImages){
       if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
       if((await this.authorization())?.id!==authorizationId){stillAuthorized=false;break;}
       const check=await checkpoints.run('non_target',image.frame_id,{image:{jpeg_base64:image.jpeg_base64,fit:'strict'},alarm:{kind:'明确非人员目标',description:review.secondary.non_target_evidence.prompt}},async check=>{
        if(check?.schema!=='ainvr.alarm_review.v1'||check.model?.package_sha256!==result.model.package_sha256||check.template!==authorization.prompt_template)throw Error('invalid_model_result');
        classify(check.real_score,row.review.policy);
       });
       review.secondary.non_target_evidence.frame_scores.push(check.real_score);review.secondary.non_target_evidence.frame_ids.push(image.frame_id);review.secondary.non_target_evidence.model=check.model;
      }
     }
     if(stillAuthorized){
      Object.assign(review.secondary,secondaryAssessment({primaryScores:scores,contextScores:review.secondary.frame_scores,negativeEvidenceScores:review.secondary.non_target_evidence?.frame_scores,rule:{...row.review.policy,approve_above:Math.max(row.review.policy.approve_above,authorization.approve_above)},policy:authorization.secondary,complete}),{state:'completed',completed_at:new Date(this.clock()).toISOString()});
      operatorConfirmed=review.secondary.outcome==='confirmed';operatorRejected=review.secondary.outcome==='false_positive';
     }else review.secondary.reason='authorization_changed';
    }
   }
   // Authorization can be revoked while either pass runs. The human/generation
   // fence is checked again atomically by the final database update.
   stillAuthorized=stillAuthorized&&(await this.authorization())?.id===authorizationId;
   operatorConfirmed=operatorConfirmed&&stillAuthorized;operatorRejected=operatorRejected&&stillAuthorized;
   if(!stillAuthorized&&review.secondary){review.secondary.outcome='uncertain';review.secondary.reason='authorization_changed';}
   at=new Date(this.clock()).toISOString();review.completed_at=at;
   if(operatorConfirmed)state='supported';if(operatorRejected)state='not_supported';
   review.state=state;review.reason=state==='uncertain'?'ambiguous_result':null;
   const handled=validatedDecision||operatorConfirmed||operatorRejected;
   review.decision_basis=handled?(validatedDecision?'validated_model':review.secondary?.state==='completed'?'operator_authorized_dual_review':'operator_authorized_confirm_only'):'reference_only';
   review.decision_path=handled?(validatedDecision?(state==='supported'?'primary_confirmation':null):operatorRejected?'explicit_non_target':review.auto_confirmation.outcome==='confirmed'?'primary_confirmation':'expanded_confirmation'):null;
   // Durable results are only for incomplete attempts, not permanent alarm blobs.
   delete review.checkpoint;
   if((operatorConfirmed||operatorRejected)&&!validatedDecision)review.authorization={id:authorizationId,mode:authorization.mode,authorized_by:authorization.authorized_by,authorized_at:authorization.authorized_at,threshold:Math.max(authorization.approve_above,row.review.policy.approve_above),minimum_frame_score:Math.max(authorization.minimum_frame_score??authorization.approve_above,row.review.policy.approve_above),...(authorization.secondary?{secondary:authorization.secondary}:{}),accuracy_validated:false};
   if(handled)delete review.reference;
   if(!validated&&!handled){
    review.state='waiting_validation';review.reason=stillAuthorized?'manual_review_required':'unvalidated_profile';review.attempt=0;
    review.reference={state:'completed',generation:row.review.generation,score,frame_scores:scores,model:result.model,completed_at:at,scope:'target_category_only',automatic_decision:false,reason:review.reason,authorization_id:authorizationId,prompt_version:REVIEW_PROMPT_VERSION,layout:'target-crop-v1'};
   }
   const disposition=state==='supported'?'handled':'false_positive';
   const handling=handled?{...row.handling,state:'acknowledged',revision:row.handling.revision+1,reviewed_by_kind:'ai',acknowledged_by:'AI',acknowledged_at:at,disposition,note:review.secondary?.state==='completed'&&handled?`AI 特写与扩大范围复核${operatorRejected?'均否定目标类别，判为误报':'通过，确认告警'}；行为条件由规则引擎核验，模型准确率尚未全面验证，可人工改判`:limited?'行为证明完整；AI 核对可用的同目标真实图像（含触发帧）。部分全景关键帧缺失，仅允许确认，不允许自动判误报，可人工改判':validated?'AI 核对关键帧目标，行为条件由共用引擎判定':'按用户授权策略自动确认：各关键帧目标类别一致，行为由规则引擎判定；准确率尚未全面验证，可人工改判'}:null;
   await this.rows.updateOne(fence,{$set:{review,...(handling?{handling}:{})},$inc:{version:1},$push:{logs:{$each:[{operation_id:token,action:handled?'ai_review':'ai_reference',actor:'ai-review',at,
     decision_basis:review.decision_basis,decision_path:review.decision_path,authorization_id:(operatorConfirmed||operatorRejected)?authorizationId:null,evidence_generation:row.review.generation,model:result.model,frame_ids:inputs.map(i=>i.sample.frame_id),frame_scores:scores,evidence_mode:review.evidence_mode,missing_frame_ids:review.missing_frame_ids,secondary:review.secondary?{version:review.secondary.version,outcome:review.secondary.outcome,frame_scores:review.secondary.frame_scores,frame_ids:review.secondary.frames.map(f=>f.frame_id),non_target_evidence_scores:review.secondary.non_target_evidence?.frame_scores}:null,
     note:`${state}; score=${result.real_score}; ${handled?disposition:'unreviewed'}`}],$slice:-1024}}});
   this.lastError=null;
  }catch(error){
   if(error?.message==='review_fence_changed')return true;
   if(error?.message==='authorization_changed'){
    await this.rows.updateOne(fence,{$set:{'review.state':row.review.attempt>=this.policy.max_attempts?'failed':'queued',
     'review.reason':'authorization_changed','review.next_attempt_at':this.clock()+this.policy.retry_delay_s*1000,'review.lease_until':0},
     $unset:{'review.token':'','review.checkpoint':''}});
    this.lastError='authorization_changed';return true;
   }
   if(error?.message==='model_changed'){
    await this.rows.updateOne(fence,{$unset:{'review.checkpoint':''}});
   }
   if(error?.message==='missing_context'||error?.code==='ENOENT'){
    await this.rows.updateOne(fence,{$set:{'review.state':'uncertain','review.reason':'missing_context','review.context_state':'incomplete','review.lease_until':0},$unset:{'review.token':''}});
    this.lastError='missing_context';return true;
   }
   if(isStorageBusy(error)){
    const retries=(row.review.storage_retries??0)+1,exhausted=retries>=MAX_STORAGE_RETRIES;
    await this.rows.updateOne(fence,{$set:{'review.state':exhausted?'failed':'queued','review.reason':exhausted?'storage_unavailable':'storage_busy',
     'review.next_attempt_at':this.clock()+Math.min(300000,this.policy.retry_delay_s*1000*2**Math.min(retries-1,4)),'review.lease_until':0,'review.storage_retries':retries},
     $inc:{'review.attempt':-1},$unset:{'review.token':''}});
    this.lastError='storage_busy';
    return true;
   }
   const failure=['invalid_secondary_target','unsupported_secondary_label'].includes(error.message)?'invalid_request':error.message;
   const reason=['evidence_identity_mismatch','evidence_integrity_mismatch','incomplete_trajectory','missing_context','missing_label','model_changed','missing_evidence','invalid_model_result','retry_exhausted','input_too_long','invalid_request','insufficient_target_pixels','unvalidated_profile','unsupported_image','review_context_too_large'].includes(failure)?failure:'review_unavailable';
   const exhausted=row.review.attempt>=this.policy.max_attempts||['evidence_identity_mismatch','evidence_integrity_mismatch','input_too_long','invalid_request','insufficient_target_pixels','unvalidated_profile','unsupported_image','review_context_too_large','incomplete_trajectory','missing_label'].includes(reason);
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
 async sweepIfDue(){
  const now=this.clock();
  if(now-this.lastSweep<this.autoRequeue.interval_ms)return 0;
  this.lastSweep=now;
  const {requeued}=await requeueFailedReviews(this.rows,{now,limit:this.autoRequeue.batch,auto:{max:this.autoRequeue.max,cooldownMs:this.autoRequeue.cooldown_ms}});
  this.autoRequeued+=requeued;return requeued;
 }
 tick(){if(this.inFlight)return this.inFlight;if(this.closing)return Promise.resolve();this.inFlight=this.step().finally(()=>{this.inFlight=null});return this.inFlight;}
 run(){const work=async()=>{let busy=false;try{busy=!!await this.tick();if(!this.closing)await this.sweepIfDue()}catch{this.lastError='storage_unavailable'}if(!this.closing)this.timer=setTimeout(()=>{this.runFlight=work()},busy?0:3000)};this.runFlight=work();}
 async close(){this.closing=true;clearTimeout(this.timer);await this.runFlight;await this.inFlight;}
 async status(){const counts=await this.rows.aggregate([{$match:{'review.generation':{$exists:true},'handling.state':'unacknowledged'}},{$group:{_id:'$review.state',count:{$sum:1}}}],{maxTimeMS:2000}).toArray();return {available:!!this.invoke,concurrency:1,counts:Object.fromEntries(counts.map(v=>[v._id,v.count])),last_error:this.lastError,auto_requeued:this.autoRequeued,evidence:await this.context?.status?.()};}
}
