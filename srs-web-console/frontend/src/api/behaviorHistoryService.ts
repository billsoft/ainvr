import {request} from './httpClient'
export interface BehaviorHistoryQuery {trigger_id?:string;from:string;to:string;channel_id?:string;zone_id?:string;label_id?:string;event_type?:string}
export interface BehaviorFact {
 event_id:string;event_type:string;occurred_at:string;started_at:string|null
 channel_id:string;input_stream_id:string;stream_session_id:string;track_id:string;label_id:string
 zone_id:string|null;zone_version:number|null;rule_id:string;rule_version:number;trigger_id?:string|null
 direction:unknown;quality:{basis:string;trajectory_complete:boolean|null}
 frame_id:string;source_pts_ns:string;evidence_refs:unknown[]
}
export interface BehaviorHistory {items:BehaviorFact[];next_cursor:string|null}
export const behaviorHistoryService={
 list:(query:BehaviorHistoryQuery,cursor?:string)=>{
  const params=new URLSearchParams({...query,limit:'50',...(cursor?{cursor}:{})})
  return request<BehaviorHistory>(`/alarms/behavior-events?${params}`,{signal:AbortSignal.timeout(15000)})
 },
 get:(id:string)=>request<BehaviorFact>(`/alarms/behavior-events/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)}),
}