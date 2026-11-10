// Group membership is scoped to one execution rule, camera session and schedule window.
import {digest,makeAlarm} from './domain.mjs';
import {inside,boundaryDistancePx,stateSpatial} from './geometry.mjs';
import {regionDirection} from './traversal.mjs';
import {unwrapErp,liftErp} from './erp-geometry.mjs';
import {compactProof,sampleOf} from './compact-evidence.mjs';
import {separate} from './same-object.mjs';

const elapsed=(now,start)=>Number(BigInt(now)-BigInt(start))/1e6;
const ENTRY_MEMORY_MS=10000,MAX_ENTERED=64,REARM_MIN_MS=1000,MAX_MEMBERS=256,MAX_SPENT=1024;
const ptsOf=m=>BigInt(m.start?.source_pts_ns??m.sample.source_pts_ns);
// Bound persistent state without forgetting the window: keep the longest-present (simultaneous) or newest (passes)
// members, so a steady crowd keeps its clock. Returns true when something was dropped.
function bound(state,now,rule,oldestFirst){
  const window=rule.group.window_ms;
  let cut=false;
  if(state.members.length>MAX_MEMBERS){
    state.members.sort((a,b)=>{const d=ptsOf(a)-ptsOf(b);return d===0n?(a.sample.track_id<b.sample.track_id?-1:1):(oldestFirst?(d<0n?-1:1):(d<0n?1:-1));});
    if(rule.group.labels==='all'){
      // Reserve the best available witness for each required label even before every label arrives.
      const missing=new Set(rule.label_ids),reserved=new Set();
      for(const member of state.members){
        if(missing.delete(member.sample.label_id))reserved.add(member);
        if(!missing.size)break;
      }
      const remaining=state.members.filter(member=>!reserved.has(member)).slice(0,MAX_MEMBERS-reserved.size);
      state.members=[...reserved,...remaining];
    }else state.members.length=MAX_MEMBERS;
    cut=true;
  }
  if(state.spent.length>MAX_SPENT){state.spent.sort((a,b)=>Number(BigInt(b.at)-BigInt(a.at)));state.spent.length=MAX_SPENT;cut=true;}
  if(cut)state.truncated_until=String(BigInt(now)+BigInt(window+1)*1000000n);
  return !!state.truncated_until&&BigInt(now)<=BigInt(state.truncated_until);
}
// An ID switch leaves the old ID coasting on the same body as the new one: count it once.
// Real sightings are never merged here (separate detections are separate tracker claims;
// group review still checks shared witnesses); a coasting member counts only when its
// current box is apart from every member already counted.
function distinctObjects(members){
  const box=m=>({label_id:m.sample.label_id,bbox:m.current_bbox??m.sample.bbox});
  const kept=members.filter(m=>m.real);
  for(const m of members)if(!m.real&&kept.every(k=>separate(box(k),box(m))))kept.push(m);
  return kept;
}
function choose(members,rule){
  const chosen=new Map();
  if(rule.group.labels==='all'){
    for(const label of rule.label_ids){
      const member=members.find(m=>m.sample.label_id===label&&!chosen.has(m.sample.track_id));
      if(!member)return [];
      chosen.set(member.sample.track_id,member);
    }
  }
  for(const member of members){
    if(chosen.size>=rule.group.minimum)break;
    chosen.set(member.sample.track_id,member);
  }
  return chosen.size>=rule.group.minimum?[...chosen.values()]:[];
}
function memberAt(frame,track,stage){
  const sample=sampleOf(frame,track);
  return {sample,stage_proven:stage?.analysis_evidence.review_context?.proof?compactProof(stage).ok:false,direction:stage?.direction??null,traversal:stage?.analysis_evidence.traversal??null,
    transition:stage?.analysis_evidence.review_context?.samples??[],first_seq:stage?.analysis_evidence.first_seq??frame.seq};
}
function qualifies(rule,frame,track,state,entry){
  const {width,height}=frame.source,b=track.bbox;
  let p=[(b.x+b.w/2)/width,(b.y+b.h*(rule.anchor==='center'?.5:1))/height];
  const points=rule.erp_wrap?unwrapErp(rule.points):rule.points;
  if(rule.erp_wrap)p=liftErp(p,points);
  if(rule.behavior==='appearance')return state?.seen_since!=null&&elapsed(frame.source_pts_ns,state.seen_since)>=rule.duration_ms&&(!points||inside(points,p));
  if(rule.spatial_semantics==='bbox-state-v1')return !!state?.match&&state.since!=null&&elapsed(frame.source_pts_ns,state.since)>=rule.duration_ms&&stateSpatial(rule,frame,b).match;
  if(rule.behavior==='region_enter')return !!entry&&state?.side==='in'&&inside(points,p);
  if(!state?.match||state.approach_pause||inside(points,p))return false;
  const distance=q=>boundaryDistancePx(points,q,width,height);
  if(rule.erp_wrap)p=[p,[p[0]-1,p[1]],[p[0]+1,p[1]]].reduce((a,b)=>distance(a)<=distance(b)?a:b);
  if(distance(p)>rule.approach_px||elapsed(frame.source_pts_ns,state.since)<rule.duration_ms)return false;
  return !rule.entry_edges.length||rule.entry_edges.includes(regionDirection({...rule,points},frame,p,null).nearest_edge);
}
function build(rule,frame,selected,candidates,windowComplete,truncated=false){
  const members=[...selected,...candidates.filter(m=>!selected.includes(m))].slice(0,16);

  const facts=members.map(m=>{
    const s=m.sample;
    const track={track_id:s.track_id,label_id:s.label_id,bbox:s.bbox,observation:'detected',state:'confirmed',last_observed_pts_ns:s.source_pts_ns};
    const fact=makeAlarm(rule,{...frame,...s},track,m.first_seq,m.direction);
    fact.dedup_key=fact.alarm_id=digest(['group-member-v1',rule.id,rule.version,frame.stream_session_id,s.track_id,s.frame_id]);
    if(m.traversal)fact.analysis_evidence.traversal=m.traversal;
    return fact;
  });
  const id=digest(['group-v1',rule.id,rule.version,frame.stream_session_id,frame.seq]);
  const event={...facts[0],alarm_id:id,dedup_key:id,episode_id:id,frame_id:frame.frame_id,source_pts_ns:frame.source_pts_ns,
    occurred_at:frame.captured_at,last_seen_at:frame.captured_at,track_ids:members.map(m=>m.sample.track_id),group_summary:{count:members.length,mode:rule.behavior==='region_traverse'?'completed_in_window':'simultaneous',window_ms:rule.group.window_ms},group_members:facts};
  event.analysis_evidence={...event.analysis_evidence,source_frame_index:frame.source_frame_index??null,trigger_seq:frame.seq,
    started_at:members.map(m=>m.start?.captured_at??m.sample.captured_at).sort()[0],
    group:{...rule.group,proof_version:2,window_complete:windowComplete,candidate_count:candidates.length,candidates_truncated:truncated,mode:rule.behavior==='region_traverse'?'completed_in_window':'simultaneous',members:members.map(({real:_real,current_bbox:_box,...m},i)=>({...m,
      identity_sample:(()=>{const t=frame.tracks.find(t=>t.track_id===m.sample.track_id&&t.label_id===m.sample.label_id&&t.observation==='detected'&&t.state==='confirmed'&&t.event_eligible!==false);return t?sampleOf(frame,t):null;})(),
      name:rule.labels?.find(l=>l.label_id===m.sample.label_id)?.name??m.sample.label_id,event_id:digest(['behavior',facts[i].dedup_key])}))}};
  event.analysis_evidence.group_digest=digest([rule,event.analysis_evidence.group,event.frame_id,event.stream_session_id]);
  return event;
}
export function groupEvents(cp,frame,eligible,periods,events,reset){
  const previous=reset?{}:cp.groups??{},next={},result=[];
  for(const [key,rule] of eligible){
    if(!rule.group)continue;
    const stages=new Map();
    for(let i=events.length-1;i>=0;i--)if(events[i].rule.id===rule.id){stages.set(events[i].track_ids[0],events[i]);events.splice(i,1);}
    const period=periods.get(key);
    const state=next[key]=previous[key]?.period===period?previous[key]:{period,members:[],spent:[],fired:false};
    const now=frame.source_pts_ns,window=rule.group.window_ms;
    state.observed_since??=now;
    let candidates,truncated=false;
    if(rule.behavior==='region_traverse'){
      state.members=state.members.filter(m=>elapsed(now,m.sample.source_pts_ns)<=window);
      state.spent=state.spent.filter(m=>elapsed(now,m.at)<=window);
      for(const t of frame.tracks)if(stages.has(t.track_id)&&!state.spent.some(m=>m.id===t.track_id)){
        state.members=state.members.filter(m=>m.sample.track_id!==t.track_id);
        state.members.push(memberAt(frame,t,stages.get(t.track_id)));
      }
      truncated=bound(state,now,rule,false);
      candidates=state.members;
    }else{
      // Simultaneous condition. A member is a target whose last REAL qualifying sighting
      // is at most window_ms old: the window tolerates missed detections, it is not a
      // dwell time. A target observed not qualifying, or no longer reported, leaves at once.
      const last=new Map(state.members.map(m=>[m.sample.track_id,m]));
      // A target that legitimately entered keeps its proof across a missed detection (the single-target state is dropped with the track).
      const entered=state.entered??={};
      for(const id of Object.keys(entered))if(elapsed(now,entered[id].seen)>ENTRY_MEMORY_MS)delete entered[id];
      state.members=[];
      for(const t of frame.tracks){
        if(!rule.label_ids.includes(t.label_id))continue;
        const prior=last.get(t.track_id),same=prior?.sample.label_id===t.label_id?prior:null;
        if(t.state!=='confirmed'||t.observation!=='detected'||t.event_eligible===false){
          // Coasting, lost or weak: keep a recent real sighting, never create or refresh one.
          if(same&&elapsed(now,same.sample.source_pts_ns)<=window)state.members.push({...same,real:false,current_bbox:t.bbox});
          continue;
        }
        const stage=stages.get(t.track_id);
        const single=cp.states[JSON.stringify([rule.id,rule.version,t.track_id])];
        if(single?.side==='out')delete entered[t.track_id];   // seen outside again: its next way in is a new entry
        const known=rule.behavior==='region_enter'&&entered[t.track_id]?.label_id===t.label_id?entered[t.track_id]:null;
        const carried=same??known;
        if(!qualifies(rule,frame,t,single,stage||carried))continue;
        const m=memberAt(frame,t,stage);
        m.start=same?.start??m.sample;m.real=true;m.current_bbox=t.bbox;
        if(carried&&!stage){m.transition=carried.transition;m.direction=carried.direction;m.stage_proven=carried.stage_proven;m.traversal=carried.traversal??null;}
        if(rule.behavior==='region_enter'&&(stage||carried)){
          entered[t.track_id]={label_id:t.label_id,transition:m.transition,direction:m.direction,stage_proven:m.stage_proven,traversal:m.traversal,seen:now};
          const ids=Object.keys(entered);
          if(ids.length>MAX_ENTERED)delete entered[ids.sort((a,b)=>Number(BigInt(entered[a].seen)-BigInt(entered[b].seen)))[0]];
        }
        state.members.push(m);
      }
      truncated=bound(state,now,rule,true);
      candidates=distinctObjects(state.members);
    }
    const selected=choose(candidates,rule);
    // A coasting set cannot raise an alarm by itself: the completing frame has a real member.
    if(rule.behavior!=='region_traverse')state.held=selected.length>0;
    if(selected.length&&!state.fired&&(rule.behavior==='region_traverse'||selected.some(m=>m.real))){
      result.push(build(rule,frame,selected,candidates,rule.behavior!=='region_traverse'||elapsed(now,state.observed_since)>=window,truncated));
      if(rule.behavior==='region_traverse'){
        // A threshold crossing is one alarm, including when many tracks finish on the same frame.
        // Do not carry a second threshold-sized batch into a frame with no new crossing.
        state.spent.push(...state.members.map(m=>({id:m.sample.track_id,at:m.sample.source_pts_ns})));
        state.members=[];bound(state,now,rule,false);
      }else state.fired=true;
    }
    // Re-arm only after the count has stayed short for a while, so one missed detection cannot raise the same gathering twice.
    if(selected.length)delete state.low_since;
    else if(state.fired){
      state.low_since??=now;
      if(elapsed(now,state.low_since)>=Math.max(REARM_MIN_MS,window)){state.fired=false;delete state.low_since;}
    }else delete state.low_since;
  }
  if(Object.keys(next).length)cp.groups=next;else delete cp.groups;
  return result;
}
