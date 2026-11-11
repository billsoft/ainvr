// Retain only genuine observations. Prediction keeps identity alive, never supplies a crossing point.
const ms=(a,b)=>Number(BigInt(a)-BigInt(b))/1e6;
// Real observations kept to estimate how the target moved just before a pause.
const MOTION_WINDOW_MS=1000,MOTION_POINTS=16;
export function gapAllowance(rule){return rule.passage?.max_gap_ms??(rule.alarm_enabled===false?1000:0);}
export function holdPassage(rule,frame,state){
 // Predictions can retain identity, but cannot accrue post-crossing confirmation time.
 const pending=state.traversal?.line_pending;
 if(pending){pending.samples=0;pending.since=null;}
 const last=state.passage_observation;
 if(!last||gapAllowance(rule)===0||ms(frame.source_pts_ns,last.pts)>gapAllowance(rule))return false;
 state.passage_pending=true;
 return true;
}
// During an input pause nothing at all was observed, so a tracker can hand the ID
// to another person. A target clearly moving one way before the pause cannot
// reappear clearly behind itself. Stationary or jittering targets are unconstrained.
function reversal(rule,frame,last,point){
 const {width,height}=frame.source,first=last.motion?.[0];
 if(!first)return false;
 const v=[(last.point[0]-first.point[0])*width,(last.point[1]-first.point[1])*height];
 const jump=[(point[0]-last.point[0])*width,(point[1]-last.point[1])*height];
 const tolerance=rule.hysteresis_px??rule.hysteresis*Math.min(width,height);
 const noise=Math.max(2*tolerance,.1*last.w);
 return Math.hypot(...v)>noise&&Math.hypot(...jump)>noise&&v[0]*jump[0]+v[1]*jump[1]<0;
}
export function restorePassage(rule,frame,track,point,state){
 const last=state.passage_observation;
 let reason=last&&last.label_id!==track.label_id?"passage_gap_label_changed":null;
 let valid=!reason;
 if(state.passage_pending&&last){
  const elapsed=ms(frame.source_pts_ns,last.pts),{width,height}=frame.source,b=track.bbox;
  const distance=Math.hypot((point[0]-last.point[0])*width,(point[1]-last.point[1])*height);
  // A bounded image-space sanity gate, not a calibrated physical speed estimate.
  const limit=Math.max(3*Math.hypot(b.w,b.h,last.w,last.h),width*1.5*elapsed/1000);
  reason=reason||(elapsed<=0?"passage_gap_time_invalid":
   elapsed>gapAllowance(rule)?"passage_gap_timeout":
   distance>limit+.001?"passage_gap_displacement":
   Math.max(b.w/last.w,last.w/b.w,b.h/last.h,last.h/b.h)>2.5?"passage_gap_size_change":
   state.passage_input_pause&&reversal(rule,frame,last,point)?"passage_gap_reversal":null);
  valid=!reason;
  if(valid){
   const t=state.traversal??={previous:null,entry:null};
   t.gaps=(t.gaps??0)+1;t.gap_ms=(t.gap_ms??0)+elapsed;
   // Marks this one step as joined across missed detections (see the straight-through rule).
   t.bridged_pts=frame.source_pts_ns;
  }
 }
 delete state.passage_pending;delete state.passage_input_pause;
 if(reason)state.passage_rejection=reason;else delete state.passage_rejection;
 // A rejected continuity starts a fresh motion history.
 const motion=valid&&last?[...(last.motion??[]),{point:[...last.point],pts:last.pts}].filter(m=>ms(frame.source_pts_ns,m.pts)<=MOTION_WINDOW_MS).slice(-MOTION_POINTS):[];
 state.passage_observation={point:[...point],pts:frame.source_pts_ns,w:track.bbox.w,h:track.bbox.h,label_id:track.label_id,...(motion.length?{motion}:{})};
 return valid;
}
