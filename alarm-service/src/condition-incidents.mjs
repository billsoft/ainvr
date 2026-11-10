// Risk episodes are separate from tracker identities and visual review proofs.
// Only observed clearance rearms a condition; missing input is never clearance.
import {digest} from './domain.mjs';
import {inside,stateSpatial} from './geometry.mjs';
export function conditionIncidents(cp,frame,rules,periods,events,{discontinuity=false}={}){
 const next={},ended=[],active=[],out=[];
 const previous=cp.condition_incidents??{},now=Date.parse(frame.captured_at);
 const configured=new Map(rules.filter(r=>r.incident_policy==='condition-v1'&&r.alarm_enabled!==false).map(r=>[r.id,r]));
 for(const [id,r] of configured){
  const period=periods.get(JSON.stringify([r.id,r.version]));
  const epoch=digest([r.version,r.geometry_revision,r.view_epoch??null,period??null]);
  let s=previous[id];
  if(s?.epoch!==epoch){if(s?.episode_id)ended.push({episode_id:s.episode_id,ended_at:frame.captured_at,end_reason:'configuration_changed'});s=null;}
  if(period==null||r.state!=='enabled'){
   if(s?.episode_id)ended.push({episode_id:s.episode_id,ended_at:frame.captured_at,end_reason:'schedule_ended'});
   continue;
  }
  s=next[id]=s??{epoch,episode_id:null};
  if(discontinuity)delete s.clear_since;
  const tracked=frame.observation_mode!=='detections';
  let boundaryUncertain=false;
  const members=frame.tracks.filter(t=>r.label_ids.includes(t.label_id)&&t.observation==='detected'&&t.event_eligible!==false&&t.state==='confirmed').filter(t=>{
   if(r.spatial_semantics==='bbox-state-v1'){
    const spatial=stateSpatial(r,frame,t.bbox),margin=r.hysteresis_px??r.hysteresis*Math.min(frame.source.width,frame.source.height);
    if(!spatial.match&&spatial.distance_px<=(r.behavior==='region_approach'?r.approach_px:0)+margin)boundaryUncertain=true;
    return spatial.match;
   }
   if(!r.points)return true;
   const b=t.bbox;return inside(r.points,[(b.x+b.w/2)/frame.source.width,(b.y+b.h*(r.anchor==='center'?.5:1))/frame.source.height]);
  });
  const labels=new Set(members.map(m=>m.label_id));
  // A group is held exactly when the group evaluator counts it held (same membership,
  // same missed-detection tolerance); otherwise a flicker could end the episode while
  // the group still counts and raise the same gathering twice.
  const held=cp.groups?.[JSON.stringify([r.id,r.version])]?.held;
  const satisfied=r.group?(held??(members.length>=r.group.minimum&&(r.group.labels!=='all'||r.label_ids.every(l=>labels.has(l))))):members.length>0;
  // Coasting/lost targets and unsupported group detection cannot prove departure.
  const unknown=discontinuity||boundaryUncertain||(r.group&&!tracked)||r.geometry_revision!==frame.source.geometry_revision||r.label_map_version!==frame.model.label_map_version||(r.input_stream_id!==undefined&&r.input_stream_id!==frame.input_stream_id)||frame.tracks.some(t=>r.label_ids.includes(t.label_id)&&(t.observation!=='detected'||t.event_eligible===false||t.state!=='confirmed'));
  if(satisfied||unknown)delete s.clear_since;
  else if(s.episode_id){
   s.clear_since??=now;
   if(now>=s.clear_since&&now-s.clear_since>=r.rearm_ms){
    ended.push({episode_id:s.episode_id,ended_at:frame.captured_at,end_reason:'condition_cleared'});
    s.episode_id=null;delete s.clear_since;
    // A tracker ID can survive outside the zone. It must not keep the old latch.
    for(const [key,state] of Object.entries(cp.states??{}))if(JSON.parse(key)[0]===id){state.fired=false;delete state.seen_since;delete state.match;delete state.review_compact;}
    for(const [key,g] of Object.entries(cp.groups??{}))if(JSON.parse(key)[0]===id){g.fired=false;g.members=[];delete g.low_since;}
    for(const key of Object.keys(cp.detection_latches??{}))if(JSON.parse(key)[0]===id)cp.detection_latches[key].fired=false;
   }
  }
  if(s.episode_id&&satisfied&&(!s.last_touch||now-s.last_touch>=1000)){
   active.push({episode_id:s.episode_id,last_seen_at:frame.captured_at});s.last_touch=now;
  }
 }
 for(const [id,s] of Object.entries(previous))if(!configured.has(id)&&s.episode_id)ended.push({episode_id:s.episode_id,ended_at:frame.captured_at,end_reason:'configuration_changed'});
 for(const event of events){
  const r=event.rule.snapshot,s=next[r.id];
  if(r.incident_policy!=='condition-v1'||!s){out.push(event);continue;}
  if(s.episode_id)continue;
  s.episode_id=digest(['condition-v1',frame.channel_id,r.id,s.epoch,frame.stream_session_id,frame.seq]);
  event.episode_id=s.episode_id;event.episode_started_at=frame.captured_at;
  event.incident_scope='condition';event.lifecycle={state:'active',end_reason:null};
  out.push(event);
 }
 cp.condition_incidents=next;
 return {events:out,ended,active};
}
