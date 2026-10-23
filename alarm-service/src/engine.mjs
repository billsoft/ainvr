import {sampleOf,beginEvidence,sealEvidence} from './compact-evidence.mjs';
// Copyright AINVR. Pure, checkpointable trigger evaluator. No model execution.
import {holdPassage,restorePassage} from './passage-continuity.mjs';
import {coverageStep} from './flow-coverage.mjs';
import {unwrapErp,liftErp} from './erp-geometry.mjs';
import {boundaryDistance,boundaryDistancePx,inside} from './geometry.mjs';
import {makeAlarm,validateFrame,validateRule,fail,digest} from './domain.mjs';
import {traversalStep,regionDirection,crossesBoundary} from './traversal.mjs';
import {createScheduleEvaluator} from './schedule.mjs';

const ruleCache=new Map(),geometryCache=new WeakMap(),labelsCache=new WeakMap();
function preparedRule(raw){
  const key=digest(raw);let r=ruleCache.get(key);
  if(!r){r=validateRule(raw);if(ruleCache.size>=256)ruleCache.delete(ruleCache.keys().next().value);ruleCache.set(key,r);
    geometryCache.set(r,r.erp_wrap?{...r,points:unwrapErp(r.points)}:r);labelsCache.set(r,new Set(r.label_ids));}
  return r;
}
const elapsedMs=(f,since)=>Number(BigInt(f.source_pts_ns)-BigInt(since))/1e6;
// Alarm geometry stays strict. Statistics can retain observed endpoints across a
// bounded same-ID coast; predictions never become geometric evidence.
function breakEvidence(state) {
  delete state.seen_since; // A journal gap is not proof of continuous appearance.
  delete state.review_trace;delete state.review_trace_truncated;delete state.review_compact;delete state.review_outside;delete state.approach_pause;delete state.last_approach_pts;
  delete state.entry_origin_point;delete state.side; delete state.traversal; delete state.match; delete state.candidate;
  delete state.unmatched_since; delete state.observedPoint; delete state.triggerDirection; delete state.out_since;
  delete state.passage_observation;delete state.passage_pending;state.interrupted=true;
}
// Frame-rate adaptive continuity: a pause longer than 4x the recent median frame
// interval (at least 1.5 s) is a gap. Long intervals are recorded too, so a channel
// that runs slowly becomes the new baseline within a few frames.
const INTERVALS=8;
function continuityLimitMs(cp){
  const recent=[...(cp.intervals??[])].sort((a,b)=>a-b);
  return recent.length?Math.max(1500,4*recent[Math.floor(recent.length/2)]):Infinity;
}
const allowedEdge=(edge,edges)=>!edges.length||(Number.isInteger(edge)&&edges.includes(edge));
// Persist canonical ERP coordinates; only the evaluator's private state is unwrapped.
const canonicalPoint=p=>p==null?p:[((p[0]%1)+1)%1,p[1]];
const canonicalDirection=(r,d)=>r.erp_wrap&&d?.boundary_point?{...d,boundary_point:canonicalPoint(d.boundary_point)}:d;


export function evaluate(checkpoint,input,rules) {
  const f=validateFrame(input),out=[],issues=[],ended=[],captureIntents=[];
  const cp=structuredClone(checkpoint??{session:null,seq:null,pts:null});
  cp.states??={};cp.episodes??={};cp.first_seen??={};
  const sessionChanged=cp.session!==f.stream_session_id;
  if(!sessionChanged&&cp.seq!==null&&BigInt(f.seq)<=BigInt(cp.seq))return {checkpoint:cp,events:[],ended_episodes:[],issues:['duplicate_or_old_seq']};
  const seqGap=!sessionChanged&&cp.seq!==null&&BigInt(f.seq)!==BigInt(cp.seq)+1n;
  const ptsReset=!sessionChanged&&cp.pts!==null&&BigInt(f.source_pts_ns)<=BigInt(cp.pts);
  const interval=!sessionChanged&&!ptsReset&&cp.pts!==null?Number(BigInt(f.source_pts_ns)-BigInt(cp.pts))/1e6:null;
  const timeGap=interval!==null&&interval>continuityLimitMs(cp);
  if(interval!==null)cp.intervals=[...(cp.intervals??[]),interval].slice(-INTERVALS);
  if(sessionChanged||ptsReset){
    for(const e of Object.values(cp.episodes))ended.push({episode_id:e.id,ended_at:f.captured_at,end_reason:sessionChanged?'session_changed':'pts_reset'});
    cp.states={};cp.episodes={};cp.first_seen={};delete cp.intervals;
  }
  if(seqGap||ptsReset||timeGap||f.gap===true){
    issues.push('input_gap');
    // The same ID across a few dropped records is still the same target; a long pause is not.
    for(const s of Object.values(cp.states)){breakEvidence(s);if(timeGap)delete s.seen_since;}
  }
  cp.session=f.stream_session_id;cp.seq=f.seq;cp.pts=f.source_pts_ns;
  const atCapture=createScheduleEvaluator(f.captured_at),periods=new Map(),eligible=new Map(),channelRules=[];
  for(const raw of rules){
    const r=preparedRule(raw);let period;
    try{period=atCapture(r.schedule);}catch(e){fail('invalid_time',e.message);}
    periods.set(JSON.stringify([r.id,r.version]),period);
    if(r.channel_id===f.channel_id&&r.state==='enabled'&&r.alarm_enabled!==false)channelRules.push([r.id,r.version,period]);
    if(period===null||r.state!=='enabled'||r.channel_id!==f.channel_id)continue;
    if(r.source_binding&&Date.parse(f.captured_at)<Date.parse(r.source_binding.not_before))continue;
    if(r.input_stream_id!==undefined&&r.input_stream_id!==f.input_stream_id){issues.push(`rule_input_mismatch:${r.id}`);continue;}
    if(r.geometry_revision!==f.source.geometry_revision||r.label_map_version!==f.model.label_map_version){issues.push(`rule_config_mismatch:${r.id}`);continue;}
    eligible.set(JSON.stringify([r.id,r.version]),r);
  }
  // A new active window cannot reuse old dwell or crossing evidence.
  for(const key of Object.keys(cp.states)){
    const [id,version]=JSON.parse(key),ruleKey=JSON.stringify([id,version]);
    if(periods.get(ruleKey)!==(cp.rule_windows?.[ruleKey]??'always'))delete cp.states[key];
  }
  cp.rule_windows=Object.fromEntries(periods);
  delete cp.review_source;
  const present=new Set(f.tracks.map(t=>t.track_id)),{width:W,height:H}=f.source;
  for(const t of f.tracks)cp.first_seen[t.track_id]??=f.captured_at;
  for(const r of eligible.values()) for(const t of f.tracks) {
    const key=JSON.stringify([r.id,r.version,t.track_id]);
    if(t.state!=='confirmed'||!labelsCache.get(r).has(t.label_id)){delete cp.states[key];continue;}
    const detected=t.observation==='detected',evidence=detected&&t.event_eligible!==false;
    // A target that has only been a hidden candidate (low confidence, prediction) has no state.
    if(!cp.states[key]&&!evidence)continue;
    const g=geometryCache.get(r);
    const anchor=p=>r.erp_wrap?liftErp(p,g.points):p;
    const s=cp.states[key]??={first_seq:f.seq,since:f.source_pts_ns,fired:false};
    delete s.review_trace;delete s.review_trace_truncated;
    const sample=r.review.enabled?sampleOf(f,t):null;
    const capture=x=>{if(!x?.event_eligible||captureIntents.length>=128)return;captureIntents.push({channel_id:f.channel_id,stream_session_id:f.stream_session_id,source:f.source,sample:x});};
    const begin=()=>{if(sample){beginEvidence(s,sample);capture(s.review_compact.before);capture(sample);}};
    const remember=()=>{if(sample?.event_eligible){s.review_compact??={};s.review_compact.last=sample;}};
    const attach=event=>{if(sample){event.analysis_evidence.review_context=sealEvidence(event,s,sample,r);if(s.review_unavailable)event.analysis_evidence.review_context.truncated=true;for(const x of event.analysis_evidence.review_context.samples)capture(x);}return event;};
    if(r.behavior==='appearance'){
      // Same ID = same target: real detections and dead-reckoned frames are continuous;
      // a lost frame without a prediction is not. Fire on a real detection (evidence).
      if(!detected&&t.predicted_bbox==null){delete s.seen_since;continue;}
      if(r.zone_id!=null){
        const b=detected?t.bbox:t.predicted_bbox;
        const valid=b&&['x','y','w','h'].every(k=>Number.isFinite(b[k]))&&b.w>0&&b.h>0&&
          b.x>=0&&b.y>=0&&b.x+b.w<=W+.001&&b.y+b.h<=H+.001;
        const inZone=valid&&inside(g.points,anchor([(b.x+b.w/2)/W,(b.y+b.h*(r.anchor==='center'?.5:1))/H]));
        if(!inZone){delete s.seen_since;continue;}
        // Predictions may bridge a previously observed in-zone dwell, but cannot
        // establish entry into the zone or produce an event on their own.
      }
      if(s.seen_since===undefined){if(!evidence)continue;s.seen_since=f.source_pts_ns;s.first_seq=f.seq;begin();}  // the clock starts on a real detection
      if(!s.fired&&evidence&&elapsedMs(f,s.seen_since)>=r.duration_ms){out.push(attach(makeAlarm(r,f,t,s.first_seq,null)));s.fired=true;}
      if(!s.fired)remember();else delete s.review_compact;
      continue;
    }
    if(!evidence){if(r.behavior!=='region_traverse'||!holdPassage(r,f,s))breakEvidence(s);continue;}
    const b=t.bbox;let p=anchor([(b.x+b.w/2)/W,(b.y+b.h*(r.anchor==='center'?0.5:1))/H]);
    // The centre-nearest copy is sufficient for membership, not for distance
    // to an asymmetric polygon. Compare adjacent copies for outside approach.
    if(r.erp_wrap&&r.behavior==='region_approach'&&!inside(g.points,p)){
      p=[p,[p[0]-1,p[1]],[p[0]+1,p[1]]].reduce((best,candidate)=>
        boundaryDistancePx(g.points,candidate,W,H)<boundaryDistancePx(g.points,best,W,H)?candidate:best);
    }
    const previous=s.observedPoint??s.traversal?.previous?.point;
    if(r.erp_wrap&&previous&&Math.abs(p[0]-previous[0])>.5)breakEvidence(s);
    if(s.interrupted){s.since=f.source_pts_ns;delete s.interrupted;}
    const fire=direction=>{out.push(attach(makeAlarm(r,f,t,s.first_seq,canonicalDirection(r,direction))));s.fired=true;};
    if(r.behavior==='region_traverse'){
      if(!restorePassage(r,f,t,p,s)){breakEvidence(s);restorePassage(r,f,t,p,s);issues.push(`passage_gap_rejected:${r.id}:${t.track_id}`);}
      const oldEntry=s.traversal?.entry;
      const tr=traversalStep(g,f,p,s);
      if(!oldEntry&&s.traversal?.entry)begin();
      if(s.traversal_issue){issues.push(`${s.traversal_issue}:${r.id}:${t.track_id}`);delete s.traversal_issue;}
      if(tr&&allowedEdge(tr.entry.edge,r.entry_edges)&&allowedEdge(tr.exit.edge,r.exit_edges)){
        // Counting bindings classify by stable edge ids: a dragged vertex keeps them.
        const ids=r.edge_ids?{entry_edge_id:r.edge_ids[tr.entry.edge]??null,exit_edge_id:r.edge_ids[tr.exit.edge]??null}:{};
        const event=makeAlarm(r,f,t,tr.entry.seq,{...tr.direction,entry_edge:tr.entry.edge,exit_edge:tr.exit.edge,...ids});
        event.analysis_evidence.traversal=r.erp_wrap?{...tr,entry:{...tr.entry,point:canonicalPoint(tr.entry.point),boundary:canonicalPoint(tr.entry.boundary)},exit:{...tr.exit,point:canonicalPoint(tr.exit.point),boundary:canonicalPoint(tr.exit.boundary)}}:tr;event.analysis_evidence.started_at=tr.entry.at;out.push(attach(event));
      }
      // Outside waiting is not part of a future passage. Retain its exact last
      // observation so a new crossing remains reviewable after a long wait.
      if(sample&&!inside(g.points,p)&&!s.traversal?.entry)delete s.review_compact;
    } else if(r.behavior==='region_enter') {
      const inRegion=inside(g.points,p),stable=boundaryDistance(g.points,p)>=r.hysteresis?(inRegion?'in':'out'):null;
      // A concave shortcut cannot prove continuous dwell or a new entry edge.
      // Preserve the fired latch; require fresh outside evidence for a new candidate.
      if(stable==='in'&&s.candidate&&s.observedPoint&&inside(g.points,s.observedPoint)&&crossesBoundary(g.points,s.observedPoint,p)){
        s.candidate=false;s.side='in';
        delete s.triggerDirection;delete s.entry_origin_point;delete s.review_outside;delete s.review_compact;
        issues.push(`ambiguous_concave_crossing:${r.id}:${t.track_id}`);
      }
      if(stable==='out'){
        // Re-arm only after a stable observed departure lasting rearm_ms.
        if(s.side!=='out'){s.side='out';s.out_since=f.source_pts_ns;}
        s.out_since??=f.source_pts_ns;
        s.candidate=false;
        s.entry_origin_point=p;if(sample)s.review_outside=sample;
        if(s.fired&&s.out_since&&elapsedMs(f,s.out_since)>=r.rearm_ms)s.fired=false;
      }
      if(stable==='in'&&s.side==='out'&&s.fired){s.side='in';delete s.out_since;} // back within the wait: same intrusion
      else if(stable==='in'&&s.side==='out'){
        if(!s.candidate){if(sample)s.review_compact={last:s.review_outside??null};begin();s.candidate=true;s.since=f.source_pts_ns;s.first_seq=f.seq;s.triggerDirection=regionDirection(g,f,p,s.entry_origin_point??s.observedPoint,{entry:true});}
        if(elapsedMs(f,s.since)>=r.duration_ms){
          if(allowedEdge(s.triggerDirection.entry_edge,r.entry_edges))fire(s.triggerDirection);
          s.side='in';s.candidate=false;
        }
      } else if(stable==='in'&&!s.side)s.side='in'; // First seen inside is not entry.
      if(!stable){s.candidate=false;delete s.out_since;} // Boundary uncertainty cannot count toward rearm.
      if(stable)s.observedPoint=p; // keep the last stable point for the crossing edge
      if(sample&&stable==='out')delete s.review_compact;
    } else {
      const inRegion=inside(g.points,p),distance=boundaryDistancePx(g.points,p,W,H),margin=r.hysteresis*Math.min(W,H);
      const match=!inRegion&&distance<=r.approach_px;
      // Inner uncertainty preserves an established candidate, but cannot start one
      // from inside the zone. Neither uncertain interval contributes dwell time.
      const uncertain=(inRegion&&distance<=margin)||(!inRegion&&!match&&distance<=r.approach_px+margin);
      if(s.match&&uncertain){s.approach_pause??=s.last_approach_pts??f.source_pts_ns;continue;}
      if(match&&s.approach_pause){s.since=String(BigInt(s.since)+BigInt(f.source_pts_ns)-BigInt(s.approach_pause));}
      delete s.approach_pause;s.last_approach_pts=f.source_pts_ns;
      if(match){
        delete s.unmatched_since;
        if(!s.match){begin();s.since=f.source_pts_ns;s.first_seq=f.seq;}
        const direction=regionDirection(g,f,p,s.observedPoint);
        if(!s.fired&&elapsedMs(f,s.since)>=r.duration_ms&&allowedEdge(direction.nearest_edge,r.entry_edges))fire(direction);
      } else {
        // A boundary flicker or missing/predicted frame cannot rearm facts.
        if(!inRegion&&distance>r.approach_px+margin)s.unmatched_since??=f.source_pts_ns;else delete s.unmatched_since;
        if(!s.fired||(s.unmatched_since&&elapsedMs(f,s.unmatched_since)>=r.rearm_ms)){s.fired=false;s.since=f.source_pts_ns;s.first_seq=f.seq;}
      }
      s.match=match;s.observedPoint=p;
      if(sample&&!match)delete s.review_compact;
    }
    if(!['region_enter','region_traverse'].includes(r.behavior)||boundaryDistance(g.points,p)>=r.hysteresis)remember();
  }
  // Disabled, revised or out-of-window rules and vanished targets keep no state.
  for(const key of Object.keys(cp.states)){
    const [id,version,track]=JSON.parse(key);
    if(!eligible.has(JSON.stringify([id,version]))||!present.has(track))delete cp.states[key];
  }
  for(const track of Object.keys(cp.first_seen))if(!present.has(track))delete cp.first_seen[track];
  // One activity per target on this channel across all triggers; it ends when the
  // tracker no longer reports the ID. The alarm keeps the highest level reached.
  // Only a change to a trigger this activity actually used (or its schedule
  // window) starts a new activity; editing an unrelated trigger on the same
  // channel must not re-alarm everyone currently in view.
  channelRules.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const rulesKey=JSON.stringify(channelRules.map(([id,version])=>[id,version])),windowKey=JSON.stringify(channelRules.map(r=>r[2]));
  const current=new Map(channelRules.map(([id,version,period])=>[id,{version,period:JSON.stringify(period??null)}]));
  const statisticsRules=new Set(rules.filter(r=>r.alarm_enabled===false).map(r=>r.id));
  for(const [track,e] of Object.entries(cp.episodes)){
    // Upgrade pre-isolation checkpoints without allowing statistics-only edits
    // to close a genuine alarm. Unknown removed rules remain conservative.
    if(e.used)for(const id of statisticsRules)delete e.used[id];
    else if(e.rules_key){
      const old=JSON.parse(e.rules_key),windows=JSON.parse(e.window_key);
      e.rules_key=JSON.stringify(old.filter(([id])=>!statisticsRules.has(id)));
      e.window_key=JSON.stringify(windows.filter((_,i)=>!statisticsRules.has(old[i][0])));
    }
    const used=e.used?Object.entries(e.used):null;
    const reason=used?(used.some(([id,u])=>current.get(id)?.version!==u.version)?'configuration_changed':
      used.some(([id,u])=>current.get(id)?.period!==u.period)?'schedule_ended':!present.has(track)?'track_expired':null):
      e.rules_key!==rulesKey?'configuration_changed':e.window_key!==windowKey?'schedule_ended':!present.has(track)?'track_expired':null;
    if(reason){ended.push({episode_id:e.id,ended_at:f.captured_at,end_reason:reason});delete cp.episodes[track];}
  }
  for(const event of out){
    if(event.rule.snapshot.alarm_enabled===false)continue;
    const track=event.track_ids[0];
    const e=cp.episodes[track]??={id:digest(['episode',f.channel_id,f.stream_session_id,track,f.seq]),started_at:cp.first_seen[track]??f.captured_at,used:{}};
    // Legacy checkpoints only know the old channel-wide signatures. Keep that
    // conservative scope until the activity ends; a later stage cannot recover
    // which earlier rules fired and must not silently forget them.
    if(e.used)e.used[event.rule.id]={version:event.rule.version,period:current.get(event.rule.id)?.period??'null'};
    event.episode_id=e.id;event.episode_started_at=e.started_at;event.lifecycle={state:'active',end_reason:null};
  }
  // Optional review state has its own channel budget; never exhaust the input checkpoint.
  let reviewBytes=0;
  for(const state of Object.values(cp.states))if(state.review_compact||state.review_outside){
    reviewBytes+=Buffer.byteLength(JSON.stringify([state.review_compact,state.review_outside]));
    if(reviewBytes>512*1024){delete state.review_compact;delete state.review_outside;state.review_unavailable=true;}
  }
  const coverage=coverageStep(cp,f,eligible.values(),sessionChanged||seqGap||ptsReset||timeGap||f.gap===true||(interval!==null&&cp.intervals?.length===1&&interval>1500));
  return {checkpoint:cp,events:out,ended_episodes:ended,issues,coverage,capture_intents:captureIntents};
}
