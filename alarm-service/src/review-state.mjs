// Legacy transition proofs remain intact. For an instantaneous occupancy alarm,
// the category of the specified target at the trigger frame is decisive. Earlier
// views still veto confirmation if they positively contradict that identity.
// This exception never authorizes a false-positive decision.
export function stateConfirmation(row,proof,inputs,results){
 const r=row.rule?.snapshot;
 if(!proof?.ok||r?.spatial_semantics||r?.erp_wrap||r?.group||r?.duration_ms!==0||
    !['region_enter','region_approach'].includes(r?.behavior)||r.entry_edges?.length||r.exit_edges?.length)return null;
 if(inputs.length!==proof.samples.length||inputs.some((x,i)=>x.source_kind!=='full_frame'||x.sample.frame_id!==proof.samples[i].frame_id))return null;
 const index=inputs.findIndex(x=>x.sample.frame_id===row.frame_id);
 if(index<0||results.length!==inputs.length||results.some(x=>!x.class_scores||x.class_scores.non_person>=.95))return null;
 return {scores:[results[index].real_score],scope:'trigger_state_category_with_verified_legacy_behavior',frame_ids:[row.frame_id]};
}
