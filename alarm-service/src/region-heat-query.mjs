// Copyright AINVR. Rolling source-image target-time; never a ground-plane map.
import {digest,fail,identity} from './domain.mjs';
import {HEAT_COLUMNS,HEAT_ROWS} from './region-heat.mjs';
import {performance} from 'node:perf_hooks';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
const COLLECTION='region_heat_minutes',MAX_BYTES=64*1024*1024,MAX_ROWS=50000,MINUTE=60000;
const QUERY_DEADLINE_MS=15000,CURSOR_BATCH_SIZE=128;
const GRID_PROJECTION={_id:0,columns:1,rows:1,values_ms:1,observed_ms:1,geometry_revision:1,view_epoch:1,zone_version:1,label_map_version:1,input_stream_id:1,source_width:1,source_height:1,anchor:1,erp_wrap:1,from:1,to:1};
// Compute the open-minute marker on the point lookup without transferring the
// checkpoint's active cell arrays alongside the streamed query grids.
const CHECKPOINT_PROJECTION={'checkpoint.region_heat.disabled_session':1,'checkpoint.region_heat.gaps':1,last_consumed_at:1,last_issues:1,
  open_heat_minute:{$min:{$map:{input:{$objectToArray:{$ifNull:['$checkpoint.region_heat.grids',{}]}},as:'grid',in:'$$grid.v.from'}}}};
const iso=ms=>new Date(ms).toISOString();
export class RegionHeatQuery {
  // Constructor overrides are for isolated tiny-cap tests, not production config.
  constructor(db,{maxBytes=MAX_BYTES,maxRows=MAX_ROWS,now=()=>performance.now()}={}){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>MAX_BYTES||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>MAX_ROWS)throw Error('Invalid region heat retention limits');
    this.db=db;this.facts=db.collection(COLLECTION);this.checkpoints=db.collection('alarm_consumer_checkpoints');this.limits={max_bytes:maxBytes,max_rows:maxRows};this.now=now;
  }
  async initialize(){
    let info=await this.db.listCollections({name:COLLECTION},{nameOnly:false}).next();
    if(!info){try{await this.db.createCollection(COLLECTION,{capped:true,size:this.limits.max_bytes,max:this.limits.max_rows});}catch(e){if(e.code!==48)throw e;}info=await this.db.listCollections({name:COLLECTION},{nameOnly:false}).next();}
    const options=info?.options??{},size=Number(options.size),max=Number(options.max);
    if(!options.capped||!Number.isSafeInteger(size)||size<1||size>this.limits.max_bytes||!Number.isSafeInteger(max)||max<1||max>this.limits.max_rows)throw Error('Unsupported region_heat_minutes collection: expected capped rolling limits; existing data was not changed');
    this.limits={max_bytes:size,max_rows:max};
    await this.facts.createIndex({channel_id:1,zone_id:1,from:1});await this.facts.createIndex({from:1});
  }
  async query(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['channel_id','zone_id','from','to','label_ids','zone_version'].includes(k)))fail('invalid_heat_query','Invalid region heat query');
    const {channel_id,zone_id,from,to,label_ids,zone_version}=input;identity(channel_id,'channel_id');identity(zone_id,'zone_id');
    const lo=Date.parse(from),hi=Date.parse(to),absolute=v=>typeof v==='string'&&/(?:Z|[+-]\d\d:\d\d)$/i.test(v);
    if(!absolute(from)||!absolute(to)||!Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo||hi-lo>31*86400000)fail('invalid_heat_range','Use an absolute range of at most 31 days');
    if(label_ids!==undefined){if(!Array.isArray(label_ids)||!label_ids.length||label_ids.length>128)fail('invalid_heat_query','Invalid labels');label_ids.forEach(x=>identity(x,'label_id'));}
    if(zone_version!==undefined&&(!Number.isSafeInteger(zone_version)||zone_version<1))fail('invalid_heat_query','Invalid zone version');
    const start=Math.ceil(lo/MINUTE)*MINUTE,end=Math.floor(hi/MINUTE)*MINUTE,contained=end>start,edges=[];
    if(!contained)edges.push({from:iso(lo),to:iso(hi)});
    else {if(start>lo)edges.push({from:iso(lo),to:iso(start)});if(end<hi)edges.push({from:iso(end),to:iso(hi)});}
    const filter={channel_id,zone_id,from:{$gte:iso(start),$lt:iso(end)},to:{$lte:iso(end)}};
    if(label_ids!==undefined)filter.label_id={$in:[...new Set(label_ids)]};if(zone_version!==undefined)filter.zone_version=zone_version;
    const deadline=this.now()+QUERY_DEADLINE_MS;
    const remaining=()=>{const ms=Math.floor(deadline-this.now());if(ms<=0)fail('heat_query_timeout','Region heat query exceeded its 15 second deadline; retry a narrower range',503);return ms;};
    const budget=()=>{const ms=remaining();return {timeoutMS:ms,maxTimeMS:ms};};
    let checkpoint,oldest,cursor;
    const variants=new Map(),issues=new Set();
    try{
      checkpoint=await this.checkpoints.findOne({channel_id},{projection:CHECKPOINT_PROJECTION,...budget()});
      oldest=await this.facts.findOne({},{sort:{from:1},projection:{_id:0,from:1},...budget()});
      for(const issue of checkpoint?.last_issues??[])if(typeof issue==='string'&&issue.startsWith('heat_'))issues.add(issue);
      // No blocking data sort or materialized row array. Mongo's lifetime CSOT
      // bounds find/getMore waits; the monotonic deadline also covers CPU work.
      // The extra row detects concurrent capped turnover or incompatible data
      // beyond the retained bound, rather than silently truncating a total.
      const rowLimit=this.limits.max_rows;
      if(contained)cursor=this.facts.find(filter,{projection:GRID_PROJECTION,batchSize:CURSOR_BATCH_SIZE,limit:rowLimit+1,timeoutMode:'cursorLifetime',...budget()});
      let scanned=0;
      for await(const row of cursor??[]){
        remaining();if(++scanned>rowLimit)fail('heat_query_capacity','Region heat scan exceeded its rolling retention row bound; retry a narrower range');
        if(scanned%CURSOR_BATCH_SIZE===0){await yieldToLoop();remaining();}
        if(row.columns!==HEAT_COLUMNS||row.rows!==HEAT_ROWS||!Array.isArray(row.values_ms)||row.values_ms.length!==HEAT_COLUMNS*HEAT_ROWS||row.values_ms.some(x=>!Number.isSafeInteger(x)||x<0)||row.values_ms.reduce((a,b)=>a+b,0)!==row.observed_ms){issues.add('invalid_heat_row');continue;}
        const labelMap=typeof row.label_map_version==='string'&&row.label_map_version.length?row.label_map_version:null;
        if(labelMap===null)issues.add('heat_label_map_unknown');
        // Disjoint sessions can contribute compatible target-time, never person
        // identity. Keep no session IDs/count sets in this bounded aggregation.
        const geometry={geometry_revision:row.geometry_revision,view_epoch:row.view_epoch,zone_version:row.zone_version,label_map_version:labelMap,input_stream_id:row.input_stream_id,source_width:row.source_width,source_height:row.source_height,anchor:row.anchor,erp_wrap:row.erp_wrap};
        const key=digest(geometry);let variant=variants.get(key);
        if(!variant){if(variants.size>=64)fail('heat_query_capacity','Choose a narrower range or zone version; at most 64 coordinate variants');variant={...geometry,columns:HEAT_COLUMNS,rows:HEAT_ROWS,values_ms:Array(HEAT_COLUMNS*HEAT_ROWS).fill(0),observed_ms:0,from:row.from,to:row.to};variants.set(key,variant);}
        for(let i=0;i<row.values_ms.length;i++)variant.values_ms[i]+=row.values_ms[i];variant.observed_ms+=row.observed_ms;variant.from=variant.from<row.from?variant.from:row.from;variant.to=variant.to>row.to?variant.to:row.to;
      }
      remaining();
    }catch(error){
      if(error.code===50||error.name==='MongoOperationTimeoutError')fail('heat_query_timeout','Region heat query exceeded its 15 second deadline; retry a narrower range',503);
      throw error;
    }finally{
      // Cleanup consumes at most the remaining budget (1 ms after expiry).
      if(cursor)try{await cursor.close({timeoutMS:Math.max(1,Math.min(1000,Math.floor(deadline-this.now())))});}catch{/* Preserve the query's original failure. */}
    }
    const heat=checkpoint?.checkpoint?.region_heat;
    if(edges.length)issues.add('partial_edges_discarded');
    const open=checkpoint?.open_heat_minute??null;
    if(open&&Date.parse(open)<hi&&Date.parse(open)+MINUTE>lo)issues.add('open_minute_lag');
    const gaps=(heat?.gaps??[]).filter(g=>Date.parse(g.from)<hi&&(g.to===null||Date.parse(g.to)>lo));
    return {channel_id,zone_id,from:iso(lo),to:iso(hi),effective_from:contained?iso(start):null,effective_to:contained?iso(end):null,
      variants:[...variants.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v),
      semantics:'lower_bound_observed_target_time',coverage:'unknown',coordinate_space:'normalized_source_image',spatial_allocation:'previous_observed_anchor',
      session_scope:'compatible_source_geometry',
      checkpoint_at:checkpoint?.last_consumed_at??null,consistency:'non_transactional',publication:'sealed_minutes_only',open_minute_from:open,discarded_edges:edges,
      status:heat?.disabled_session?'capacity_suspended':!contained?'no_complete_minutes':variants.size?'recorded':'no_data',issues:[...issues],gaps,
      retention:{mode:'rolling',...this.limits,oldest_available_at:oldest?.from??null,history_complete:false,eviction_order:'insertion',oldest_meaning:'earliest_remaining_minute_not_coverage_start'}};
  }
}
