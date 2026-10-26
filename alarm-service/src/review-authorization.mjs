// Operator authorization is a deployment decision, not an accuracy certificate.
// Keep it separate from signed model validation; it can only confirm alarms.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {REVIEW_PROMPT_VERSION} from './review-prompt.mjs';

export function parseAuthorization(value){
 if(value?.schema!=='ainvr.review-authorization.v1'||value.enabled!==true||value.mode!=='confirm_only'||
  !/^[a-f0-9]{64}$/.test(value.model_sha256??'')||value.layout!=='target-crop-v1'||
  value.prompt_template!=='alarm-review-zh-v1'||value.caller_template!==REVIEW_PROMPT_VERSION||
  !Array.isArray(value.labels)||!value.labels.length||value.labels.length>100||
  value.labels.some(v=>typeof v!=='string'||!v.trim()||v.length>128)||
  !Number.isFinite(value.approve_above)||value.approve_above<.95||value.approve_above>1||
  (value.minimum_frame_score!==undefined&&(!Number.isFinite(value.minimum_frame_score)||value.minimum_frame_score<.95||value.minimum_frame_score>value.approve_above))||
  typeof value.authorized_by!=='string'||!value.authorized_by.trim()||
  !Number.isFinite(Date.parse(value.authorized_at)))return null;
 const policy={schema:value.schema,mode:value.mode,model_sha256:value.model_sha256,layout:value.layout,
  prompt_template:value.prompt_template,caller_template:value.caller_template,labels:[...value.labels].sort(),
  approve_above:value.approve_above,minimum_frame_score:value.minimum_frame_score??value.approve_above,authorized_by:value.authorized_by,authorized_at:value.authorized_at};
 return {...policy,id:createHash('sha256').update(JSON.stringify(policy)).digest('hex')};
}
export async function reviewAuthorization(){
 let file;
 try{
  file=await open('/etc/ainvr/review-authorization.json',constants.O_RDONLY|constants.O_NOFOLLOW);
  const s=await file.stat();
  if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.size>16384)return null;
  return parseAuthorization(JSON.parse(await file.readFile('utf8')));
 }catch{return null;}finally{await file?.close();}
}
export function authorizedResult(policy,result){
 return !!policy&&result.model?.package_sha256===policy.model_sha256&&
  result.prepared_image?.layout===policy.layout&&result.template===policy.prompt_template&&
  result.caller_template===policy.caller_template&&policy.labels.includes(result.target_label);
}

// Required frames must all support the class; one strong frame cannot outvote a
// contradictory frame. One-frame evidence still needs the stronger threshold.
export function authorizedScores(policy,scores,rule){
 if(!policy||!Array.isArray(scores)||!scores.length||scores.some(v=>!Number.isFinite(v)||v<0||v>1)||
  !Number.isFinite(rule?.approve_above))return false;
 const strong=Math.max(policy.approve_above,rule.approve_above);
 const floor=Math.max(policy.minimum_frame_score??policy.approve_above,rule.approve_above);
 return scores.every(v=>v>=floor)&&scores.some(v=>v>=strong);
}
