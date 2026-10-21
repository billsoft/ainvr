// Retain only genuine observations. Prediction keeps identity alive, never supplies a crossing point.
const ms=(a,b)=>Number(BigInt(a)-BigInt(b))/1e6;
export function gapAllowance(rule){return rule.passage?.max_gap_ms??(rule.alarm_enabled===false?1000:0);}
export function holdPassage(rule,frame,state){
 const last=state.passage_observation;
 if(!last||gapAllowance(rule)===0||ms(frame.source_pts_ns,last.pts)>gapAllowance(rule))return false;
 state.passage_pending=true;
 return true;
}
export function restorePassage(rule,frame,track,point,state){
 const last=state.passage_observation;
 let valid=!last||last.label_id===track.label_id;
 if(state.passage_pending&&last){
  const elapsed=ms(frame.source_pts_ns,last.pts),{width,height}=frame.source,b=track.bbox;
  const distance=Math.hypot((point[0]-last.point[0])*width,(point[1]-last.point[1])*height);
  // A bounded image-space sanity gate, not a calibrated physical speed estimate.
  const limit=Math.max(3*Math.hypot(b.w,b.h,last.w,last.h),width*1.5*elapsed/1000);
  valid=valid&&elapsed>0&&elapsed<=gapAllowance(rule)&&distance<=limit+.001&&
   Math.max(b.w/last.w,last.w/b.w,b.h/last.h,last.h/b.h)<=2.5;
  if(valid){
   const t=state.traversal??={previous:null,entry:null};
   t.gaps=(t.gaps??0)+1;t.gap_ms=(t.gap_ms??0)+elapsed;
  }
 }
 delete state.passage_pending;
 state.passage_observation={point:[...point],pts:frame.source_pts_ns,w:track.bbox.w,h:track.bbox.h,label_id:track.label_id};
 return valid;
}
