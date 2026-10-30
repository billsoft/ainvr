// Rules prove behavior; images verify identity/category. A missing optional
// visual moment never becomes a fabricated picture or an automatic rejection.
export function missingVisual(error){return error?.code==='ENOENT'||['missing_context','evidence_pending'].includes(error?.message);}
export async function selectVisualEvidence(row,proof,{image,retained}){
 if(!proof.ok)throw Error('incomplete_trajectory');
 const items=[],missing=[];
 for(const sample of proof.samples){
  try{items.push({sample,...await image(sample),source_kind:'full_frame'});}
  catch(error){if(!missingVisual(error))throw error;missing.push(sample.frame_id);}
 }
 if(!missing.length)return {mode:'all_keyframes',confirm_only:false,items,missing_frame_ids:[]};
 const trigger=proof.samples.find(s=>s.frame_id===row.frame_id);
 if(!trigger||trigger.source_pts_ns!==row.source_pts_ns||trigger.source_frame_index!==row.analysis_evidence?.source_frame_index)throw Error('incomplete_trajectory');
 if(!items.some(item=>item.sample.frame_id===trigger.frame_id)){
  const crop=await retained();
  items.push({sample:trigger,...crop,source_kind:'retained_target',key:crop.sha256});
 }
 items.sort((a,b)=>BigInt(a.sample.seq)<BigInt(b.sample.seq)?-1:1);
 return {mode:'verified_behavior_available_visuals',confirm_only:true,items,missing_frame_ids:missing};
}
