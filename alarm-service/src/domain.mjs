// Copyright AINVR. Transport-neutral alarm domain contracts.
import { createHash } from 'node:crypto';
import { validatePoints } from './geometry.mjs';
import {normalizeSchedule} from './schedule.mjs';

// Bumped when behavior judgement changes; recorded on every fact so statistics can tell eras apart.
export const ENGINE_SEMANTICS='2026-11-10.group-simultaneous-tolerance';
export class DomainError extends Error {
  constructor(code, message, status=422) { super(message); this.code=code; this.status=status; }
}
export function fail(code, message, status=422) { throw new DomainError(code,message,status); }
export function identity(v, field) {
  if (typeof v!=='string' || !v.trim() || v.length>256 || /[\x00-\x1f]/.test(v)) fail('invalid_identity',field);
  return v;
}
export function integerText(v, field) {
  if (typeof v!=='string' || !/^(0|[1-9][0-9]{0,19})$/.test(v)) fail('invalid_integer',field);
  return BigInt(v);
}
function range(v,min,max,field) { if(!Number.isFinite(v)||v<min||v>max) fail('invalid_range',field); }
// Trigger rules: one behavior per trigger, one rule per bound channel. Directions are
// zone edge indexes (empty = any); approach is measured in source pixels.
export const TRIGGER_BEHAVIORS=['appearance','region_approach','region_enter','region_traverse'];
export const REGION_STATE_SEMANTICS='region-state-v1';
function validateRegionRule(r){
  if(r.region_state===undefined)return;
  const s=r.region_state,keys=['operator','threshold','duration_ms','recovery_ms','event_kind','max_gap_ms'];
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!keys.includes(k))||
    !['count_below','count_at_least','presence'].includes(s.operator)||
    !Number.isSafeInteger(s.threshold)||s.threshold<1||s.threshold>4096||
    !Number.isSafeInteger(s.duration_ms)||s.duration_ms<100||s.duration_ms>3600000||
    !Number.isSafeInteger(s.recovery_ms)||s.recovery_ms<100||s.recovery_ms>3600000)
    fail('invalid_region_state','Invalid bounded region condition');
  s.max_gap_ms??=1500;
  if(!Number.isSafeInteger(s.max_gap_ms)||s.max_gap_ms<100||s.max_gap_ms>5000)
    fail('invalid_region_state','max_gap_ms must be 100..5000');
  const countKind=s.event_kind==='region_count'||(s.event_kind==='region_absence'&&s.operator==='count_below'&&s.threshold===1);
  if(s.operator==='presence'?(s.threshold!==1||!['fire_smoke','helmet_violation','suspected_down'].includes(s.event_kind)):!countKind)
    fail('invalid_region_state','Event kind must match the region condition');
  if(r.behavior!=='appearance'||!r.alarm_enabled||r.counter_id!==undefined||r.group!==undefined||
    r.passage!==undefined||r.spatial_semantics!==undefined||r.duration_ms!==0||r.entry_edges.length||r.exit_edges.length)
    fail('invalid_region_state','Region conditions cannot change counters or combine target/direction conditions');
  if(r.review?.enabled===true)fail('invalid_review','Region conditions require manual review; automatic review is not supported');
  if(r.event_kind!==undefined&&r.event_kind!==s.event_kind)fail('invalid_region_state','Conflicting event_kind');
  r.event_kind=s.event_kind;
  if(r.zone_id==null)fail('invalid_geometry','Region conditions require an explicitly bound zone');
  identity(r.zone_id,'zone_id');if(!Number.isSafeInteger(r.zone_version)||r.zone_version<1)fail('invalid_version','zone_version');
}
export function validateRule(input) {
  const r=structuredClone(input);
  if(r.view_not_before!==undefined&&(typeof r.view_not_before!=='string'||!Number.isFinite(Date.parse(r.view_not_before))))fail('invalid_view_not_before','view_not_before');
  if(r.view_epoch!==undefined&&(typeof r.view_epoch!=='string'||!/^[a-f0-9]{64}$/.test(r.view_epoch)))fail('invalid_view_epoch','view_epoch');
  r.alarm_enabled??=true;
  if(typeof r.alarm_enabled!=='boolean')fail('invalid_alarm_policy','alarm_enabled');
  if(r.input_stream_id!==undefined)identity(r.input_stream_id,'input_stream_id');
  identity(r.id,'id'); identity(r.channel_id,'channel_id'); identity(r.name,'name');
  r.trigger_id??=r.id; identity(r.trigger_id,'trigger_id');
  if(r.assignment_id!==undefined){
    identity(r.assignment_id,'assignment_id');
    if(r.assignment_id!==r.id)fail('invalid_assignment','Execution ID must equal assignment ID');
    if(!Number.isSafeInteger(r.trigger_version)||r.trigger_version<1)fail('invalid_version','trigger_version');
    if(r.zone_id!=null){
      identity(r.zone_id,'zone_id');
      if(!Number.isSafeInteger(r.zone_version)||r.zone_version<1)fail('invalid_version','zone_version');
    }else if(r.zone_version!=null||r.behavior!=='appearance')fail('invalid_geometry','A zone is required');
  }
  if(!Number.isSafeInteger(r.version)||r.version<1) fail('invalid_version','version');
  if(!TRIGGER_BEHAVIORS.includes(r.behavior)) fail('unsupported_behavior','behavior');
  if(r.incident_policy!==undefined&&(r.incident_policy!=='condition-v1'||r.behavior==='region_traverse'||!r.alarm_enabled||r.erp_wrap||r.entry_edges?.length||r.exit_edges?.length))fail('invalid_incident_policy','Condition episodes require unrestricted non-traversal alarms');
  if(!['draft','enabled','paused','archived'].includes(r.state)) fail('invalid_state','state');
  if(!Array.isArray(r.label_ids)||!r.label_ids.length||r.label_ids.length>128) fail('invalid_labels','label_ids');
  if(r.group!==undefined){
    const g=r.group;
    if(!g||!['any','all'].includes(g.labels)||!Number.isInteger(g.minimum)||g.minimum<1||g.minimum>16||
       !Number.isInteger(g.window_ms)||g.window_ms<0||g.window_ms>60000||!r.alarm_enabled||
       (g.labels==='all'&&r.label_ids.length>16)||(g.minimum===1&&(g.labels==='any'||r.label_ids.length<2)))fail('invalid_group','Invalid group trigger');
  }
  r.label_ids.forEach(v=>identity(v,'label_id'));
  identity(r.geometry_revision,'geometry_revision'); identity(r.label_map_version,'label_map_version');
  if(r.source_binding!=null){
    const b=r.source_binding;
    if(typeof b!=='object'||Array.isArray(b)||typeof b.stream_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(b.stream_fingerprint)||
      b.input_stream_id!==r.input_stream_id||b.geometry_revision!==r.geometry_revision||b.label_map_version!==r.label_map_version||
      !Number.isSafeInteger(b.width)||!Number.isSafeInteger(b.height)||b.width<1||b.height<1||b.width>32768||b.height>32768||
      typeof b.not_before!=='string'||!Number.isFinite(Date.parse(b.not_before)))fail('invalid_source_binding','Frozen source binding is invalid');
  }
  if(r.erp_wrap!==undefined&&typeof r.erp_wrap!=='boolean')fail('invalid_geometry','Invalid ERP topology');
  if(r.erp_wrap&&r.zone_id==null)fail('invalid_geometry','ERP topology requires a zone');
  if(r.passage!==undefined){
    const p=r.passage;
    if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['kind','edges','max_gap_ms'].includes(k))||
      !['zone','line','gates'].includes(p.kind)||!Number.isInteger(p.max_gap_ms)||p.max_gap_ms<0||p.max_gap_ms>2000||
      r.behavior!=='region_traverse'||r.alarm_enabled!==false||r.erp_wrap)fail('invalid_passage','Statistics passage policy is invalid');
    if(p.kind==='zone'){if(p.edges!==undefined)fail('invalid_passage','Zone has no gates');}
    else if(!Array.isArray(p.edges)||p.edges.length!==(p.kind==='line'?1:2)||new Set(p.edges).size!==p.edges.length||
      p.edges.some(e=>!Number.isInteger(e)||e<0||e>=(r.points?.length??0)))fail('invalid_passage','Select distinct existing gate edges');
    if(r.entry_edges?.length||r.exit_edges?.length||r.duration_ms>0)fail('invalid_passage','Shared passage collector must be unrestricted');
  }
  if(r.spatial_semantics!==undefined&&(r.spatial_semantics!=='bbox-state-v1'||!['region_enter','region_approach'].includes(r.behavior)||r.entry_edges?.length||r.exit_edges?.length))fail('invalid_spatial_semantics','State rules do not have crossing directions');
  r.anchor ??= 'bottom_center';
  if(!['bottom_center','center'].includes(r.anchor)) fail('invalid_anchor','anchor');
  r.duration_ms ??= 0; range(r.duration_ms,0,3600000,'duration_ms');
  // Internal stability settings, not user parameters.
  r.hysteresis ??= 0.01; r.rearm_ms ??= 3000;
  if(r.hysteresis_px!==undefined)range(r.hysteresis_px,0.5,64,'hysteresis_px');
  range(r.hysteresis,0.0001,0.2,'hysteresis'); range(r.rearm_ms,1,3600000,'rearm_ms');
  r.entry_edges ??= []; r.exit_edges ??= [];
  validateRegionRule(r);
  if(r.behavior==='appearance'){
    if(r.entry_edges.length||r.exit_edges.length) fail('invalid_direction','Appearance has no direction');
    if((r.assignment_id!==undefined||r.region_state!==undefined)&&r.zone_id!=null){
      try {validatePoints(r.points,false,r.erp_wrap===true);}catch(e){fail('invalid_geometry',e.message);}
    }else{
      // Legacy rules retain their original whole-frame meaning until migrated.
      delete r.points; r.zone_id=null; r.zone_version=null;
    }
  } else {
    try { validatePoints(r.points,false,r.erp_wrap===true); } catch(e) { fail('invalid_geometry',e.message); }
    const edge=v=>Number.isInteger(v)&&v>=0&&v<r.points.length;
    if(!Array.isArray(r.entry_edges)||!Array.isArray(r.exit_edges)||![...r.entry_edges,...r.exit_edges].every(edge)||
      new Set(r.entry_edges).size!==r.entry_edges.length||new Set(r.exit_edges).size!==r.exit_edges.length||
      r.entry_edges.some(e=>r.exit_edges.includes(e))||(r.behavior!=='region_traverse'&&r.exit_edges.length))fail('invalid_direction','Direction edges are invalid for this zone or behavior');
  }
  if(r.behavior==='region_approach'){
    if(r.assignment_id!==undefined){
      range(r.approach_width_percent,Number.MIN_VALUE,100,'approach_width_percent');
      if(!r.source_binding)fail('invalid_source_binding','Percentage distance requires source dimensions');
      const expected=r.source_binding.width*r.approach_width_percent/100;
      if(!Number.isFinite(r.approach_px)||Math.abs(r.approach_px-expected)>1e-8)fail('invalid_range','approach_px must match the source width percentage');
    }else{
      if(!Number.isInteger(r.approach_px))fail('invalid_range','approach_px');
      range(r.approach_px,1,4000,'approach_px');
    }
  }
  else if(r.approach_px!==undefined) fail('invalid_range','approach_px is only for approach');
  if(r.behavior!=='region_approach'&&r.approach_width_percent!==undefined)fail('invalid_range','Percentage is only for approach');
  r.severity ??= 'warning'; if(!['info','warning','critical'].includes(r.severity)) fail('invalid_severity','severity');
  // Validate the execution policy before publishing or storing a rule.
  try{r.schedule=normalizeSchedule(r.schedule);}catch(e){fail('invalid_schedule',e.message);}
  r.review ??= {enabled:false};
  if(typeof r.review.enabled!=='boolean') fail('invalid_review','review.enabled');
  if(r.review.enabled) {
    identity(r.review.profile_id,'review.profile_id');
    if(r.alarm_enabled===false||r.review.profile_id!=='alarm-review-zh-v1'||!Number.isSafeInteger(r.review.version)||r.review.version<1||
      typeof r.review.description!=='string'||!r.review.description.trim()||r.review.description.length>500||r.review.description.includes('<|')||
      !Number.isFinite(r.review.reject_below)||r.review.reject_below<0||r.review.reject_below>0.1||
      !Number.isFinite(r.review.approve_above)||r.review.approve_above<0.9||r.review.approve_above>1)fail('invalid_review','Invalid image review policy');
  }
  return r;
}
export function validateFrame(input) {
  const f=structuredClone(input);
  if(f.schema_version!=='1.0') fail('unsupported_schema','schema_version');
  if(f.evidence_delivery!==undefined&&(f.evidence_delivery?.schema_version!==2||!['durable','failed'].includes(f.evidence_delivery.state)))fail('invalid_evidence_delivery','evidence_delivery');
  for(const k of ['channel_id','input_stream_id','stream_session_id','frame_id']) identity(f[k],k);
  integerText(f.seq,'seq'); integerText(f.source_pts_ns,'source_pts_ns');
  if(f.source_frame_index!==undefined)integerText(f.source_frame_index,'source_frame_index');
  if(typeof f.captured_at!=='string'||!Number.isFinite(Date.parse(f.captured_at))) fail('invalid_time','captured_at');
  if(!f.source||!Number.isSafeInteger(f.source.width)||!Number.isSafeInteger(f.source.height)) fail('invalid_dimensions','source');
  range(f.source.width,1,32768,'width');range(f.source.height,1,32768,'height');
  if(f.source.coordinate_space!=='source_pixels') fail('invalid_coordinates','coordinate_space');
  identity(f.source.geometry_revision,'geometry_revision'); identity(f.model?.label_map_version,'label_map_version');
  if(f.model.compatible_label_versions!==undefined){const rows=f.model.compatible_label_versions;if(!Array.isArray(rows)||rows.length>4)fail('invalid_model','compatible_label_versions');for(const row of rows){identity(row.version,'compatible_label_version');if(!Array.isArray(row.label_ids)||!row.label_ids.length||row.label_ids.length>128)fail('invalid_model','compatible_label_ids');for(const id of row.label_ids)identity(id,'label_id');}}
  if(f.observation_mode!==undefined&&!['tracks','detections'].includes(f.observation_mode))fail('invalid_observation','mode');
  if(f.observation_status!==undefined&&!['valid','unknown'].includes(f.observation_status))fail('invalid_observation','observation_status');
  if(f.source_pts_valid!==undefined&&typeof f.source_pts_valid!=='boolean')fail('invalid_observation','source_pts_valid');
  if(f.attribute_delivery!==undefined){
    const delivery=f.attribute_delivery;
    if(!delivery||typeof delivery!=='object'||Array.isArray(delivery)||delivery.state!=='omitted'||delivery.reason!=='observation_capacity'||
      !Number.isSafeInteger(delivery.targets)||delivery.targets<1||delivery.targets>4096||Object.keys(delivery).some(k=>!['state','reason','targets'].includes(k)))
      fail('invalid_observation','attribute_delivery');
  }
  if(f.region_observations!==undefined){
    if(!f.region_observations||typeof f.region_observations!=='object'||Array.isArray(f.region_observations)||Object.keys(f.region_observations).length>16)fail('invalid_observation','region_observations');
    for(const [kind,o] of Object.entries(f.region_observations)){
      identity(kind,'event_kind');
      if(!o||typeof o!=='object'||Array.isArray(o)||!['valid','unknown'].includes(o.state))fail('invalid_observation','region_observation.state');
      if(o.reason!==undefined&&(typeof o.reason!=='string'||!o.reason.length||Buffer.byteLength(o.reason,'utf8')>128||/[\x00-\x1f\x7f]/.test(o.reason)))fail('invalid_observation','region_observation.reason');
      if(o.state==='valid'){
        integerText(o.source_pts_ns,'region_observation.source_pts_ns');
        if(!Array.isArray(o.label_ids)||!o.label_ids.length||o.label_ids.length>128)fail('invalid_observation','region_observation.label_ids');
        o.label_ids.forEach(id=>identity(id,'label_id'));
      }
    }
  }
  // Capacity shedding is never a negative pose observation, even if an older
  // producer omits or accidentally leaves its per-capability attestation valid.
  if(f.attribute_delivery?.state==='omitted'){
    f.region_observations??={};
    f.region_observations.suspected_down={...f.region_observations.suspected_down,state:'unknown',reason:'attribute_capacity'};
  }
  if(!Array.isArray(f.tracks)||f.tracks.length>4096) fail('invalid_tracks','tracks');
  const ids=new Set();
  for(const t of f.tracks) {
    identity(t.track_id,'track_id');identity(t.label_id,'label_id');
    if(f.observation_mode==='detections'&&(t.identity_kind!=='detection'||t.observation!=='detected'))fail('invalid_observation','detections cannot claim tracking');
    if(f.observation_mode!=='detections'&&t.identity_kind==='detection')fail('invalid_observation','detection identity cannot count');
    if(ids.has(t.track_id)) fail('duplicate_track','track_id'); ids.add(t.track_id);
    if(!['confirmed','tentative'].includes(t.state)||!['detected','lost','predicted'].includes(t.observation)) fail('invalid_observation','track');
    integerText(t.last_observed_pts_ns,'last_observed_pts_ns');
    if(BigInt(t.last_observed_pts_ns)>BigInt(f.source_pts_ns)) fail('future_observation','last_observed_pts_ns');
    if(t.observation==='detected'&&t.last_observed_pts_ns!==f.source_pts_ns) fail('mismatched_observation','last_observed_pts_ns');
    const b=t.bbox;
    if(!b||['x','y','w','h'].some(k=>!Number.isFinite(b[k]))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>f.source.width+0.001||b.y+b.h>f.source.height+0.001) fail('invalid_bbox','bbox');
    if(t.event_eligible!==undefined&&typeof t.event_eligible!=='boolean')fail('invalid_observation','event_eligible');
    if(t.source_node!==undefined)identity(t.source_node,'source_node');
    if(t.attributes!==undefined){
      let encoded;
      try{encoded=JSON.stringify(t.attributes);}catch{fail('invalid_attributes','Attributes must be bounded JSON');}
      if(!t.attributes||typeof t.attributes!=='object'||Array.isArray(t.attributes)||Buffer.byteLength(encoded??'','utf8')>2048)
        fail('invalid_attributes','Attributes must be an object of at most 2048 UTF-8 JSON bytes');
    }
    if(t.confidence!=null) range(t.confidence,0,1,'confidence');
  }
  return f;
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function makeAlarm(rule,frame,track,firstSeq,direction=null) {
  const key=digest([rule.id,rule.version,frame.channel_id,frame.stream_session_id,track.track_id,rule.behavior,firstSeq]);
  return {schema_version:'1.0',alarm_id:key,dedup_key:key,channel_id:frame.channel_id,input_stream_id:frame.input_stream_id,
    stream_session_id:frame.stream_session_id,track_ids:[track.track_id],trigger_id:rule.trigger_id??rule.id,rule:{id:rule.id,version:rule.version,name:rule.name,snapshot:structuredClone(rule)},
    behavior:rule.behavior,severity:rule.severity,occurred_at:frame.captured_at,last_seen_at:frame.captured_at,
    source_pts_ns:frame.source_pts_ns,frame_id:frame.frame_id,direction,model_snapshot:structuredClone(frame.model),
    analysis_evidence:{...(frame.evidence_delivery?{delivery:structuredClone(frame.evidence_delivery)}:{}),observation_mode:frame.observation_mode??'tracks',engine_semantics:ENGINE_SEMANTICS,first_seq:firstSeq,trigger_seq:frame.seq,source_frame_index:frame.source_frame_index??null,track:structuredClone(track),source:structuredClone(frame.source)},
    lifecycle:{state:'ended',end_reason:'discrete_trigger'},
    review:rule.review.enabled?{state:'queued',attempt:1,profile_id:rule.review.profile_id,profile_version:rule.review.version}:{state:'skipped',reason:'policy_disabled',attempt:0},
    handling:{state:'unacknowledged',revision:0,disposition:'unset'},evidence:{state:'pending',refs:[]},version:1};
}

export function acknowledge(event,{expected_handling_revision,note='',disposition='handled'},actor,operationId,now) {
  identity(actor,'actor'); identity(operationId,'operation_id');
  if(typeof note!=='string'||note.length>500) fail('invalid_note','note');
  // handled = dealt with; false_positive = not a real event. Statistics keep both.
  if(!['handled','false_positive'].includes(disposition)) fail('invalid_disposition','disposition');
  if(!Number.isSafeInteger(expected_handling_revision)||expected_handling_revision<0) fail('invalid_version','expected_handling_revision');
  if(event.handling.state==='acknowledged'&&event.handling.reviewed_by_kind!=='ai') return {outcome:'already_acknowledged',event};
  if(event.handling.revision!==expected_handling_revision) fail('version_conflict','Handling changed; refresh before confirming',409);
  const next=structuredClone(event);
  next.handling={...next.handling,state:'acknowledged',revision:next.handling.revision+1,acknowledged_by:actor,acknowledged_at:now,reviewed_by_kind:'human',note,disposition};
  next.version++;
  const log={operation_id:operationId,alarm_id:event.alarm_id,action:disposition==='false_positive'?'false_positive':'acknowledged',actor,at:now,note,disposition};
  return {outcome:'succeeded',event:next,log};
}
export function pending(event) {
  return event.handling.state==='unacknowledged' && event.handling.disposition!=='false_positive';
}

export function matchesLabelVersion(frame,rule){
 return rule.label_map_version===frame.model.label_map_version || (frame.model.compatible_label_versions??[]).some(c=>c.version===rule.label_map_version&&rule.label_ids.every(id=>c.label_ids.includes(id)));
}
