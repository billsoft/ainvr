// Copyright AINVR. Optional source-coordinate target-time, from the dwell pair walk.
import {digest} from './domain.mjs';
export const HEAT_COLUMNS=16,HEAT_ROWS=9,HEAT_MAX_GRIDS=128;
const MINUTE=60000,iso=ms=>new Date(ms).toISOString();

// Grids contain temporal sums only. No points, tracks, frames or images persist.
// Open minutes are intentionally absent from queries until minute close/reset.
export function suspendRegionHeat(state,frame,reason='heat_capacity',discarded=[]){
  const gaps=[...(state?.gaps??[])];
  const earliest=Math.min(Date.parse(frame.captured_at),...[...Object.values(state?.grids??{}),...discarded].map(g=>Date.parse(g.from)).filter(Number.isFinite));
  if(!gaps.some(g=>g.stream_session_id===frame.stream_session_id&&g.to===null))gaps.push({stream_session_id:frame.stream_session_id,from:iso(earliest),to:null,reason});
  return {disabled_session:frame.stream_session_id,gaps:gaps.slice(-64)};
}
export function beginRegionHeat(previous,frame,{gap=false,restart=false,previous:checkpoint=null}={}){
  let state=structuredClone(previous??{}),facts=[],issues=[];
  const wall=Date.parse(frame.captured_at),minute=Math.floor(wall/MINUTE)*MINUTE;
  for(const entry of state.gaps??[])if(entry.to===null&&entry.stream_session_id!==frame.stream_session_id)entry.to=frame.captured_at;
  if(state.disabled_session&&state.disabled_session!==frame.stream_session_id)state={gaps:state.gaps??[]};
  const source=digest([frame.input_stream_id,frame.source,frame.model.label_map_version,frame.observation_mode??'tracks']);
  const reason=restart?'consumer_restart':state.session&&state.session!==frame.stream_session_id?'session_changed':
    state.source&&state.source!==source?'source_changed':
    checkpoint?.pts!=null&&BigInt(frame.source_pts_ns)<=BigInt(checkpoint.pts)?'pts_reset':
    gap||frame.gap||checkpoint?.seq!=null&&checkpoint.session===frame.stream_session_id&&BigInt(frame.seq)!==BigInt(checkpoint.seq)+1n?'input_gap':null;
  function seal(id,reason){const {_signature,...row}=state.grids[id];facts.push({...row,seal_reason:reason,partial:true});delete state.grids[id];}
  if(!state.disabled_session){
    state.grids??={};
    if(reason){for(const id of Object.keys(state.grids))seal(id,reason);state.generation=frame.seq;}
    state.generation??=frame.seq;state.session=frame.stream_session_id;state.source=source;
  }
  function suspend(reason){state=suspendRegionHeat(state,frame,reason,facts);facts=[];issues.push(reason);}
  let legacyLabelMap=false;
  function regions(zones){
    if(state.disabled_session)return;
    const allowed=new Map(zones.map(z=>[JSON.stringify([z.zone_id,z.zone_version]),z]));
    let changed=false;
    for(const g of Object.values(state.grids)){
      const z=allowed.get(JSON.stringify([g.zone_id,g.zone_version]));
      if(g.label_map_version===undefined||g.label_map_version===null){legacyLabelMap=true;changed=true;}
      if(!z||digest(z.signature)!==g._signature||!z.labels.has(g.label_id))changed=true;
    }
    if(changed){for(const id of Object.keys(state.grids))seal(id,legacyLabelMap?'label_map_upgrade':'configuration_changed');state.generation=frame.seq;}
  }
  function add(pair){
    if(state.disabled_session)return;
    // Dimensions/model/source changes may not reset a legacy dwell state;
    // never integrate its old endpoint into a new coordinate frame.
    if(reason||legacyLabelMap){issues.push(legacyLabelMap?'heat_label_map_unknown':'heat_continuity_reset');return;}
    const {from_ms:from,to_ms:to,point:p,zone:z,label_id:label}=pair;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from||to-from>1500||to!==wall){suspend('heat_invalid_pair');return;}
    const x=z.erp_wrap?((p[0]%1)+1)%1:p[0],y=p[1];
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1){suspend('heat_invalid_anchor');return;}
    const cell=Math.min(HEAT_ROWS-1,Math.floor(y*HEAT_ROWS))*HEAT_COLUMNS+Math.min(HEAT_COLUMNS-1,Math.floor(x*HEAT_COLUMNS));
    const signature=digest(z.signature);
    for(let at=from;at<to;){
      const start=Math.floor(at/MINUTE)*MINUTE,end=start+MINUTE,next=Math.min(end,to);
      const id=digest(['region-heat-v1',frame.channel_id,frame.stream_session_id,state.generation,signature,z.zone_id,z.zone_version,label,start]);
      let grid=state.grids[id];
      if(!grid){
        if(Object.keys(state.grids).length>=HEAT_MAX_GRIDS){suspend('heat_grid_capacity');return;}
        grid=state.grids[id]={_id:id,_signature:signature,channel_id:frame.channel_id,input_stream_id:frame.input_stream_id,stream_session_id:frame.stream_session_id,
          zone_id:z.zone_id,zone_version:z.zone_version,label_id:label,geometry_revision:z.geometry_revision,view_epoch:z.view_epoch,
          label_map_version:frame.model.label_map_version,
          source_width:frame.source.width,source_height:frame.source.height,anchor:z.anchor,erp_wrap:z.erp_wrap,columns:HEAT_COLUMNS,rows:HEAT_ROWS,
          from:iso(start),to:iso(end),values_ms:Array(HEAT_COLUMNS*HEAT_ROWS).fill(0),observed_ms:0};
      }
      grid.values_ms[cell]+=next-at;grid.observed_ms+=next-at;at=next;
    }
  }
  function finish(dwellIssues=[]){
    state.last_frame_at=frame.captured_at;
    if(state.disabled_session)issues.push('heat_capacity_suspended');
    else {
      for(const [id,g] of Object.entries(state.grids))if(Date.parse(g.to)<=wall)seal(id,'minute_closed');
      if(frame.observation_mode==='detections')issues.push('heat_tracking_required');
      if(dwellIssues.some(x=>['dwell_capacity','dwell_region_capacity','dwell_region_conflict'].includes(x))){
        issues.push('heat_dwell_limited');
        const gaps=state.gaps??=[];const from=checkpoint?.region_heat?.last_frame_at??iso(wall-1500),to=iso(wall+1),last=gaps.at(-1);
        if(last?.reason==='heat_dwell_limited'&&last.to>=from)last.to=to;
        else gaps.push({stream_session_id:frame.stream_session_id,from,to,reason:'heat_dwell_limited'});state.gaps=gaps.slice(-64);
      }
    }
    return {state,facts,issues:[...new Set(issues)]};
  }
  return {regions,add,finish,suspend};
}
export async function materializeRegionHeat(db,facts,hook=async()=>{}){
  if(!db)throw Error('Region heat requires repository.db');
  await db.collection('region_heat_minutes').bulkWrite(facts.map(row=>({updateOne:{filter:{_id:row._id},update:{$setOnInsert:row},upsert:true}})),{ordered:false,timeoutMS:750,maxTimeMS:700});
  await hook('heat_inserted');
}
