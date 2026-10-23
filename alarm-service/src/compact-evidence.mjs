// Evidence is emitted by the production evaluator, never reconstructed from display trails.
import {digest} from './domain.mjs';
export function sampleOf(f,t){return {seq:f.seq,frame_id:f.frame_id,source_pts_ns:f.source_pts_ns,source_frame_index:f.source_frame_index??null,captured_at:f.captured_at,track_id:t.track_id,label_id:t.label_id,observation:t.observation,event_eligible:t.observation==='detected'&&t.event_eligible!==false,bbox:structuredClone(t.bbox)}}
export function beginEvidence(s,sample){delete s.review_unavailable;s.review_compact={before:s.review_compact?.last??null,start:sample,last:sample};}
export function sealEvidence(event,s,sample,r){
 const c=s.review_compact??{},traverse=r.behavior==='region_traverse';
 const roles=r.behavior==='appearance'?['开始前','首次有效检出','触发前','达到持续条件']:r.behavior==='region_approach'?['进入接近带前','进入接近带后','触发前','达到持续条件']:traverse?['进入前','进入后','离开前','离开后']:['进入前','进入后','触发前','达到持续条件'];
 const samples=new Map();[c.before,c.start,c.last,sample].forEach((x,i)=>{if(!x?.event_eligible)return;const old=samples.get(x.frame_id);if(old)old.roles.push(roles[i]);else samples.set(x.frame_id,{...x,roles:[roles[i]]});});
 const unique=[...samples.values()].sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:1);
 const proof={method:'production_evaluator_transition_v2',rule_digest:digest(event.rule.snapshot),direction:event.direction,traversal:event.analysis_evidence.traversal??null,first_seq:event.analysis_evidence.first_seq,trigger_seq:event.analysis_evidence.trigger_seq};
 const result={schema_version:'2.0',anchor:r.anchor,approach_px:r.behavior==='region_approach'?r.approach_px:null,samples:unique,trace:unique,labels:r.labels??r.label_ids.map(label_id=>({label_id,name:label_id})),region:r.points?{points:r.points,zone_id:r.zone_id,version:r.zone_version,erp_wrap:r.erp_wrap===true}:null,proof};
 result.integrity=digest({samples:unique,proof});return result;
}
export function compactProof(row){
 const c=row.analysis_evidence?.review_context,r=row.rule?.snapshot,no=reason=>({ok:false,reason,samples:[]});
 if(!r||r.erp_wrap)return no('panorama_review_unavailable');
 if(c?.truncated||digest(c?.trace)!==digest(c?.samples))return no('incomplete_trajectory');
 if(!c?.proof||c.proof.method!=='production_evaluator_transition_v2'||!Array.isArray(c.samples)||!c.samples.length||c.samples.length>4)return no('incomplete_trajectory');
 if(c.integrity!==digest({samples:c.samples,proof:c.proof})||c.proof.rule_digest!==digest(r)||digest(c.proof.direction)!==digest(row.direction)||digest(c.proof.traversal)!==digest(row.analysis_evidence.traversal??null))return no('geometry_unconfirmed');
 if(c.samples.some(s=>!s.event_eligible||s.observation!=='detected'||s.track_id!==row.track_ids?.[0]||s.label_id!==row.analysis_evidence.track.label_id||s.source_frame_index==null)||c.samples.at(-1).frame_id!==row.frame_id)return no('incomplete_trajectory');
 const required={appearance:['首次有效检出','达到持续条件'],region_approach:['进入接近带前','进入接近带后','达到持续条件'],region_enter:['进入前','进入后','达到持续条件'],region_traverse:['进入前','进入后','离开前','离开后']}[r.behavior];
 const roles=new Set(c.samples.flatMap(s=>s.roles??[]));
 if(!required||required.some(role=>!roles.has(role)))return no('missing_keyframe');
 return {ok:true,samples:c.samples,verification:c.proof};
}
