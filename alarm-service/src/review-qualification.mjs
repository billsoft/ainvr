// Signed accuracy qualification authorizes confirmation and false-positive decisions.
// Operator-authorized confirmation is separate (review-authorization.mjs); it never qualifies a model.
import {readFile,lstat} from 'node:fs/promises';
import {REVIEW_PROMPT_VERSION} from './review-prompt.mjs';
import {verify} from 'node:crypto';
export function matchesQualification(envelope,publicKey,result,policy,now=Date.now()){
 try{
  if(envelope.version!==1||typeof envelope.payload!=='string'||envelope.payload.length>16384)return false;
  if(!verify(null,Buffer.from(envelope.payload),publicKey,Buffer.from(envelope.signature,'base64')))return false;
  const p=JSON.parse(envelope.payload);
  return p.schema==='ainvr.review-validation.v1'&&p.decision==='approved'&&
   /^[a-f0-9]{64}$/.test(p.report_sha256)&&p.dataset?.independent===true&&p.dataset?.samples>0&&
   Number.isFinite(Date.parse(p.expires_at))&&Date.parse(p.expires_at)>now&&
   p.model_sha256===result.model?.package_sha256&&p.layout==='target-crop-v1'&&
   p.layout===result.prepared_image?.layout&&p.prompt_template===result.template&&
   p.caller_template===REVIEW_PROMPT_VERSION&&result.caller_template===REVIEW_PROMPT_VERSION&&
   Array.isArray(p.labels)&&p.labels.length>0&&p.labels.includes(result.target_label)&&
   p.thresholds?.approve_above===policy.approve_above&&p.thresholds?.reject_below===policy.reject_below&&
   typeof p.thresholds?.version==='string'&&p.thresholds.version.length>0;
 }catch{return false;}
}
async function artifact(){
 try{
  const paths=['/etc/ainvr/review-validation.json','/etc/ainvr/review-validation.pub'];
  for(const path of paths){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||s.size>32768)return false;}
  const [manifest,key]=await Promise.all(paths.map(p=>readFile(p,'utf8')));
  return {manifest:JSON.parse(manifest),key};
 }catch{return null;}
}
export async function qualifiedReview(result,policy){
 const a=await artifact();return !!a&&matchesQualification(a.manifest,a.key,result,policy);
}
// Preflight avoids spending BPU time when no valid authorization is installed.
// The exact model/layout is still checked against each inference result.
export async function validationAvailable(){
 const a=await artifact();if(!a)return false;
 try{const p=JSON.parse(a.manifest.payload);return matchesQualification(a.manifest,a.key,{model:{package_sha256:p.model_sha256},prepared_image:{layout:p.layout},template:p.prompt_template,caller_template:REVIEW_PROMPT_VERSION,target_label:p.labels?.[0]},p.thresholds);}catch{return false;}
}
