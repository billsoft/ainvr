// Behavior facts are independent of alarm handling and future notification policy.
import {digest,identity,fail,ENGINE_SEMANTICS} from './domain.mjs';
export function behaviorEvent(candidate) {
  const track=candidate.analysis_evidence.track;
  return {schema_version:'1.0',event_id:digest(['behavior',candidate.dedup_key]),engine_semantics:candidate.analysis_evidence.engine_semantics??ENGINE_SEMANTICS,
    event_type:candidate.behavior,channel_id:candidate.channel_id,input_stream_id:candidate.input_stream_id,
    stream_session_id:candidate.stream_session_id,track_id:track.track_id,label_id:track.label_id,
    trigger_id:candidate.trigger_id??candidate.rule.snapshot.trigger_id??candidate.rule.id,
    zone_id:candidate.rule.snapshot.zone_id??null,zone_version:candidate.rule.snapshot.zone_version??null,
    rule_id:candidate.rule.id,rule_version:candidate.rule.version,
    episode_id:candidate.episode_id??null,
    started_at:candidate.analysis_evidence.started_at??null,occurred_at:new Date(candidate.occurred_at).toISOString(),
    source_pts_ns:candidate.source_pts_ns,frame_id:candidate.frame_id,direction:candidate.direction,
    source_frame_index:candidate.analysis_evidence.source_frame_index??null,
    evidence_refs:structuredClone(candidate.evidence.refs),
    quality:{basis:'observed_track',trajectory_complete:candidate.analysis_evidence.traversal?.trajectory_complete??null},
    analysis_evidence:structuredClone(candidate.analysis_evidence)};
}
function factFilter({from,to,channel_id,zone_id,label_id,event_type,rule_id,trigger_id}) {
  const start=typeof from==='string'?Date.parse(from):NaN,end=typeof to==='string'?Date.parse(to):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)fail('invalid_time_range','Choose a positive range up to 31 days');
  const query={occurred_at:{$gte:new Date(start).toISOString(),$lt:new Date(end).toISOString()}};
  for(const [key,value] of Object.entries({channel_id,zone_id,label_id,event_type,rule_id}))if(value!==undefined)query[key]=identity(value,key);
  // Facts recorded before triggers carry only the rule id, which is the migrated trigger id.
  if(trigger_id!==undefined)query.$and=[{$or:[{trigger_id:identity(trigger_id,'trigger_id')},{trigger_id:{$exists:false},rule_id:trigger_id}]}];
  return {query,start,end};
}
export class BehaviorEvents {
  constructor(db){this.collection=db.collection('behavior_events');}
  async initialize(){
    await this.collection.createIndex({event_id:1},{unique:true});
    await this.collection.createIndex({occurred_at:-1,event_id:-1});
    await this.collection.createIndex({channel_id:1,occurred_at:1,event_type:1});
    await this.collection.createIndex({zone_id:1,occurred_at:1,label_id:1});
  }
  async insert(candidate){
    const fact=behaviorEvent(candidate);
    await this.collection.updateOne({event_id:fact.event_id},{$setOnInsert:fact},{upsert:true});
    return fact.event_id;
  }
  async list({limit=50,cursor,...filters}) {
    const {query}=factFilter(filters);
    if(!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_limit','Limit must be 1 to 100');
    const scope=digest(query);
    if(cursor!==undefined){
      let position;
      try{
        if(typeof cursor!=='string'||cursor.length>2048||!cursor.length)throw Error();
        position=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if(position.scope!==scope||typeof position.time!=='string'||!Number.isFinite(Date.parse(position.time))||new Date(position.time).toISOString()!==position.time)throw Error();
        identity(position.id,'cursor event');
      }catch{fail('invalid_cursor','Cursor must belong to the same query');}
      query.$or=[{occurred_at:{$lt:position.time}},{occurred_at:position.time,event_id:{$lt:position.id}}];
    }
    const rows=await this.collection.find(query,{projection:{_id:0,analysis_evidence:0},maxTimeMS:5000})
      .sort({occurred_at:-1,event_id:-1}).limit(limit+1).toArray();
    const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
    return {schema_version:'1.0',items,next_cursor:more?Buffer.from(JSON.stringify({scope,time:last.occurred_at,id:last.event_id})).toString('base64url'):null,
      consistency:'live_keyset',coverage:{state:'unknown'},semantics:'Recorded rule events; late arrivals may require refreshing the query'};
  }
  async get(id){
    const fact=await this.collection.findOne({event_id:identity(id,'event_id')},{projection:{_id:0},maxTimeMS:5000});
    if(!fact)fail('not_found','Behavior event not found',404);
    return fact;
  }
  async statistics({from,to,channel_id,zone_id,label_id,event_type,rule_id,trigger_id,bucket,timezone='UTC',group_by}){
    const {query,start,end}=factFilter({from,to,channel_id,zone_id,label_id,event_type,rule_id,trigger_id});
    const units={minute:60000,hour:3600000,day:86400000};
    if(bucket!==undefined && (typeof bucket!=='string' || !Object.hasOwn(units,bucket) || Math.ceil(end/units[bucket])-Math.floor(start/units[bucket])>1500))
      fail('invalid_bucket','Choose minute, hour or day with at most 1500 UTC buckets');
    if(typeof timezone!=='string'||timezone.length>100)fail('invalid_timezone','Choose a valid IANA timezone');
    try{timezone=new Intl.DateTimeFormat('en',{timeZone:timezone}).resolvedOptions().timeZone;}catch{fail('invalid_timezone','Choose a valid IANA timezone');}
    const groups={rule:'$rule_id',trigger:{$ifNull:['$trigger_id','$rule_id']},entry_direction:'$direction.entry_side_deg',exit_direction:'$direction.exit_side_deg',movement_direction:'$direction.motion_heading_deg'};
    if(group_by!==undefined&&(typeof group_by!=='string'||!Object.hasOwn(groups,group_by)))fail('invalid_group','Unsupported grouping');
    // Direction groups bucket degrees into 8 sectors.
    const group=group_by===undefined?{}:{group:['rule','trigger'].includes(group_by)?groups[group_by]:{$cond:[{$isNumber:groups[group_by]},{$mod:[{$floor:{$divide:[{$add:[groups[group_by],22.5]},45]}},8]},null]}};
    // Deduplicate identities including video session; this is not unique physical people.
    const totals=[
      {$group:{_id:{...group,type:'$event_type',channel:'$channel_id',session:'$stream_session_id',track:'$track_id'},occurrences:{$sum:1}}},
      {$group:{_id:{type:'$_id.type',...(group_by?{group:'$_id.group'}:{})},occurrences:{$sum:'$occurrences'},tracked_targets:{$sum:1}}},
      {$sort:{_id:1}},
    ];
    const series=bucket===undefined?[]:[
      {$group:{_id:{start:{$dateTrunc:{date:{$toDate:'$occurred_at'},unit:bucket,timezone}},...group,type:'$event_type',channel:'$channel_id',session:'$stream_session_id',track:'$track_id'},occurrences:{$sum:1}}},
      {$group:{_id:{start:'$_id.start',type:'$_id.type',...(group_by?{group:'$_id.group'}:{})},occurrences:{$sum:'$occurrences'},tracked_targets:{$sum:1}}},
      {$set:{end:{$dateAdd:{startDate:'$_id.start',unit:bucket,amount:1,timezone}}}},
      {$sort:{'_id.start':1,'_id.type':1}},
    ];
    const [result]=await this.collection.aggregate([
      {$match:query},{$facet:{totals,...(bucket===undefined?{}:{series})}},
    ],{maxTimeMS:5000,allowDiskUse:false}).toArray();
    const rows=result?.totals??[];
    const timeline=bucket===undefined?{}:{bucket,timezone,missing_bucket_policy:'unknown',
      buckets:(result?.series??[]).map(r=>({
        from:new Date(Math.max(start,new Date(r._id.start).getTime())).toISOString(),
        to:new Date(Math.min(end,new Date(r.end).getTime())).toISOString(),
        event_type:r._id.type,...(group_by?{group:r._id.group??null}:{}),occurrences:r.occurrences,tracked_targets:r.tracked_targets,
      }))};
    return {schema_version:'1.0',from:query.occurred_at.$gte,to:query.occurred_at.$lt,time_basis:'occurred_at',
      interval:'[from,to)',...(group_by?{group_by}:{}),...timeline,items:rows.map(r=>({event_type:r._id.type,...(group_by?{group:r._id.group??null}:{}),occurrences:r.occurrences,tracked_targets:r.tracked_targets})),
      coverage:{state:'unknown',reason:'Input continuity coverage not yet connected'},
      semantics:'Recorded events only; tracked targets are not unique physical people'};
  }
}
