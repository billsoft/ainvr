// Copyright AINVR. Closed facts and last checkpointed active visits.
import {fail,identity} from './domain.mjs';
import {observedIntervals} from './dwell-intervals.mjs';
const LIMIT=10000,MAX_RANGE=31*86400000;
const COLLECTION='region_dwell_visits',DEFAULT_BYTES=256*1024*1024,DEFAULT_VISITS=500000;
function bucketStart(at,bucket,formatter){
  if(bucket==='minute')return at;
  const parts=Object.fromEntries(formatter.formatToParts(new Date(at)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  if(bucket==='hour')return at-parts.minute*60000;
  // Resolve local midnight with the timezone offset at midnight, including DST.
  const midnight=Date.UTC(parts.year,parts.month-1,parts.day);let candidate=midnight;
  for(let i=0;i<4;i++){
    const p=Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
    const offset=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-candidate;
    const next=midnight-offset;if(next===candidate)break;candidate=next;
  }
  return candidate;
}
export class DwellQuery {
  // This is a rolling, partial lower-bound cache of derived dwell facts, not
  // the long-term authority for original counting. Eviction is by insertion
  // order, not event time. No TTL is applied and no historical completeness
  // follows from the oldest remaining fact. Limits are injectable for tests.
  constructor(db,{maxBytes=DEFAULT_BYTES,maxVisits=DEFAULT_VISITS}={}){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>DEFAULT_BYTES||!Number.isSafeInteger(maxVisits)||maxVisits<1||maxVisits>DEFAULT_VISITS)throw Error('Invalid dwell rolling retention limits');
    this.db=db;this.limits={max_bytes:maxBytes,max_visits:maxVisits};this.facts=db.collection(COLLECTION);this.checkpoints=db.collection('alarm_consumer_checkpoints');
  }
  async initialize(){
    let info=await this.db.listCollections({name:COLLECTION},{nameOnly:false}).next();
    if(!info){
      try{await this.db.createCollection(COLLECTION,{capped:true,size:this.limits.max_bytes,max:this.limits.max_visits});}
      catch(error){if(error.code!==48)throw error;}
      info=await this.db.listCollections({name:COLLECTION},{nameOnly:false}).next();
    }
    const options=info?.options??{},size=Number(options.size),max=Number(options.max);
    if(!options.capped||!Number.isSafeInteger(size)||size<1||size>this.limits.max_bytes||!Number.isSafeInteger(max)||max<1||max>this.limits.max_visits)
      throw Error('Unsupported region_dwell_visits collection: expected capped rolling limits; existing data was not changed');
    this.limits={max_bytes:size,max_visits:max};
    await this.facts.createIndex({channel_id:1,zone_id:1,started_at:1});
    await this.facts.createIndex({started_at:1});
  }
  async query(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['channel_id','zone_id','zone_version','label_ids','label_map_version','from','to','bucket','timezone','thresholds','sample_limit'].includes(k)))fail('invalid_dwell_query','Invalid dwell query');
    const {channel_id,zone_id,zone_version,label_ids,from,to,bucket='hour',timezone='UTC',thresholds=[5000,15000,60000],sample_limit=10}=input;
    identity(channel_id,'channel_id');identity(zone_id,'zone_id');
    if(input.label_map_version!==undefined&&input.label_map_version!==null)identity(input.label_map_version,'label_map_version');
    const lo=Date.parse(from),hi=Date.parse(to),width={minute:60000,hour:3600000,day:86400000}[bucket];
    if(typeof from!=='string'||typeof to!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/i.test(from)||!/(?:Z|[+-]\d\d:\d\d)$/i.test(to)||!Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo||hi-lo>MAX_RANGE||!width||Math.ceil((hi-lo)/width)+2>1500)fail('invalid_dwell_range','Use an absolute range of at most 31 days and 1500 buckets');
    let formatter;try{if(typeof timezone!=='string'||timezone.length>100)throw Error();formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{fail('invalid_timezone','Invalid timezone');}
    if(!Array.isArray(thresholds)||thresholds.length>20||thresholds.some(n=>!Number.isSafeInteger(n)||n<0||n>3600000)||!Number.isInteger(sample_limit)||sample_limit<0||sample_limit>50)fail('invalid_dwell_query','Invalid thresholds or sample limit');
    if(zone_version!==undefined&&(!Number.isSafeInteger(zone_version)||zone_version<1))fail('invalid_dwell_query','Invalid zone version');
    if(label_ids!==undefined){if(!Array.isArray(label_ids)||!label_ids.length||label_ids.length>128)fail('invalid_dwell_query','Invalid labels');label_ids.forEach(x=>identity(x,'label_id'));}
    const filter={channel_id,zone_id,started_at:{$gte:new Date(lo-3600000).toISOString(),$lt:new Date(hi).toISOString()},ended_at:{$gte:new Date(lo).toISOString()}};
    if(zone_version!==undefined)filter.zone_version=zone_version;if(label_ids!==undefined)filter.label_id={$in:[...new Set(label_ids)]};
    const rows=await this.facts.find(filter,{timeoutMS:10000,maxTimeMS:9000}).sort({started_at:1,_id:1}).limit(LIMIT+1).toArray();
    if(rows.length>LIMIT)fail('dwell_query_capacity','Narrow the range; too many visits',422);
    const checkpoint=await this.checkpoints.findOne({channel_id},{projection:{checkpoint:1,last_consumed_at:1,last_issues:1}});
    const oldest=await this.facts.findOne({},{sort:{started_at:1},projection:{_id:0,started_at:1}});
    const closed=new Set(rows.map(row=>row._id));let active_visits=0;
    for(const v of Object.values(checkpoint?.checkpoint?.dwell?.visits??{})){
      if(v._blocked||closed.has(v._id)||v.zone_id!==zone_id||(zone_version!==undefined&&v.zone_version!==zone_version)||
         (label_ids!==undefined&&!label_ids.includes(v.label_id))||Date.parse(v.started_at)>=hi||Date.parse(v.ended_at)<lo)continue;
      rows.push({...v,active:true});
    }
    // Never combine class IDs from different vocabularies. The default is the
    // latest recorded known vocabulary; legacy unknown records remain selectable.
    const versions=[...new Set([...rows].sort((a,b)=>b.started_at.localeCompare(a.started_at)).map(r=>r.label_map_version??null))];
    const selectedVersion=input.label_map_version!==undefined?input.label_map_version:versions.find(v=>v!==null)??null;
    const selectedRows=rows.filter(r=>(r.label_map_version??null)===selectedVersion);
    const buckets=new Map(),distribution=Object.fromEntries(thresholds.map(n=>[n,0])),samples=[],unknown=[];
    let observed_ms=0,visits=0;
    for(const row of selectedRows){
      if(row.active)active_visits++;
      const spans=observedIntervals(row);
      if(spans===null){unknown.push({from:new Date(lo).toISOString(),to:new Date(hi).toISOString(),reason:'invalid_visit_interval'});continue;}
      const clippedMs=spans.reduce((n,[a,b])=>n+Math.max(0,Math.min(b,hi)-Math.max(a,lo)),0);
      if(Date.parse(row.started_at)>=lo&&Date.parse(row.started_at)<hi){
        visits++;for(const threshold of thresholds)if(clippedMs>=threshold)distribution[threshold]++;
        if(samples.length<sample_limit)samples.push({visit_id:row._id,channel_id:row.channel_id,input_stream_id:row.input_stream_id,zone_id:row.zone_id,zone_version:row.zone_version,label_id:row.label_id,label_map_version:row.label_map_version??null,started_at:row.started_at,ended_at:new Date(Math.min(Date.parse(row.ended_at),hi)).toISOString(),observed_ms:clippedMs,partial:true,end_reason:row.active?'active':row.end_reason,first_frame_id:row.first_frame_id,last_frame_id:row.last_frame_id,stream_session_id:row.stream_session_id,active:row.active===true,observation_gaps:row.observation_gaps===true,observed_interval_count:spans.length});
      }
      // Intersect each bounded temporal evidence interval independently. Never
      // interpolate elapsed visit span across predicted/noneligible gaps.
      for(const [start,end] of spans)for(let at=Math.max(start,lo),last=Math.min(end,hi);at<last;){
        const next=Math.min(last,(Math.floor(at/60000)+1)*60000),minute=Math.floor(at/60000)*60000;
        const b=bucketStart(minute,bucket,formatter),value=next-at;
        observed_ms+=value;buckets.set(b,(buckets.get(b)??0)+value);at=next;
      }
    }
    return {channel_id,zone_id,from:new Date(lo).toISOString(),to:new Date(hi).toISOString(),bucket,timezone,
      label_map_versions:versions,selected_label_map_version:selectedVersion,version_scope:'single_label_map',
      visits_started:visits,active_visits,observed_ms,thresholds_ms:distribution,unknown_boundary_ranges:unknown,time_resolution_ms:1,
      buckets:[...buckets].sort((a,b)=>a[0]-b[0]).map(([at,ms])=>({start:new Date(at).toISOString(),observed_ms:ms})),
      visits:samples,samples,sample_scope:'bounded_visits_started_in_range',threshold_scope:'clipped_observed_duration_for_visits_started_in_range',
      semantics:'lower_bound_observed_checkpoint',coverage:'unknown',consistency:'non_transactional',checkpoint_at:checkpoint?.last_consumed_at??null,
      dwell_status:checkpoint?.checkpoint?.dwell?.disabled_session?'capacity_suspended':checkpoint?.checkpoint?.dwell?'active':'unknown',
      retention:{mode:'rolling',...this.limits,oldest_available_at:oldest?.started_at??null,history_complete:false,eviction_order:'insertion',oldest_meaning:'earliest_remaining_fact_not_coverage_start'},
      gaps:(checkpoint?.checkpoint?.dwell_gaps??[]).filter(g=>Date.parse(g.from)<hi&&(g.to===null||Date.parse(g.to)>lo)),
      last_issues:(checkpoint?.last_issues??[]).filter(x=>typeof x==='string'&&x.startsWith('dwell_'))};
  }
}
