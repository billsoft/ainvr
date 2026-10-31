import {beginRegionHeat} from '../src/region-heat.mjs';
import {dwellStep} from '../src/dwell-visits.mjs';
export const origin=Date.UTC(2026,0,1);
export const heatRule={id:'counter',name:'counter',version:1,channel_id:'c',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',alarm_enabled:false,zone_id:'z',zone_version:1,points:[[.2,.2],[.8,.2],[.8,.8],[.2,.8]]};
export function heatFrame(seq,{time=seq*100,x=.4,session='s',geometry='g',width=100,height=100,observation='detected',eligible=true,empty=false,label='person'}={}){
  const pts=String(BigInt(time)*1000000n);
  return {schema_version:'1.0',channel_id:'c',input_stream_id:'in',stream_session_id:session,seq:String(seq),frame_id:`${session}:${seq}`,source_pts_ns:pts,captured_at:new Date(origin+time).toISOString(),
    source:{width,height,coordinate_space:'source_pixels',geometry_revision:geometry},model:{label_map_version:'l'},observation_mode:'tracks',
    tracks:empty?[]:[{track_id:'t',label_id:label,state:'confirmed',observation,event_eligible:eligible,last_observed_pts_ns:pts,bbox:{x:x*width,y:.3*height,w:.1*width,h:.1*height}}]};
}
export const heatEnvelope=(seq,options)=>({schema_version:'1.0',producer_id:'producer',offset:String(seq),frame:heatFrame(seq,options)});
export function heatStep(cp,frame,rules=[heatRule],options={}){
  const opts={previous:cp,...options},heat=beginRegionHeat(cp?.region_heat,frame,opts);
  const dwell=dwellStep(cp?.dwell,frame,rules,{...opts,onPair:heat.add,onRegions:heat.regions}),result=heat.finish(dwell.issues);
  return {...result,checkpoint:{region_heat:result.state,dwell:dwell.state,session:frame.stream_session_id,seq:frame.seq,pts:frame.source_pts_ns}};
}
