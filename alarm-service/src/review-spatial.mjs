import {reviewTaskContext,spatialBounds} from './review-evidence.mjs';
import {focusPreparation} from './review-focus.mjs';
// One bounded spatial cross-check. Unvalidated shadow output NEVER changes handling.
export async function spatialShadow({row,evidence,input,context,invoke,modelHash}){
 const unavailable=reason=>({state:'unavailable',reason,automatic_decision:false,scope:'single_frame_spatial_shadow'});
 if(input?.source_kind!=='full_frame'||!row.rule.snapshot.points?.length)return {state:'not_applicable',automatic_decision:false};
 const o=evidence.observations.find(o=>o.frame_id===input.sample.frame_id);
 if(typeof o?.inside!=='boolean')return unavailable('missing_spatial_observation');
 try{
  const {data}=input.data?input:await context.image(row,input.sample);
  const preparation={...focusPreparation(input.sample,row.analysis_evidence.source),show_target:true,region:row.rule.snapshot.points,scene_bounds:spatialBounds(row)};
  const task={...reviewTaskContext(row,input.sample),scope:'spatial_observation',expected_inside:o.inside};
  const response=await invoke({request_id:'spatial-'+row.alarm_id.slice(0,64),image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},preparation,alarm:{kind:'person',description:'按规则独立核对当前帧的指定目标与布防区关系',rule_context:task}},{timeoutMs:20000});
  const scores=response.spatial_scores,img=response.prepared_image;
  if(response.template!=='spatial-review-abc-v1'||response.model?.package_sha256!==modelHash||response.review_scope!=='single_frame_spatial_shadow'||!scores||!['supported','contradicted','uncertain'].every(k=>Number.isFinite(scores[k])&&scores[k]>=0&&scores[k]<=1)||Math.abs(scores.supported+scores.contradicted+scores.uncertain-1)>1e-5||img?.layout!=='scene-review-v1'||img.marker!=='green-target-box'||img.width!==896||img.height!==448||(!Array.isArray(img.region)||img.region.length!==preparation.region.length||img.region.some((p,i)=>!Array.isArray(p)||p.length!==2||p.some((v,j)=>!Number.isFinite(v)||Math.abs(v-preparation.region[i][j])>1e-6)))||!Array.isArray(img.target)||img.target.length!==4||img.target.some((x,i)=>!Number.isFinite(x)||Math.abs(x-preparation.target[i])>1e-6)||typeof response.submitted_prompt!=='string'||response.submitted_prompt.length>8192)return unavailable('invalid_spatial_result');
  const saved=await context.savePrepared(row,input.sample,img);
  return {state:'completed',automatic_decision:false,scope:'single_frame_spatial_shadow',frame_id:input.sample.frame_id,key:saved.key,frame:saved,expected_inside:o.inside,scores,prompt:response.submitted_prompt,model:response.model,timing_ms:response.timing_ms??null};
 }catch{return unavailable('spatial_review_unavailable');}
}
