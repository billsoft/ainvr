// Region proof is not a person-category review authorization.
const markers=[['incident_scope','region'],['identity_kind','region']];
export const regionReviewExclusion={
  incident_scope:{$ne:'region'},identity_kind:{$ne:'region'},
  'analysis_evidence.region_state':{$exists:false},'rule.snapshot.region_state':{$exists:false},
};
export function isRegionReview(event){
  return markers.some(([key,value])=>event?.[key]===value)||event?.analysis_evidence?.region_state!=null||event?.rule?.snapshot?.region_state!=null;
}
