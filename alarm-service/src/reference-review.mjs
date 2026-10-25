// Reference scores never acknowledge an alarm or confer model qualification.
import {randomUUID} from 'node:crypto';
export class ReferenceReviewWorker {
 constructor({rows,image,prepare,invoke,clock=()=>Date.now()}){Object.assign(this,{rows,image,prepare,invoke,clock});}
 async step(){
  const now=this.clock(),token=randomUUID();
  const row=await this.rows.findOneAndUpdate({'handling.state':'unacknowledged',$or:[
   {'review.reference':{$exists:false}},
   {'review.reference.state':'running','review.reference.lease_until':{$lte:now}},
   {'review.reference.state':'queued','review.reference.next_attempt_at':{$lte:now}}
  ]},{$set:{'review.reference.state':'running','review.reference.token':token,'review.reference.lease_until':now+180000},$inc:{'review.reference.attempt':1}},{sort:{occurred_at:-1,alarm_id:-1},returnDocument:'after'});
  if(!row)return false;
  const fence={alarm_id:row.alarm_id,'handling.state':'unacknowledged','handling.revision':row.handling.revision,'review.reference.token':token};
  try{
   if(row.review.reference.attempt>3)throw Error('retry_exhausted');
   const original=await this.image(row);
   if(!await this.rows.findOne(fence,{projection:{alarm_id:1}}))return true;
   const prepared=await this.prepare(row,original);
   const prompt={kind:original.label,description:`这是历史告警保留的目标特写。只判断图片中的指定目标是否确实是「${original.label}」，注意海报、屏幕和倒影。此参考结果不验证运动或越界行为。`};
   const result=await this.invoke({request_id:`reference-v1-${row.alarm_id}`,image:{jpeg_base64:prepared.data.toString('base64'),fit:'strict'},alarm:prompt},{timeoutMs:120000});
   if(result.schema!=='ainvr.alarm_review.v1'||!Number.isFinite(result.real_score)||result.real_score<0||result.real_score>1||!/^[a-f0-9]{64}$/.test(result.model?.package_sha256??''))throw Error('invalid_model_result');
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
