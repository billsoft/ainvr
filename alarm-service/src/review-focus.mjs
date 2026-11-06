import {validPairedSupport} from './review-secondary.mjs';
// Version the image geometry and prompt together. This is an explicit operator
// opt-in; old single/group review policies keep their existing input contract.
export const FOCUS_LAYOUT = 'target-focus-v2';
export const FOCUS_PROMPT_VERSION = 'target-category-abc-v2-rule';
export const FOCUS_TEMPLATE = 'target-review-abc-v2-rule';
export const FOCUS_PROMPT = '只核对指定主体的类别；蓝色线条为布防区，无区域规则不需要布防区。使用人员、非人员、无法辨认三分类固定任务。';
export const FOCUS_DEFAULTS = Object.freeze({layout:FOCUS_LAYOUT,caller_template:FOCUS_PROMPT_VERSION,template:FOCUS_TEMPLATE,minimum_frame_score:.95,strong_frame_score:.99,non_person_above:.99});
const unit = v => Number.isFinite(v)&&v>=0&&v<=1;
export function validFocusPolicy(v) {
 return v?.layout===FOCUS_LAYOUT&&v.caller_template===FOCUS_PROMPT_VERSION&&v.template===FOCUS_TEMPLATE&&
  unit(v.minimum_frame_score)&&v.minimum_frame_score>=.95&&unit(v.strong_frame_score)&&v.strong_frame_score>=.99&&v.strong_frame_score>=v.minimum_frame_score&&unit(v.non_person_above)&&v.non_person_above>=.99;
}
export function validClassScores(value) {
 return !!value&&['person','non_person','uncertain'].every(k=>unit(value[k]))&&Math.abs(value.person+value.non_person+value.uncertain-1)<1e-5;
}
export function validFocusEnvelope(result) {
 return result?.template===FOCUS_TEMPLATE&&result.score_kind==='three_way_softmax_uncalibrated'&&validClassScores(result.class_scores)&&
  unit(result.real_score)&&Math.abs(result.real_score-result.class_scores.person)<1e-6&&typeof result.submitted_prompt==='string'&&result.submitted_prompt.length>0&&Buffer.byteLength(result.submitted_prompt)<=8192;
}
export function focusAssessment({primary,context,policy,rule,complete,pairedSupport}={}) {
 const uncertain=reason=>({outcome:'uncertain',reason});
 if(!validFocusPolicy(policy)||!unit(rule?.approve_above))return uncertain('invalid_thresholds');
 if(!Array.isArray(primary)||!primary.length||primary.length>4||!primary.every(validClassScores))return uncertain('invalid_scores');
 const floor=Math.max(policy.minimum_frame_score,rule.approve_above),strong=Math.max(policy.strong_frame_score,rule.approve_above);
 if(primary.every(s=>s.person>=floor)&&primary.some(s=>s.person>=strong))return {outcome:'confirmed',reason:'focused_person_confirmed'};
 if(!complete||!Array.isArray(context)||context.length!==primary.length||!context.every(validClassScores))return uncertain('focused_evidence_incomplete');
 // A same-target wider view may recover missing body context. Require the
 // existing explicit paired-evidence authorization, strong evidence in EVERY
 // wider frame, and no non-person/ambiguity conflict in any tight frame.
 // This never permits a strong frame to outvote another weak wider frame.
 if(validPairedSupport(pairedSupport)&&
    primary.every(s=>s.person>=pairedSupport.minimum_frame_score&&s.non_person<=.05&&s.uncertain<=.15)&&
    context.every(s=>s.person>=Math.max(.99,strong,pairedSupport.strong_frame_score)))
   return {outcome:'confirmed',reason:'focused_context_rescued',context_rescue:{minimum_primary_person:pairedSupport.minimum_frame_score,maximum_primary_non_person:.05,maximum_primary_uncertain:.15,minimum_context_person:Math.max(.99,strong,pairedSupport.strong_frame_score)}};
 const both=[...primary,...context];
 if(both.every(s=>s.person>=floor)&&both.some(s=>s.person>=strong))return {outcome:'confirmed',reason:'focused_context_confirmed'};
 // Low person scores never imply non-person. Every real required frame in BOTH
 // views must affirm the non-person class, with ambiguity consuming its own score.
 if(both.every(s=>s.non_person>=policy.non_person_above))return {outcome:'false_positive',reason:'focused_non_person_confirmed'};
 if(both.some(s=>s.uncertain>=s.person&&s.uncertain>=s.non_person))return uncertain('focused_unrecognizable');
 return uncertain('focused_class_inconclusive');
}
export function targetBox(sample, source) {
  const b=sample?.bbox;
  if(!b || !Number.isFinite(source?.width) || !Number.isFinite(source?.height) ||
    source.width<=0 || source.height<=0 || !['x','y','w','h'].every(k=>Number.isFinite(b[k])) ||
    b.x<0 || b.y<0 || b.w<=0 || b.h<=0 || b.x+b.w>source.width || b.y+b.h>source.height)
    throw Error('invalid_secondary_target');
  return [b.x/source.width,b.y/source.height,(b.x+b.w)/source.width,(b.y+b.h)/source.height];
}
export function focusPreparation(sample,source,view='tight') {
  if(!['tight','context'].includes(view))throw Error('invalid_request');
  return {version:1,layout:FOCUS_LAYOUT,view,show_target:false,target:targetBox(sample,source)};
}
export function validFocusResult(image,preparation) {
  return image?.layout===FOCUS_LAYOUT && image.view===preparation.view &&
    image.width===896 && image.height===448 && image.marker==='no-target-box' &&
    Array.isArray(image.region) && image.region.length===(preparation.region??[]).length &&
    image.region.every((p,i)=>Array.isArray(p)&&p.length===2&&p.every((v,j)=>Number.isFinite(v)&&Math.abs(v-preparation.region[i][j])<=1e-6)) &&
    Number.isFinite(image.expansion) && Math.abs(image.expansion-(preparation.view==='tight'?1.15:1.6))<1e-5 &&
    Array.isArray(image.target) && image.target.length===4 &&
    image.target.every((v,i)=>Number.isFinite(v)&&Math.abs(v-preparation.target[i])<=1e-6);
}
