import {buildReviewEvidence} from './review-evidence.mjs';
// Legacy reference scores remain advisory. Only evidence-v2 groups enter adjudication.
import {assessMember,groupDecision,sharedWitness,inconclusiveReason} from './group-review.mjs';
import {reviewAuthorization} from './review-authorization.mjs';
import {digest} from './domain.mjs';
import {randomUUID} from 'node:crypto';
export class ReferenceReviewWorker {
 constructor({rows,image,prepare,invoke,context,authorization=reviewAuthorization,clock=()=>Date.now()}){Object.assign(this,{rows,image,prepare,invoke,context,authorization,clock});}
 async groupStep(row,member,index,fence){
  const group=row.analysis_evidence.group;
  const evidence=buildReviewEvidence(row);
  if(evidence.blocking){await this.rows.updateOne(fence,{$set:{'review.rule_evidence':evidence,'review.state':'uncertain','review.reason':'rule_evidence_conflict','review.reference.state':'completed','review.reference.lease_until':0}});return;}
  Object.assign(fence,{rule:row.rule,analysis_evidence:row.analysis_evidence,'review.policy':row.review.policy,
    'review.group_scores':row.review.group_scores??{$exists:false}});
  const auth=await this.authorization();
  const call=async(pass,sample,body)=>{
    if((await this.authorization())?.id!==auth?.id)throw Error('authorization_changed');
    const renewed=await this.rows.updateOne(fence,{$set:{'review.reference.lease_until':this.clock()+180000}});
    if(!renewed.matchedCount)throw Error('review_fence_changed');
    const result=await this.invoke({request_id:'group-'+digest([row.alarm_id,member.event_id,sample.frame_id,pass,auth?.id??null]),...body},{timeoutMs:120000});
    if(result.schema!=='ainvr.alarm_review.v1'||!/^[a-f0-9]{64}$/.test(result.model?.package_sha256??'')||!Number.isFinite(result.real_score)||result.real_score<0||result.real_score>1)throw Error('invalid_model_result');
    return result;
  };
  let assessed;
  const availableFrames=[],completedPasses=[];
  try{assessed=await assessMember({row,member,auth,context:this.context,call,refs:availableFrames,passes:completedPasses});}
  catch(e){
    if(e.message==='review_fence_changed')return;
    // Retry transport or late capture per participant, then allow the other witnesses to proceed.
    if(row.review.reference.attempt<3&&!['authorization_changed','invalid_model_result','incomplete_trajectory','evidence_identity_mismatch'].includes(e.message))throw e;
    assessed={refs:availableFrames,result:{event_id:member.event_id,label:member.name,passes:completedPasses,outcome:'uncertain',reason:['authorization_changed','invalid_model_result','incomplete_trajectory','evidence_identity_mismatch'].includes(e.message)?e.message:'group_visual_unavailable'}};
  }
  const {result,refs}=assessed,complete=index+1===group.members.length;
  const current=await this.authorization();
  const scores=[...(row.review.group_scores??[]),result];
  let verdict=complete&&current?.id===auth?.id?groupDecision(row,scores,current):'uncertain';
  let scene=null;
  if(verdict==='confirmed'){
    const witness=sharedWitness(group.members.filter((m,i)=>scores[i].outcome==='confirmed'&&scores[i].authorization_id===current.id),row.rule.snapshot);
    const prompt='请核对整幅真实画面中能否同时清楚看见至少 '+row.rule.snapshot.group.minimum+' 个不同的真实目标。'+(group.labels==='all'?'每种都必须出现：':'目标类别范围：')+[...new Set(witness.members.map(m=>m.name))].join('、')+'。不重复计算同一目标、海报或倒影。不清楚时回答否。';
    const image=await this.context.image(row,witness.sample);
    const answer=await call('scene',witness.sample,{image:{jpeg_base64:image.data.toString('base64'),fit:'letterbox'},alarm:{kind:'组合目标同时可见',description:prompt}});
    scene={frame_id:witness.sample.frame_id,key:image.key,prompt,score:answer.real_score,model_sha256:answer.model.package_sha256,template:answer.template};
    if(answer.template!==current.prompt_template||scene.model_sha256!==current.model_sha256||scene.score<Math.max(.99,current.approve_above,row.review.policy.approve_above))verdict='uncertain';
  }
  if(verdict!=='uncertain'&&(await this.authorization())?.id!==current.id)verdict='uncertain';
  const auto=verdict!=='uncertain',at=new Date(this.clock()).toISOString();
  const frames=[...new Map([...(row.review.frames??[]),...refs].map(r=>[r.key,r])).values()];
  const set={'review.rule_evidence':evidence,'review.group_scores':scores,'review.frames':frames,'review.reference':{state:complete?'completed':'queued',attempt:0,next_attempt_at:0,scope:'group_visual_evidence',automatic_decision:auto}};
  const update={$set:set,$inc:{version:1}};
  if(complete){
    if(scene)set['review.group_scene']=scene;
    Object.assign(set,{'review.group_verdict':verdict,'review.state':auto?(verdict==='confirmed'?'supported':'not_supported'):'uncertain',
     'review.reason':auto?null:inconclusiveReason(row,scores,current,scene),'review.completed_at':at});
    if(auto){
      const disposition=verdict==='confirmed'?'handled':'false_positive';
      set.handling={state:'acknowledged',revision:row.handling.revision+1,disposition,reviewed_by_kind:'ai',acknowledged_by:'AI',acknowledged_at:at};
      set['review.decision_basis']='operator_authorized_group_review';
      set['review.authorization']={id:current.id,mode:current.mode,accuracy_validated:false};
      update.$push={logs:{$each:[{operation_id:randomUUID(),action:'ai_review',actor:'ai-review',at,disposition,decision_basis:'operator_authorized_group_review',model:{package_sha256:current.model_sha256},evidence_generation:row.analysis_evidence.group_digest,authorization_id:current.id,evidence_digest:row.analysis_evidence.group_digest,note:'组合审核 '+verdict}],$slice:-1024}};
    }
  }
  await this.rows.updateOne(fence,update);
 }
 async step(){
  const now=this.clock(),token=randomUUID();
  const row=await this.rows.findOneAndUpdate({'handling.state':'unacknowledged','review.policy.enabled':true,'review.context_state':{$ne:'ready'},$and:[{$or:[{'review.context_state':'incomplete'},{'review.generation':{$exists:false}}]}],$or:[
   {'review.reference':{$exists:false}},
   {'review.reference.state':'running','review.reference.lease_until':{$lte:now}},
   {'review.reference.state':'queued','review.reference.next_attempt_at':{$lte:now}}
  ]},{$set:{'review.reference.state':'running','review.reference.token':token,'review.reference.lease_until':now+180000},$inc:{'review.reference.attempt':1}},{sort:{occurred_at:-1,alarm_id:-1},returnDocument:'after'});
  if(!row)return false;
  const fence={alarm_id:row.alarm_id,'handling.state':'unacknowledged','handling.revision':row.handling.revision,'review.reference.token':token,'review.generation':row.review.generation??{$exists:false}};
  try{
   if(row.review.reference.attempt>3)throw Error('retry_exhausted');
   // One participant per lease keeps the existing timeout, retry and human decision fences.
   const group=row.analysis_evidence?.group;
   const index=row.review.group_scores?.length??0;
   const member=group?.members[index];
   if(group&&(!member||group.members.length>16||!row.behavior_event_ids.includes(member.event_id)))throw Error('evidence_identity_mismatch');
   if(member&&this.context&&group.proof_version===2){await this.groupStep(row,member,index,fence);return true;}
   const sample=member?.sample;
   const subject=member?{...row,source_pts_ns:sample.source_pts_ns,track_ids:[sample.track_id],
     analysis_evidence:{...row.analysis_evidence,track:sample,source_frame_index:sample.source_frame_index},
     review:{...row.review,evidence_id:member.event_id}}:row;
   const original=await this.image(subject);
   if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
   const prepared=await this.prepare(row,original);
   const prompt={kind:original.label,description:`这是告警保留的目标特写。只判断图片中的指定目标是否确实是「${original.label}」，注意海报、屏幕和倒影。此参考结果不验证运动或越界行为。`};
   const result=await this.invoke({request_id:`reference-v1-${member?.event_id??row.alarm_id}`,image:{jpeg_base64:prepared.data.toString('base64'),fit:'strict'},alarm:prompt},{timeoutMs:120000});
   if(result.schema!=='ainvr.alarm_review.v1'||!Number.isFinite(result.real_score)||result.real_score<0||result.real_score>1||!/^[a-f0-9]{64}$/.test(result.model?.package_sha256??''))throw Error('invalid_model_result');
   if(member){
     const score={event_id:member.event_id,label:original.label,model_sha256:result.model.package_sha256,score:result.real_score,
       original_sha256:original.sha256,input_sha256:prepared.sha256,key:prepared.key,prompt:prompt.description};
     const complete=index+1===group.members.length;
     await this.rows.updateOne(fence,{$push:{'review.group_scores':score},$set:{'review.reference':{state:complete?'completed':'queued',
       attempt:0,next_attempt_at:now,scope:'group_target_categories',automatic_decision:false}},$inc:{version:1}});
     return true;
   }
   await this.rows.updateOne(fence,{$set:{'review.reference':{state:'completed',attempt:row.review.reference.attempt,score:result.real_score,model:result.model,completed_at:new Date(this.clock()).toISOString(),layout:'retained-crop-jpu-gles-letterbox-v1',prompt_version:'reference-target-zh-v1',prompt,image_sha256:original.sha256,input_sha256:prepared.sha256,input_key:prepared.key,scope:'target_category_only',automatic_decision:false,reason:'historical_behavior_evidence_incomplete',elapsed_ms:this.clock()-now}},$inc:{version:1}});
  }catch(error){
   const permanent=['missing_evidence','evidence_identity_mismatch','unsupported_image','insufficient_target_pixels','missing_label','invalid_model_result','retry_exhausted','input_too_long','invalid_request'].includes(error.message);
   const reason=permanent||error.message==='evidence_pending'?error.message:'review_unavailable',retry=!permanent&&row.review.reference.attempt<3;
   await this.rows.updateOne(fence,{$set:{'review.reference.state':retry?'queued':'failed','review.reference.reason':reason,'review.reference.next_attempt_at':this.clock()+30000*2**(row.review.reference.attempt-1),'review.reference.lease_until':0},$unset:{'review.reference.token':''},$inc:{version:1}});
  }finally{
   await this.rows.updateOne({alarm_id:row.alarm_id,'review.reference.token':token,'handling.state':'acknowledged'},{$set:{'review.reference.state':'skipped','review.reference.reason':'human_handled','review.reference.lease_until':0},$unset:{'review.reference.token':''}});
  }
  return true;
 }
}
