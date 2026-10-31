// Copyright AINVR. Bounded, checkpointed region visits from existing observations.
import {digest,validateRule} from './domain.mjs';
import {inside} from './geometry.mjs';
import {unwrapErp,liftErp} from './erp-geometry.mjs';
import {crossesBoundary} from './traversal.mjs';
import {createScheduleEvaluator} from './schedule.mjs';
import {MAX_DWELL_INTERVALS,observedIntervals} from './dwell-intervals.mjs';

const MAX_ZONES=128, MAX_VISITS=512, MAX_PAIRS=32768, MAX_VISIT_MS=3600000;
const MAX_GAP_MS=1500;
const key=(...v)=>JSON.stringify(v);

// Only statistics rules supply the subscription. Several counters using the
// same zone contribute labels to a single visit, never duplicate facts.
function regions(frame,rules,issues){
  const groups=new Map(),period=createScheduleEvaluator(frame.captured_at);
  for(const raw of rules){
    if(raw.alarm_enabled!==false||raw.state!=='enabled'||raw.channel_id!==frame.channel_id||raw.behavior!=='region_traverse'||!raw.zone_id)continue;
    const r=validateRule(raw);
    if(r.alarm_enabled!==false||r.state!=='enabled'||r.channel_id!==frame.channel_id||
       r.behavior!=='region_traverse'||!r.zone_id||!Number.isSafeInteger(r.zone_version)||!r.points)continue;
    if(r.geometry_revision!==frame.source.geometry_revision||r.label_map_version!==frame.model.label_map_version||
       (r.input_stream_id!==undefined&&r.input_stream_id!==frame.input_stream_id)||
       (r.view_not_before&&Date.parse(frame.captured_at)<Date.parse(r.view_not_before))||
       (r.source_binding&&Date.parse(frame.captured_at)<Date.parse(r.source_binding.not_before)))continue;
    const window=period(r.schedule);if(window===null)continue;
    const id=key(r.zone_id,r.zone_version),signature=key(r.points,r.anchor,r.erp_wrap===true,r.geometry_revision,r.view_epoch??null,frame.model.label_map_version,frame.input_stream_id,frame.source.width,frame.source.height);
    let group=groups.get(id);
    if(!group){group={id,zone_id:r.zone_id,zone_version:r.zone_version,signature,points:r.erp_wrap?unwrapErp(r.points):r.points,
      anchor:r.anchor,erp_wrap:r.erp_wrap===true,geometry_revision:r.geometry_revision,view_epoch:r.view_epoch??null,labels:new Map()};groups.set(id,group);}
    if(group.signature!==signature){group.conflict=true;continue;}
    for(const label of r.label_ids){const windows=group.labels.get(label)??[];windows.push(key(r.id,r.version,window));group.labels.set(label,windows);}
  }
  const versions=new Map();
  for(const group of groups.values()){
    const set=versions.get(group.zone_id)??new Set();set.add(group.zone_version);versions.set(group.zone_id,set);
  }
  const result=[];
  for(const group of groups.values()){
    if(group.conflict||versions.get(group.zone_id).size>1){issues.push('dwell_region_conflict');continue;}
    for(const windows of group.labels.values())windows.sort();
    if(result.length>=MAX_ZONES){issues.push('dwell_region_capacity');break;}result.push(group);
  }
  return result;
}
function close(state,reason,facts){
  if(state._blocked)return;
  const {_point,_pts,_wall,_rule_signature,_interrupted,...fact}=state;
  facts.push({...fact,end_reason:reason,partial:true});
}
function addTime(visit,start,end){
  const spans=visit.observed_intervals,last=spans.at(-1);
  if(last?.[1]===start)last[1]=end;
  else {if(spans.length>=MAX_DWELL_INTERVALS)return false;spans.push([start,end]);}
  visit.observed_ms+=end-start;
  return true;
}
const signatureOf=(z,label)=>z.labels.has(label)?key(z.signature,z.labels.get(label),label):null;
const elapsed=(v,frame,wall)=>({ms:Number(BigInt(frame.source_pts_ns)-BigInt(v._pts))/1e6,wallMs:wall-v._wall});
const invalidGap=({ms,wallMs})=>ms<=0||ms>MAX_GAP_MS||wallMs<=0||Math.abs(ms-wallMs)>250;
function suppress(v,frame,wall,point){return {_blocked:true,_point:point??v._point,_pts:frame.source_pts_ns,_wall:wall,_rule_signature:v._rule_signature,label_id:v.label_id,start_ms:v.start_ms};}
export function dwellStep(previous,frame,rules,{gap=false,restart=false,previous:checkpoint=null,onPair=()=>{},onRegions=()=>{}}={}){
  if(previous?.disabled_session===frame.stream_session_id)return {state:{disabled_session:frame.stream_session_id},facts:[],issues:['dwell_capacity']};
  if(previous?.disabled_session)previous=null;
  const state=structuredClone(previous??{visits:{}}),facts=[],issues=[];state.visits??={};
  const visits=state.visits,wall=Date.parse(frame.captured_at),prev=checkpoint;
  const reset=restart?'consumer_restart':prev?.session&&prev.session!==frame.stream_session_id?'session_changed':
    prev?.pts!=null&&BigInt(frame.source_pts_ns)<=BigInt(prev.pts)?'pts_reset':
    gap||frame.gap||prev?.seq!=null&&BigInt(frame.seq)!==BigInt(prev.seq)+1n?'input_gap':null;
  if(reset)for(const [id,v] of Object.entries(visits)){
    // A restart immediately after a prepared first observation must not
    // manufacture another zero-duration visit on each recovery.
    if(reset==='consumer_restart'&&!v._blocked&&v.observed_ms===0)issues.push('dwell_restart_unmeasured');
    else close(v,reset,facts);
    delete visits[id];
  }
  const zones=regions(frame,rules,issues),active=new Set(),zoneIndex=new Map(zones.map(z=>[z.id,z])),trackIndex=new Map(frame.tracks.map(t=>[t.track_id,t]));let pairs=0,overflow=false;
  onRegions(zones);
  // Upgrade a continuous checkpoint once, before it can acquire holes.
  for(const [id,v] of Object.entries(visits))if(!v._blocked&&v.observed_intervals===undefined){
    const spans=observedIntervals(v);
    if(spans===null){close(v,'invalid_intervals',facts);delete visits[id];issues.push('dwell_invalid_intervals');}
    else {v.observed_intervals=spans;delete v.minutes;}
  }
  if(frame.observation_mode==='detections')issues.push('dwell_tracking_required');
  else for(const t of frame.tracks){
    if(t.state!=='confirmed'||t.observation!=='detected'||t.event_eligible===false)continue;
    for(const z of zones){
      const labels=z.labels.get(t.label_id);if(!labels)continue;
      if(++pairs>MAX_PAIRS){overflow=true;break;}
      const id=key(frame.channel_id,frame.stream_session_id,t.track_id,z.zone_id,z.zone_version),old=visits[id];
      const b=t.bbox,p0=[(b.x+b.w/2)/frame.source.width,(b.y+b.h*(z.anchor==='center'?.5:1))/frame.source.height];
      const p=z.erp_wrap?liftErp(p0,z.points):p0,inRegion=inside(z.points,p);
      const signature=signatureOf(z,t.label_id);
      let v=old;
      // Once a very long visit reaches its storage budget, suppress it until
      // departure or interruption rather than inventing a second visit.
      if(v?._blocked){if(inRegion&&v._rule_signature===signature&&!invalidGap(elapsed(v,frame,wall))){
        if(!v._interrupted&&v._point&&!crossesBoundary(z.points,v._point,p))onPair({zone:z,label_id:t.label_id,from_ms:v._wall,to_ms:wall,point:v._point});
        Object.assign(v,suppress(v,frame,wall,p));delete v._interrupted;active.add(id);continue;
      }delete visits[id];v=null;}
      if(v&&v._rule_signature!==signature){close(v,'configuration_changed',facts);delete visits[id];v=null;}
      if(v){
        if(invalidGap(elapsed(v,frame,wall))||wall-v.start_ms>MAX_VISIT_MS){
          const limited=wall-v.start_ms>MAX_VISIT_MS;
          close(v,limited?'duration_limit':'observation_gap',facts);delete visits[id];v=null;
          if(limited&&inRegion){
            if(!old._interrupted&&!invalidGap(elapsed(old,frame,wall))&&!crossesBoundary(z.points,old._point,p))onPair({zone:z,label_id:t.label_id,from_ms:old._wall,to_ms:wall,point:old._point});
            visits[id]=suppress(old,frame,wall,p);active.add(id);issues.push('dwell_duration_limit');continue;
          }
        }
      }
      if(v&&(!inRegion||(!v._interrupted&&crossesBoundary(z.points,v._point,p)))){close(v,inRegion?'ambiguous_geometry':'observed_exit',facts);delete visits[id];v=null;}
      if(!inRegion)continue;
      if(v){
        // Retain identity across a short coast, never its elapsed time. A new
        // interval starts only at the next pair of adjacent real detections.
        if(!v._interrupted)onPair({zone:z,label_id:t.label_id,from_ms:v._wall,to_ms:wall,point:v._point});
        if(!v._interrupted&&!addTime(v,v._wall,wall)){
          close(v,'interval_limit',facts);visits[id]=suppress(v,frame,wall,p);active.add(id);issues.push('dwell_interval_limit');continue;
        }
        delete v._interrupted;v._pts=frame.source_pts_ns;v._wall=wall;v._point=p;v.ended_at=frame.captured_at;v.last_frame_id=frame.frame_id;
      }
      if(!v){
        if(Object.keys(visits).length>=MAX_VISITS){overflow=true;continue;}
        v={_id:digest(['dwell-v1',id,frame.seq]),channel_id:frame.channel_id,input_stream_id:frame.input_stream_id,
          stream_session_id:frame.stream_session_id,track_id:t.track_id,label_id:t.label_id,label_map_version:frame.model.label_map_version,zone_id:z.zone_id,zone_version:z.zone_version,
          geometry_revision:z.geometry_revision,view_epoch:z.view_epoch,started_at:frame.captured_at,ended_at:frame.captured_at,start_ms:wall,
          observed_ms:0,observed_intervals:[],interval_semantics:'adjacent_eligible_detections',first_frame_id:frame.frame_id,last_frame_id:frame.frame_id,
          _point:p,_pts:frame.source_pts_ns,_wall:wall,_rule_signature:signature};visits[id]=v;
      }
      active.add(id);
    }
    if(overflow)break;
  }
  if(overflow)issues.push('dwell_capacity');
  for(const [id,v] of Object.entries(visits))if(!active.has(id)){
    const [,session,track,zone,version]=JSON.parse(id);
    const z=zoneIndex.get(key(zone,version)),t=trackIndex.get(track);
    const changed=session!==frame.stream_session_id||!z||signatureOf(z,v.label_id)!==v._rule_signature||(t&&t.label_id!==v.label_id);
    let reason=overflow?'capacity':frame.observation_mode==='detections'?'tracking_unavailable':changed?'configuration_changed':null;
    if(!reason&&(v._pts===undefined||invalidGap(elapsed(v,frame,wall))))reason='observation_gap';
    if(!reason&&!v._blocked&&wall-v.start_ms>MAX_VISIT_MS)reason='duration_limit';
    if(reason){close(v,reason,facts);delete visits[id];}
    else {v._interrupted=true;if(!v._blocked)v.observation_gaps=true;}
  }
  return {state,facts,issues};
}

// $setOnInsert plus deterministic _id makes every prepared replay idempotent.
export async function materializeDwell(db,facts,hook=async()=>{}){
  if(!db)throw Error('Dwell facts require repository.db');
  const collection=db.collection('region_dwell_visits');
  await collection.bulkWrite(facts.map(fact=>({updateOne:{filter:{_id:fact._id},update:{$setOnInsert:fact},upsert:true}})),{ordered:false,timeoutMS:750,maxTimeMS:700});
  await hook('dwell_inserted');
}
