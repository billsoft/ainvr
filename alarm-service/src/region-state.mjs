// Copyright AINVR. Region observations are not target tracks or flow counters.
// State and immutable outcomes travel in the existing consumer checkpoint commit.
import {digest,matchesLabelVersion,REGION_STATE_SEMANTICS} from './domain.mjs';
import {inside,boundaryDistancePx} from './geometry.mjs';
import {unwrapErp,liftErp} from './erp-geometry.mjs';
import {createScheduleEvaluator} from './schedule.mjs';

const nsPerMs=1000000n;
const milliseconds=(a,b)=>Number(BigInt(a)-BigInt(b))/1e6;
const MAX_MEMBER_IDS=64;
// A conservative visible-state candidate, NOT a classifier of a fall process.
// Unsupported viewpoints, sitting/bending, missing or ambiguous joints stay
// unknown; they cannot manufacture either an alarm or observed recovery.
export function suspectedDownPose(track,frame){
  const p=track.attributes?.pose;
  if(!p||p.schema_version!=='1.0'||p.type!=='keypoints'||p.status!=='observed'||p.layout!=='coco17'||
    p.coordinate_space!=='original_image'||!Array.isArray(p.image_size)||p.image_size[0]!==frame.source.width||p.image_size[1]!==frame.source.height||
    !/^[a-f0-9]{64}$/.test(p.source_model_sha256??'')||!Array.isArray(p.points)||p.points.length!==17)return 'unknown';
  if(p.association!==undefined&&(!p.association||p.association.method!=='same_frame_mutual_iou'||!Number.isFinite(p.association.iou)||p.association.iou<.5||p.association.iou>1))return 'unknown';
  if(p.source_node!==undefined&&p.source_node!==track.source_node&&p.association===undefined)return 'unknown';
  if(p.points.some(k=>!k||!['x','y','score'].every(n=>Number.isFinite(k[n]))||k.score<0||k.score>1))return 'unknown';
  const visible=[5,6,11,12,13,14,15,16];
  if(!Number.isFinite(p.visibility_threshold)||p.visibility_threshold<0||p.visibility_threshold>1)return 'unknown';
  const confidence=Math.max(.6,p.visibility_threshold),b=track.bbox,margin=Math.max(2,.1*Math.max(b.w,b.h));
  if(visible.some(i=>{const k=p.points[i];return k.score<confidence||k.x<0||k.y<0||k.x>frame.source.width||k.y>frame.source.height||k.x<b.x-margin||k.x>b.x+b.w+margin||k.y<b.y-margin||k.y>b.y+b.h+margin;}))return 'unknown';
  const mid=(a,b)=>({x:(p.points[a].x+p.points[b].x)/2,y:(p.points[a].y+p.points[b].y)/2});
  const shoulder=mid(5,6),hip=mid(11,12),knee=mid(13,14),ankle=mid(15,16);
  const segment=(a,b)=>({x:b.x-a.x,y:b.y-a.y});
  const torso=segment(shoulder,hip),upper=segment(hip,knee),lower=segment(knee,ankle);
  const minimum=Math.max(12,Math.min(frame.source.width,frame.source.height)*.015);
  const horizontal=v=>Math.abs(v.x)>=minimum&&Math.abs(v.x)>=2*Math.abs(v.y);
  const vertical=v=>v.y>=minimum&&v.y>=2*Math.abs(v.x);
  if(horizontal(torso)&&horizontal(upper)&&horizontal(lower)&&Math.sign(torso.x)===Math.sign(upper.x)&&Math.sign(upper.x)===Math.sign(lower.x)&&track.bbox.w>=1.3*track.bbox.h)return 'candidate';
  if(vertical(torso)&&vertical(upper)&&vertical(lower))return 'clear';
  return 'unknown';
}

function observed(r,f){
  const unknown=reason=>({valid:false,count:null,members:[],reason});
  if(f.source_pts_valid===false)return unknown('source_pts_invalid');
  if(f.observation_status==='unknown')return unknown('observation_unavailable');
  if(f.source_frame_index===undefined)return unknown('source_identity_missing');
  if(r.input_stream_id!==undefined&&r.input_stream_id!==f.input_stream_id)return unknown('input_mismatch');
  if(r.geometry_revision!==f.source.geometry_revision||!matchesLabelVersion(f,r))return unknown('configuration_mismatch');
  if(r.source_binding&&(r.source_binding.width!==f.source.width||r.source_binding.height!==f.source.height))return unknown('source_dimensions_changed');
  if(r.view_not_before&&Date.parse(f.captured_at)<Date.parse(r.view_not_before))return unknown('view_not_ready');
  if(r.source_binding&&Date.parse(f.captured_at)<Date.parse(r.source_binding.not_before))return unknown('source_not_ready');
  const policy=r.region_state,capability=f.region_observations?.[policy.event_kind];
  // Counts can use the existing successful tracking journal. New semantic
  // presence labels require explicit, current producer capability attestation.
  if((policy.operator==='presence'||capability!==undefined)&&
    (!capability||capability.state!=='valid'||capability.source_pts_ns!==f.source_pts_ns||
      !r.label_ids.every(id=>capability.label_ids?.includes(id))))return unknown('capability_unavailable');
  if(policy.operator!=='presence'&&f.observation_mode==='detections')return unknown('tracking_required');
  const targets=f.tracks.filter(t=>r.label_ids.includes(t.label_id));
  const points=r.points?(r.erp_wrap?unwrapErp(r.points):r.points):null;
  const members=[],poseWitnesses=[];let poseWitnessCount=0,doubt=null;
  // `members` are certain: confirmed, observed this frame, clearly inside.
  // `doubt` is the first target that may also be inside but cannot be counted.
  for(const t of targets){
    // A coasting or lost target has no observed position: it may be anywhere.
    if(t.observation!=='detected'){doubt??='incomplete_target_observation';continue;}
    const b=t.bbox;
    let point=[(b.x+b.w/2)/f.source.width,(b.y+b.h*(r.anchor==='center'?.5:1))/f.source.height];
    if(points){
      if(r.erp_wrap)point=liftErp(point,points);
      const margin=r.hysteresis_px??r.hysteresis*Math.min(f.source.width,f.source.height);
      if(boundaryDistancePx(points,point,f.source.width,f.source.height)<=margin){doubt??='boundary_uncertain';continue;}
      // Observed clearly outside: irrelevant to this zone whatever its state.
      if(!inside(points,point))continue;
    }
    if(t.state!=='confirmed'||t.event_eligible===false){doubt??='incomplete_target_observation';continue;}
    if(policy.event_kind==='suspected_down'){
      const verdict=suspectedDownPose(t,f);
      if(verdict==='unknown'){doubt??='pose_unconfirmed';continue;}
      poseWitnessCount++;
      if(poseWitnesses.length<4)poseWitnesses.push({track_id:t.track_id,source_node:t.source_node??null,verdict,pose:structuredClone(t.attributes.pose)});
      if(verdict!=='candidate')continue;
    }
    members.push(t.track_id);
  }
  // The certain count is a lower bound. It already proves "at least N"; it can
  // never prove "fewer than N" or a recovery while a doubtful target remains.
  const lowerBoundMet=policy.operator!=='count_below'&&members.length>=policy.threshold;
  if(doubt&&!lowerBoundMet)return unknown(doubt);
  return {valid:true,count:members.length,members,reason:null,poseWitnesses,poseWitnessCount};
}

function sampleOf(f,observation){
  return {seq:f.seq,frame_id:f.frame_id,source_pts_ns:f.source_pts_ns,source_frame_index:f.source_frame_index,
    captured_at:f.captured_at,identity_kind:'region',observation:'region',event_eligible:true,
    validity:'valid',count:observation.count,member_track_ids:observation.members.slice(0,MAX_MEMBER_IDS),
    ...(observation.poseWitnessCount?{pose_gate:'coco17-horizontal-v1',pose_witnesses:observation.poseWitnesses,pose_witnesses_truncated:observation.poseWitnessCount>4}:{}),
    members_truncated:observation.members.length>MAX_MEMBER_IDS};
}

// Called only before pending is durably prepared. These repeated diagnostics
// are optional: counts, source identities, continuity and episode latches are
// authoritative. Never reset a window or invent recovery to reclaim space.
export function compactRegionEvidence(pending){
  const changed=new Set();
  const compact=sample=>{
    if(sample?.identity_kind!=='region'||sample.observation!=='region')return;
    let omitted=false;
    for(const [field,flag] of [['pose_witnesses','pose_witnesses_truncated'],['member_track_ids','members_truncated']]){
      if(sample[field]?.length){sample[field]=[];sample[flag]=true;omitted=true;}
    }
    if(omitted){sample.detail_omitted_reason='region_evidence_capacity';changed.add(sample);}
  };
  for(const state of Object.values(pending.checkpoint?.region_states??{})){
    compact(state.window?.start);compact(state.window?.last);
  }
  for(const intent of pending.capture_intents??[])compact(intent.sample);
  for(const event of pending.events??[]){
    if(event.incident_scope!=='region')continue;
    const context=event.analysis_evidence?.review_context;
    for(const sample of [...(context?.samples??[]),...(context?.trace??[])])compact(sample);
    // Samples may also be shared with windows/intents in this evaluation.
    // Seal the compacted proof once, before facts and alarm copies are written.
    if(context?.samples?.some(sample=>changed.has(sample)))context.integrity=digest({samples:context.samples,proof:context.proof});
  }
  return changed.size>0;
}

function advanceWindow(s,kind,sample){
  const previous=s.window;
  if(!previous||previous.kind!==kind){
    s.window={kind,start:sample,last:sample,sample_count:1,elapsed_ns:'0',max_interval_ms:0};
  }else{
    const step=BigInt(sample.source_pts_ns)-BigInt(previous.last.source_pts_ns);
    // Admission already bounded each interval and guaranteed strictly increasing
    // PTS. No captured_at arithmetic or time preceding the first sample is used.
    previous.elapsed_ns=String(BigInt(previous.elapsed_ns)+step);
    previous.sample_count++;
    previous.max_interval_ms=Math.max(previous.max_interval_ms,Number(step)/1e6);
  }
  return s.window;
}

function makeRegionEvent(r,f,s,window,sample){
  const p=r.region_state;
  const key=digest([REGION_STATE_SEMANTICS,r.id,s.epoch,f.channel_id,f.input_stream_id,f.stream_session_id,window.start.seq,window.start.source_pts_ns]);
  const samples=[...new Map([window.start,window.last,sample].map(item=>[item.frame_id,item])).values()];
  const proof={method:'production_region_state_v1',rule_digest:digest(r),event_kind:p.event_kind,
    operator:p.operator,threshold:p.threshold,first_seq:window.start.seq,trigger_seq:f.seq,
    start_pts_ns:window.start.source_pts_ns,end_pts_ns:f.source_pts_ns,
    valid_duration_ms:Number(BigInt(window.elapsed_ns))/1e6,sample_count:window.sample_count,
    max_interval_ms:window.max_interval_ms,max_gap_ms:p.max_gap_ms};
  const region={schema_version:'1.0',semantics:REGION_STATE_SEMANTICS,scope_id:digest([r.id,r.zone_id??null]),
    validity:'valid',event_kind:p.event_kind,operator:p.operator,threshold:p.threshold,count:sample.count,
    label_ids:[...r.label_ids],duration_required_ms:p.duration_ms,recovery_required_ms:p.recovery_ms,
    ...proof};
  return {schema_version:'1.0',alarm_id:key,dedup_key:key,episode_id:key,episode_started_at:window.start.captured_at,
    incident_scope:'region',identity_kind:'region',event_kind:p.event_kind,
    channel_id:f.channel_id,input_stream_id:f.input_stream_id,stream_session_id:f.stream_session_id,track_ids:[],
    trigger_id:r.trigger_id??r.id,rule:{id:r.id,version:r.version,name:r.name,snapshot:structuredClone(r)},
    behavior:r.behavior,severity:r.severity,occurred_at:f.captured_at,last_seen_at:f.captured_at,
    source_pts_ns:f.source_pts_ns,frame_id:f.frame_id,direction:null,model_snapshot:structuredClone(f.model),
    analysis_evidence:{...(f.evidence_delivery?{delivery:structuredClone(f.evidence_delivery)}:{}),
      engine_semantics:REGION_STATE_SEMANTICS,observation_mode:'region',started_at:window.start.captured_at,
      first_seq:window.start.seq,trigger_seq:f.seq,source_frame_index:f.source_frame_index,
      source:structuredClone(f.source),region_state:region,
      review_context:{schema_version:'2.0',scope:'region',samples,trace:samples,proof,
        region:r.points?{points:structuredClone(r.points),zone_id:r.zone_id,version:r.zone_version,erp_wrap:r.erp_wrap===true}:null,
        integrity:digest({samples,proof})}},
    lifecycle:{state:'active',end_reason:null},review:{state:'skipped',reason:'region_manual_review',attempt:0},
    handling:{state:'unacknowledged',revision:0,disposition:'unset'},evidence:{state:'pending',refs:[]},version:1};
}

export function evaluateRegionStates(cp,f,rules,{discontinuity=false}={}){
  const previous=cp.region_states??{},next=Object.create(null),events=[],ended=[],active=[],issues=[],captureIntents=[];
  const atCapture=createScheduleEvaluator(f.captured_at);
  const configured=new Set();
  const end=(state,reason)=>{if(state?.episode_id)ended.push({episode_id:state.episode_id,ended_at:f.captured_at,end_reason:reason});};
  const capture=sample=>{if(captureIntents.length<128)captureIntents.push({channel_id:f.channel_id,stream_session_id:f.stream_session_id,source:f.source,sample});};
  for(const r of rules){
    if(r.channel_id!==f.channel_id)continue;
    configured.add(r.id);
    const period=atCapture(r.schedule);
    const old=Object.hasOwn(previous,r.id)?previous[r.id]:null;
    if(r.state!=='enabled'||period===null){end(old,period===null?'schedule_ended':'configuration_changed');continue;}
    // A rule or window change closes the prior contract; a video session change
    // only interrupts evidence and never declares recovery of a physical risk.
    const epoch=digest([r,period]);
    if(old&&old.epoch!==epoch)end(old,'configuration_changed');
    const s=next[r.id]=old?.epoch===epoch?old:{semantics:REGION_STATE_SEMANTICS,epoch,episode_id:null,window:null};
    const hadSample=s.last_pts!==undefined;
    const delta=hadSample?milliseconds(f.source_pts_ns,s.last_pts):null;
    let interrupted=f.gap===true||(hadSample&&(discontinuity||s.session!==f.stream_session_id||s.input_stream_id!==f.input_stream_id||
      BigInt(f.seq)!==BigInt(s.last_seq)+1n||delta<=0||delta>r.region_state.max_gap_ms||
      f.frame_id===s.last_frame_id||(f.source_frame_index!==undefined&&s.last_frame_index!==undefined&&BigInt(f.source_frame_index)<=BigInt(s.last_frame_index))));
    const observation=observed(r,f);
    s.session=f.stream_session_id;s.input_stream_id=f.input_stream_id;s.last_pts=f.source_pts_ns;s.last_seq=f.seq;
    s.last_frame_id=f.frame_id;s.last_frame_index=f.source_frame_index;
    if(interrupted||!observation.valid){
      s.phase='unknown';s.validity='unknown';s.count=null;s.reason=interrupted?'input_discontinuity':observation.reason;s.window=null;
      issues.push(`region_unknown:${r.id}:${s.reason}`);
      continue;
    }
    s.validity='valid';s.reason=null;s.count=observation.count;
    const p=r.region_state,sample=sampleOf(f,observation);
    const matches=p.operator==='count_below'?observation.count<p.threshold:observation.count>=p.threshold;
    if(matches&&s.episode_id){
      s.phase='active';s.window=null;
      // Materialization only extends last_seen_at; no new fact or review work.
      active.push({episode_id:s.episode_id,last_seen_at:f.captured_at});
      continue;
    }
    if(!matches&&!s.episode_id){s.phase='normal';s.window=null;continue;}
    const phase=matches?'pending':'recovering';
    s.phase=phase;
    const window=advanceWindow(s,phase,sample),required=matches?p.duration_ms:p.recovery_ms;
    if(window.sample_count===1)capture(sample);
    if(window.sample_count>=2&&BigInt(window.elapsed_ns)>=BigInt(required)*nsPerMs){
      if(matches){
        const event=makeRegionEvent(r,f,s,window,sample);
        s.episode_id=event.episode_id;s.phase='active';events.push(event);
        for(const evidence of event.analysis_evidence.review_context.samples)capture(evidence);
      }else{
        end(s,'condition_cleared');s.episode_id=null;s.phase='normal';
      }
      s.window=null;
    }else window.last=sample;
  }
  for(const [id,s] of Object.entries(previous))if(!configured.has(id))end(s,'configuration_changed');
  cp.region_states=next;
  return {events,ended,active,issues,captureIntents};
}
