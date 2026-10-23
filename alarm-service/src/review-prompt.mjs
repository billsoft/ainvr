export const REVIEW_PROMPT_VERSION='target-context-zh-v2';
const names={appearance:'出现',region_approach:'接近',region_enter:'碰撞侵入',region_traverse:'穿过'};
const roles=new Set(['开始前','首次有效检出','触发前','达到持续条件','进入接近带前','进入接近带后','进入前','进入后','离开前','离开后']);
export function reviewDescription(row,sample){
 const r=row.rule.snapshot;
 const label=(r.labels??row.analysis_evidence.review_context.labels).find(l=>l.label_id===row.analysis_evidence.track.label_id)?.name;
 if(!label)throw Error('missing_label');
 const moment=(sample?.roles??[]).filter(x=>roles.has(x)).join('、')||'触发关键帧';
 const description=`这是${names[r.behavior]??'目标'}告警的${moment}。行为由规则引擎判定。只核对图像中心指定目标是否确实为「${label}」，不要用其他目标代替；注意海报、屏幕和倒影。${row.review.policy.description??''}`;
 // Defense for historical/imported labels and descriptions; tokenizer is authoritative.
 if(Buffer.byteLength(description)>8192)throw Error('review_context_too_large');
 return {label,description};
}
