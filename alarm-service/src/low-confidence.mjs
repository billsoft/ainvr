// Weak *real* observations may continue a recently visible counting identity.
// They never start one, extend their own deadline, or qualify alarm evidence.
export function counterContinuation(rule,frame,track,state){
 if(rule.alarm_enabled!==false||rule.behavior!=='region_traverse'||rule.erp_wrap||
    track.state!=='confirmed'||track.observation!=='detected'||track.display_kind!=='low_confidence')return false;
 const last=state?.passage_observation,high=state?.passage_visible_pts;
 if(!last||high==null||last.label_id!==track.label_id)return false;
 const age=Number(BigInt(frame.source_pts_ns)-BigInt(high))/1e6;
 if(age<=0||age>Math.min(rule.passage?.max_gap_ms??1000,1500))return false;
 const b=track.bbox,{width,height}=frame.source;
 const p=[(b.x+b.w/2)/width,(b.y+b.h*(rule.anchor==='center'?.5:1))/height];
 const dt=Number(BigInt(frame.source_pts_ns)-BigInt(last.pts))/1e9;
 if(dt<=0||Math.max(b.w/last.w,last.w/b.w,b.h/last.h,last.h/b.h)>1.5)return false;
 const diagonal=Math.hypot(last.w,last.h);
 if(Math.hypot((p[0]-last.point[0])*width,(p[1]-last.point[1])*height)>diagonal*(.5+Math.min(dt,.5)))return false;
 // Crowded, overlapping identities are not safe to rescue by weak evidence.
 for(const other of frame.tracks){
  if(other.track_id===track.track_id||other.label_id!==track.label_id||other.state!=='confirmed'||other.observation!=='detected')continue;
  const a=other.bbox,intersection=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  if(intersection/Math.min(a.w*a.h,b.w*b.h)>.3)return false;
 }
 return true;
}
