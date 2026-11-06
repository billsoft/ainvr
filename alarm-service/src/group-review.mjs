import {buildReviewEvidence} from './review-evidence.mjs';
// A group is a claim about a set. Keep uncertainty in the upper bound.
import {createHash} from 'node:crypto';
import {missingVisual} from './review-visual-evidence.mjs';
import {contextKey} from './review-context.mjs';
import {digest} from './domain.mjs';
import {authorizedResult,confirmationAssessment} from './review-authorization.mjs';
import {expandedTarget,secondaryPrompt,nonTargetPrompt,secondaryAssessment} from './review-secondary.mjs';
import {reviewDescription,REVIEW_PROMPT_VERSION} from './review-prompt.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
function enough(members,rule){
  return members.length>=rule.group.minimum&&(rule.group.labels==='any'||rule.label_ids.every(id=>members.some(m=>m.sample.label_id===id)));
}
export function samplesFor(member){
  const samples=[...member.transition,member.start,member.sample,member.identity_sample].filter(Boolean);
  const byFrame=new Map();
  for(const sample of samples){
    const previous=byFrame.get(sample.frame_id);
    if(previous&&(previous.source_pts_ns!==sample.source_pts_ns||previous.source_frame_index!==sample.source_frame_index||
       digest(previous.bbox)!==digest(sample.bbox)))throw Error('evidence_identity_mismatch');
    byFrame.set(sample.frame_id,{...sample,roles:[...new Set([...(previous?.roles??[]),...(sample.roles??[])])]});
  }
  return [...byFrame.values()];
}
// Two boxes of the SAME category that cover mostly the same pixels are one object seen twice. Boxes of different
// categories may overlap freely: a bag is held in front of its carrier and people in a huddle touch.
const SAME_LABEL_IOU=.5;
function iou(a,b){
  const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
  if(!(w>0&&h>0))return 0;
  const inter=w*h;return inter/(a.w*a.h+b.w*b.h-inter);
}
function separate(a,b){
  return a.label_id!==b.label_id||iou(a.bbox,b.bbox)<=SAME_LABEL_IOU;
}
export function groupDecision(row,scores,auth){
  if(buildReviewEvidence(row).blocking)return 'uncertain';
  const rule=row.rule.snapshot,g=row.analysis_evidence.group;
  if(!auth||g.proof_version!==2||row.analysis_evidence.group_digest!==digest([rule,g,row.frame_id,row.stream_session_id])||
     g.members.length!==scores.length||!enough(g.members,rule)||new Set(g.members.map(m=>m.sample.track_id)).size!==g.members.length)return 'uncertain';
  const allowed=auth.group_labels??auth.labels;
  if(!rule.labels?.every(l=>allowed.includes(l.name))||!g.members.every(m=>allowed.includes(m.name)))return 'uncertain';
  const outcome=(m,i)=>scores[i]?.event_id===m.event_id&&scores[i].authorization_id===auth.id&&scores[i].model_sha256===auth.model_sha256?scores[i].outcome:'uncertain';
  const supported=g.members.filter((m,i)=>outcome(m,i)==='confirmed');
  if(sharedWitness(supported,rule))return 'confirmed';
  const possible=g.members.filter((m,i)=>outcome(m,i)!=='false_positive');
  return auth.mode==='confirm_or_reject'&&g.window_complete===true&&g.candidate_count===g.members.length&&g.candidates_truncated!==true&&!enough(possible,rule)?'false_positive':'uncertain';
}
export function inconclusiveReason(row,scores,auth,scene){
 const group=row.analysis_evidence.group,rule=row.rule.snapshot;
 if(!auth||scores.some(s=>s.authorization_id&&s.authorization_id!==auth.id))return 'authorization_changed';
 if(scene)return 'group_scene_uncertain';
 if(scores.some(s=>s.reason==='label_not_authorized'))return 'label_not_authorized';
 const positive=group.members.filter((m,i)=>scores[i]?.outcome==='confirmed');
 if(enough(positive,rule)&&!sharedWitness(positive,rule))return 'group_identity_uncertain';
 if(group.candidate_count>group.members.length||group.candidates_truncated===true)return 'group_candidates_incomplete';
 if(!group.window_complete)return 'group_window_incomplete';
 return scores.find(s=>s.reason)?.reason??'group_evidence_inconclusive';
}
export function sharedWitness(supported,rule){
  // At least one shared real picture must distinguish the people at separate locations.
  const scenes=new Set(supported.flatMap(m=>samplesFor(m).map(s=>s.frame_id)));
  for(const frame of scenes){
    const seen=supported.map(m=>({m,s:samplesFor(m).find(s=>s.frame_id===frame)})).filter(x=>x.s);
    const kept=[];   // greedy, in track order: a duplicate box is dropped, its original is kept
    for(const a of [...seen].sort((p,q)=>String(p.s.track_id)<String(q.s.track_id)?-1:1))if(kept.every(b=>separate(a.s,b.s)))kept.push(a);
    const distinct=kept.map(x=>x.m);
    if(enough(distinct,rule))return {sample:samplesFor(distinct[0]).find(s=>s.frame_id===frame),members:distinct};
  }
  return null;
}
function verifyGroup(row){
 const g=row.analysis_evidence.group,rule=row.rule.snapshot;
 if(g.proof_version!==2||g.members.length>16||rule.erp_wrap||g.candidate_count<g.members.length||
   row.analysis_evidence.group_digest!==digest([rule,g,row.frame_id,row.stream_session_id]))throw Error('incomplete_trajectory');
}
export async function assessMember({row,member,context,auth,call,refs=[],passes=[]}){
  verifyGroup(row);
  const rule=row.rule.snapshot,source=row.analysis_evidence.source;
  const subject={...row,analysis_evidence:{...row.analysis_evidence,track:member.sample}};
  const label=member.name;
  const result={event_id:member.event_id,label,authorization_id:auth?.id??null,model_sha256:auth?.model_sha256??null,
    outcome:'uncertain',passes};
  // Group-specific grants cannot extend the single-target worker's label list.
  const scopedAuth=auth?.group_labels?{...auth,labels:auth.group_labels}:auth;
  const allowed=scopedAuth?.labels.includes(label);
  const expandedPrompt=label==='person'?secondaryPrompt(label):'请只核对画面中央指定目标是否属于「'+label+'」。周围其他实例不能代替中央目标。';
  const exclusionPrompt=label==='person'?nonTargetPrompt(label):'中央目标是否有清晰、明确的证据属于其他物体，或是海报、倒影，从而可排除「'+label+'」？模糊、遮挡、太小或无法分辨时回答否。';
  const moving=['region_traverse','region_enter'].includes(rule.behavior);
  if((moving||rule.duration_ms>0)&&!member.stage_proven)return {result:{...result,reason:'incomplete_trajectory'},refs};
  const samples=samplesFor(member);
  for(const s of samples){
    if(!s.event_eligible||s.observation!=='detected'||s.track_id!==member.sample.track_id||s.label_id!==member.sample.label_id||s.source_frame_index==null)throw Error('evidence_identity_mismatch');
    let image;
    try{image=await context.image(row,s);}catch(error){
      if(!context.recoverEvidence||!(missingVisual(error)||error.code==='ENOENT'))throw error;
      const recovered=await context.recoverEvidence(row,s);
      const key=contextKey(row,s),geometry=context.validateGeometry(recovered.data,source,true);
      context.validateRetained(recovered.data,[]);
      await context.images.put('context',key,recovered.data,context.imagePolicy(row));
      image={key,data:recovered.data,...geometry};
    }
    const {key,data,width,height}=image;
    refs.push({...s,key,width,height,content_sha256:hash(data),storage:'mongodb',source_kind:'full_frame'});
    const b=s.bbox,target=[b.x/source.width,b.y/source.height,(b.x+b.w)/source.width,(b.y+b.h)/source.height];
    const prompt=reviewDescription(subject,s);
    const visual=async(kind,box,description)=>{
      const r=await call(kind,s,{image:{jpeg_base64:data.toString('base64'),fit:'letterbox'},
        preparation:{version:1,layout:'target-crop-v1',region:[],target:box},alarm:{kind:label,description}});
      if((allowed&&!authorizedResult(scopedAuth,{...r,target_label:label,caller_template:REVIEW_PROMPT_VERSION}))||
         !Array.isArray(r.prepared_image?.target)||r.prepared_image.target.length!==4||r.prepared_image.target.some((v,i)=>!Number.isFinite(v)||Math.abs(v-box[i])>1e-6)||
         typeof r.prepared_image.jpeg_base64!=='string'||!r.prepared_image.jpeg_base64.length)throw Error('invalid_model_result');
      return r;
    };
    const primary=await visual('primary',target,prompt.description);
    const pass={model_sha256:primary.model.package_sha256,frame_id:s.frame_id,key,input_sha256:hash(data),target,prompt:prompt.description,score:primary.real_score};
    passes.push(pass);
    if(allowed&&auth.mode==='confirm_or_reject'&&primary.real_score<=Math.min(.05,rule.review.reject_below)){
      const box=expandedTarget(s,source);
      const second=await visual('expanded',box,expandedPrompt);
      pass.expanded_target=box;pass.expanded=second.real_score;pass.expanded_prompt=expandedPrompt;
      if(second.real_score<=Math.min(.01,auth.secondary.reject_below,rule.review.reject_below)){
        const jpeg=second.prepared_image.jpeg_base64;
        const check=await call('non_target',s,{image:{jpeg_base64:jpeg,fit:'strict'},alarm:{kind:label==='person'?'明确非人员目标':'明确非指定类别',description:exclusionPrompt}});
        if(check.template!==auth.prompt_template||check.model?.package_sha256!==auth.model_sha256)throw Error('invalid_model_result');
        pass.non_target=check.real_score;pass.non_target_prompt=exclusionPrompt;pass.non_target_input_sha256=hash(Buffer.from(jpeg,'base64'));
      }
    }
  }
  const scores=passes.map(p=>p.score);
  if(allowed&&confirmationAssessment(auth,scores,rule.review).outcome==='confirmed')result.outcome='confirmed';
  else if(allowed&&auth.mode==='confirm_or_reject'&&passes.every(p=>secondaryAssessment({primaryScores:[p.score],contextScores:[p.expanded],negativeEvidenceScores:[p.non_target],rule:rule.review,policy:auth.secondary,complete:true}).outcome==='false_positive'))result.outcome='false_positive';
  return {result:{...result,score:Math.min(...scores),...(!allowed?{reason:'label_not_authorized'}:{})},refs};
}
