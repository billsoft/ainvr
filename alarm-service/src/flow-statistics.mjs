// Copyright AINVR. Count recorded passages of counting bindings; never infer crossings.
// A series is one output (e.g. "in") of one binding: rule id + targets + direction filter.
import {digest,fail,identity} from './domain.mjs';
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const MAX_RANGE_MS=31*86400000;
function angle(input,field){
  if(!object(input)||Object.keys(input).some(k=>!['from','to'].includes(k))||![input.from,input.to].every(n=>Number.isFinite(n)&&n>=0&&n<=360))fail('invalid_direction',field);
  const from=input.from%360,to=input.to%360;
  if(from===to)fail('invalid_direction','A full circle is not a direction');
  return {from,to};
}
function edges(input,field){
  if(!Array.isArray(input)||!input.length||input.length>32||new Set(input).size!==input.length)fail('invalid_direction',field);
  input.forEach(e=>identity(e,field));return [...input];
}
export function seriesFilter(input){
  if(!object(input))fail('invalid_direction','filter');
  if(input.kind==='line'){
    if(Object.keys(input).length!==2||!['inward','outward'].includes(input.side))fail('invalid_direction','side');
    return {kind:'line',side:input.side};
  }
  if(input.kind==='edges'){
    if(Object.keys(input).some(k=>!['kind','entry','exit'].includes(k)))fail('invalid_direction','filter');
    return {kind:'edges',entry:edges(input.entry,'entry'),exit:edges(input.exit,'exit')};
  }
  if(input.kind==='angle'){
    if(Object.keys(input).some(k=>!['kind','entry','exit'].includes(k)))fail('invalid_direction','filter');
    return {kind:'angle',entry:angle(input.entry,'entry'),exit:angle(input.exit,'exit')};
  }
  return fail('invalid_direction','filter');
}
function angleQuery(field,{from,to}){
  return from<to?{[field]:{$gte:from,$lt:to}}:{$or:[{[field]:{$gte:from,$lt:360}},{[field]:{$gte:0,$lt:to}}]};
}
export function parseSeries(input){
  if(!object(input)||Object.keys(input).some(k=>!['key','rule_id','label_ids','filter','from','to','grace'].includes(k)))fail('invalid_series','Invalid counting series');
  const grace=input.grace??{};
  if(!object(grace)||Object.keys(grace).some(k=>!['start_ms','end_ms'].includes(k))||Object.values(grace).some(v=>!Number.isInteger(v)||v<0||v>60000))fail('invalid_series','Coverage grace is at most one minute');
  identity(input.key,'key');identity(input.rule_id,'rule_id');
  if(!Array.isArray(input.label_ids)||!input.label_ids.length||input.label_ids.length>128||new Set(input.label_ids).size!==input.label_ids.length)fail('invalid_series','Choose target labels');
  input.label_ids.forEach(l=>identity(l,'label'));
  const start=Date.parse(input.from),end=Date.parse(input.to);
  if(typeof input.from!=='string'||typeof input.to!=='string'||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>MAX_RANGE_MS)fail('invalid_time_range','Choose a positive range up to 31 days');
  return {key:input.key,rule_id:input.rule_id,label_ids:[...input.label_ids],filter:seriesFilter(input.filter),from:new Date(start).toISOString(),to:new Date(end).toISOString(),grace:{...grace}};
}
export function seriesQuery(raw){
  const s=parseSeries(raw),f=s.filter;
  const direction=f.kind==='line'?[{'direction.line_direction':f.side}]:
    f.kind==='edges'?[{'direction.entry_edge_id':{$in:f.entry}},{'direction.exit_edge_id':{$in:f.exit}}]:
    [angleQuery('direction.entry_side_deg',f.entry),angleQuery('direction.exit_side_deg',f.exit)];
  return {event_type:'region_traverse',rule_id:s.rule_id,label_id:{$in:s.label_ids},
    occurred_at:{$gte:s.from,$lt:s.to},'quality.trajectory_complete':true,$and:direction};
}
// Consecutive frames of one binding (also across a rule version change) are at most
// one frame interval apart; the engine itself treats 1.5 s as still continuous.
const JOIN_MS=1500;
/** grace: only the caller knows a period starts when the rule took effect (start_ms)
 * or is still running with throttled coverage writes (end_ms). Without it every gap counts. */
export function mergeCoverage(segments,from,to,grace={}){
  const lo=Date.parse(from),hi=Date.parse(to),ranges=segments.map(s=>[Math.max(lo,Date.parse(s.from)),Math.min(hi,Date.parse(s.to))])
    .filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const [a,b] of ranges){const last=merged.at(-1);if(last&&a<=last[1]+JOIN_MS)last[1]=Math.max(last[1],b);else merged.push([a,b]);}
  const gaps=[];let next=lo;
  for(const [a,b] of merged){if(a>next)gaps.push([next,a]);next=b;}
  if(next<hi)gaps.push([next,hi]);
  if(merged.length){
    if(gaps[0]?.[0]===lo&&gaps[0][1]-lo<=(grace.start_ms??0))gaps.shift();
    const last=gaps.at(-1);if(last&&last[1]===hi&&hi-last[0]<=(grace.end_ms??0))gaps.pop();
  }
  const asRange=([a,b])=>({from:new Date(a).toISOString(),to:new Date(b).toISOString()});
  return {state:!merged.length?'no_data':!gaps.length?'complete':'partial',gaps:gaps.map(asRange)};
}
export class FlowStatistics {
  constructor(db){this.clears=db.collection('flow_clear_operations');this.facts=db.collection('behavior_events');this.checkpoints=db.collection('alarm_consumer_checkpoints');this.coverage=db.collection('flow_coverage');}
  async initialize(){
    await this.facts.createIndex({rule_id:1,occurred_at:1});
    await this.clears.createIndex({rule_ids:1,from:1,to:1});
    await this.coverage.createIndex({segment_id:1},{unique:true});
    await this.coverage.createIndex({assignment_id:1,from:1,to:1});
  }
  /** A deleted counter takes its passages and coverage with it; other counters are untouched. */
  async purge(request){
    if(!object(request)||Object.keys(request).some(k=>!['counter_id','rule_ids'].includes(k))||!Array.isArray(request.rule_ids)||!request.rule_ids.length||request.rule_ids.length>1000)fail('invalid_purge','Counter and its bindings are required');
    identity(request.counter_id,'counter_id');request.rule_ids.forEach(id=>identity(id,'rule_id'));
    const facts=await this.facts.deleteMany({counter_id:request.counter_id,rule_id:{$in:request.rule_ids}});
    const coverage=await this.coverage.deleteMany({assignment_id:{$in:request.rule_ids}});
    return {facts:facts.deletedCount,coverage:coverage.deletedCount};
  }
  /** Persist the exclusion before physical removal: replay and delayed frames cannot restore counts. */
  async clear(request,actor,key){
    if(!object(request)||Object.keys(request).some(k=>!['counter_id','rule_ids','from','to'].includes(k))||!Array.isArray(request.rule_ids)||!request.rule_ids.length||request.rule_ids.length>1000||new Set(request.rule_ids).size!==request.rule_ids.length)fail('invalid_clear','Choose counter bindings');
    identity(request.counter_id,'counter_id');identity(actor,'actor');identity(key,'operation');request.rule_ids.forEach(id=>identity(id,'rule_id'));
    const from=Date.parse(request.from),to=Date.parse(request.to);
    if(typeof request.from!=='string'||typeof request.to!=='string'||!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>MAX_RANGE_MS||to>Date.now()+2000)fail('invalid_time_range','Choose a past range up to 31 days');
    const scope={counter_id:request.counter_id,rule_ids:[...request.rule_ids].sort(),from:new Date(from).toISOString(),to:new Date(to).toISOString()};
    const fingerprint=digest([actor,scope]);
    try{await this.clears.updateOne({_id:key},{$setOnInsert:{...scope,actor,fingerprint,created_at:new Date().toISOString()}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
    const saved=await this.clears.findOne({_id:key});
    if(saved.fingerprint!==fingerprint)fail('operation_conflict','Operation scope changed',409);
    if(saved.completed)return {cleared:true,from:scope.from,to:scope.to};
    await this.facts.deleteMany({counter_id:scope.counter_id,rule_id:{$in:scope.rule_ids},occurred_at:{$gte:scope.from,$lt:scope.to}});
    await this.clears.updateOne({_id:key},{$set:{completed:true}});
    return {cleared:true,from:scope.from,to:scope.to};
  }
  async record(segments){
    for(const s of segments??[]){const {to,...base}=s;await this.coverage.updateOne({segment_id:s.segment_id},{$setOnInsert:base,$max:{to}},{upsert:true});}
  }
  async query(request){
    if(!object(request)||Object.keys(request).some(k=>!['series','bucket','timezone','detail','cursor','limit','totals_only'].includes(k))||!Array.isArray(request.series)||!request.series.length||request.series.length>100)fail('invalid_query','Bounded counting series required');
    if(request.totals_only!==undefined&&typeof request.totals_only!=='boolean')fail('invalid_query','Invalid totals mode');
    const series=request.series.map(parseSeries);
    if(new Set(series.map(s=>s.key)).size!==series.length)fail('invalid_query','Series keys must be unique');
    // One bounded ledger read covers totals, trends and records, including late arrivals.
    const removed=await this.clears.find({rule_ids:{$in:series.map(s=>s.rule_id)},from:{$lt:series.reduce((a,s)=>a>s.to?a:s.to,'')},to:{$gt:series.reduce((a,s)=>a<s.from?a:s.from,series[0].from)}},{projection:{rule_ids:1,from:1,to:1},maxTimeMS:5000}).limit(10001).toArray();
    if(removed.length>10000)fail('clear_history_capacity','Reduce query range');
    const visibleQuery=s=>{const excluded=removed.filter(r=>r.rule_ids.includes(s.rule_id)).map(r=>({occurred_at:{$gte:r.from,$lt:r.to}}));return {...seriesQuery(s),...(excluded.length?{$nor:excluded}:{})};};
    if(request.detail){
      // The history pieces of one zone and direction are read as one list.
      const query=series.length===1?visibleQuery(series[0]):{$or:series.map(visibleQuery)},limit=request.limit??50;
      if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_limit','Choose 1..100');
      const scope=digest(query);let position;
      if(request.cursor!==undefined){
        try{position=JSON.parse(Buffer.from(String(request.cursor),'base64url').toString());}catch{fail('invalid_cursor','Invalid cursor');}
        if(!object(position)||position.scope!==scope||typeof position.time!=='string'||!Number.isFinite(Date.parse(position.time)))fail('invalid_cursor','Query changed');
        identity(position.id,'cursor');
      }
      const final=position?{$and:[query,{$or:[{occurred_at:{$lt:position.time}},{occurred_at:position.time,event_id:{$lt:position.id}}]}]}:query;
      const rows=await this.facts.find(final,{projection:{_id:0,analysis_evidence:0},maxTimeMS:5000}).sort({occurred_at:-1,event_id:-1}).limit(limit+1).toArray();
      const items=rows.slice(0,limit),last=items.at(-1);
      return {items,next_cursor:rows.length>limit?Buffer.from(JSON.stringify({scope,time:last.occurred_at,id:last.event_id})).toString('base64url'):null};
    }
    const timezone=request.timezone??'UTC',bucket=request.bucket??null;
    if(typeof timezone!=='string'||timezone.length>100)fail('invalid_timezone','Invalid timezone');
    try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{fail('invalid_timezone','Invalid timezone');}
    const units={minute:60000,hour:3600000,day:86400000};
    if(bucket!==null&&(!Object.hasOwn(units,bucket)||series.some(s=>Math.ceil((Date.parse(s.to)-Date.parse(s.from))/units[bucket])+2>1500)))fail('invalid_bucket','Choose at most 1500 time buckets');
    const diagnostics=await this.checkpoints.find({'checkpoint.passage_diagnostics.rule_id':{$in:series.map(s=>s.rule_id)}},{projection:{'checkpoint.passage_diagnostics':1},maxTimeMS:5000}).limit(100).toArray();
    const issues=diagnostics.flatMap(d=>d.checkpoint?.passage_diagnostics??[]);
    const items=[];
    for(const s of series){
      const diagnostic=issues.filter(d=>d.rule_id===s.rule_id&&d.at>=s.from&&d.at<s.to).sort((a,b)=>b.at.localeCompare(a.at))[0]??null;
      if(request.totals_only){
        const occurrences=await this.facts.countDocuments(visibleQuery(s),{maxTimeMS:5000});
        items.push({key:s.key,occurrences,tracked_targets:0,coverage:{state:'unknown',gaps:[]},buckets:[],diagnostic});continue;
      }
      // Coverage first: a later materialization must not make an earlier fact snapshot look like a confirmed zero.
      const rows=await this.coverage.find({assignment_id:s.rule_id,from:{$lt:s.to},to:{$gt:s.from}},{projection:{_id:0,from:1,to:1},maxTimeMS:5000}).limit(20001).toArray();
      if(rows.length>20000)fail('coverage_capacity','Reduce query range');
      const count=[{$group:{_id:{session:'$stream_session_id',track:'$track_id'},n:{$sum:1}}},{$group:{_id:null,occurrences:{$sum:'$n'},tracked_targets:{$sum:1}}}];
      const facet={totals:count};
      if(bucket)facet.series=[
        {$group:{_id:{$dateTrunc:{date:{$toDate:'$occurred_at'},unit:bucket,timezone}},occurrences:{$sum:1}}},{$sort:{_id:1}},
        {$set:{end:{$dateAdd:{startDate:'$_id',unit:bucket,amount:1,timezone}}}},
      ];
      const [result]=await this.facts.aggregate([{$match:visibleQuery(s)},{$facet:facet}],{maxTimeMS:5000,allowDiskUse:false}).toArray();
      const total=result?.totals?.[0];
      items.push({key:s.key,diagnostic,from:s.from,to:s.to,occurrences:total?.occurrences??0,tracked_targets:total?.tracked_targets??0,coverage:mergeCoverage(rows,s.from,s.to,s.grace),
        buckets:(result?.series??[]).map(r=>({from:new Date(Math.max(Date.parse(s.from),+r._id)).toISOString(),to:new Date(Math.min(Date.parse(s.to),+r.end)).toISOString(),occurrences:r.occurrences}))});
    }
    return {bucket,timezone,items,time_basis:'passage_completed_at'};
  }
}
