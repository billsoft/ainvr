import {request} from './httpClient'
import {aiChannelService} from './aiChannelService'
import {channelService} from './channelService'
import {resolveAlarmOutput} from '@/features/alarmNavigation'
export interface AlarmEvent {
 version?:number;playback_stream_id?:string;
 alarm_id:string;occurred_at:string;last_seen_at:string;channel_id:string;behavior:string;input_stream_id?:string;trigger_id?:string;activity_started_at?:string
 analysis_evidence?:{started_at?:string;source:{width:number;height:number};review_context?:{schema_version?:string;anchor?:string;approach_px?:number|null;region:{points:[number,number][]}|null;trace:{frame_id?:string;bbox:{x:number;y:number;w:number;h:number};event_eligible:boolean;observation:string;source_pts_ns:string}[]}}
 rule:{id:string;name:string};severity:string;lifecycle:{state:string;end_reason?:string}
 handling:{reviewed_by_kind?:'human'|'ai';state:string;revision:number;acknowledged_by?:string;acknowledged_at?:string;note?:string;disposition?:string}
 stages?:{event_id:string;behavior:string;at:string;direction:unknown;behavior_event_ids?:string[];trigger_id?:string;zone_id?:string|null}[]
 review?:{evidence_mode?:'all_keyframes'|'verified_behavior_available_visuals';missing_frame_ids?:string[];recovery?:{state:string;reason?:string;attempt?:number};submitted_prompts?:{frame_id:string;label:string;description:string;caller_template:string;scope:string}[];reference?:{state:string;reason?:string;score?:number;completed_at?:string;attempt?:number;scope?:string;model?:{package_id:string;package_sha256:string}};context_frames?:{key:string;frame_id:string;layout:string;width:number;height:number}[];prepared_frames?:{key:string;frame_id:string;layout:string;width:number;height:number}[];frames?:{key:string;roles?:string[];frame_id?:string;captured_at:string;source_pts_ns:string;source_kind?:'full_frame'|'retained_target';width?:number;height?:number;crop_event_id?:string;bbox:{x:number;y:number;w:number;h:number}}[];frame_scores?:number[];geometry_verified?:boolean;state:string;reason?:string;score?:number;completed_at?:string;attempt?:number;policy?:{description:string};model?:{package_id:string;package_sha256:string}}
 logs?:{operation_id:string;action:string;actor:string;at:string;note?:string}[]
}
export interface AlarmFilters {disposition?:string;review?:string;channel_id?:string;zone_id?:string;behavior?:string;from?:string;to?:string}
export interface AckItem {alarm_id:string;expected_handling_revision:number}
export interface AckResult {alarm_id:string;outcome:string}
/** handled = dealt with; false_positive = not a real event (kept for statistics review). */
export type AckDisposition='handled'|'false_positive'
export const alarmEventService={
 purge:(password:string,key:string)=>request<{cleared:boolean;deleted_count:number;cutoff:string}>('/alarms/purge',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({scope:'all',password}),signal:AbortSignal.timeout(35000)}),
 summary:()=>request<{pending:number;as_of:string;automatic_review?:{mode:'confirm_only';accuracy_validated:boolean;approve_above:number;labels:string[]}|null;reference?:{active:boolean;counts:Record<string,number>}}>('/alarms/events/summary',{signal:AbortSignal.timeout(8000)}),
 list:(status:string,cursor?:string,filters:AlarmFilters={})=>request<{items:AlarmEvent[];next_cursor:string|null}>(`/alarms/events?${new URLSearchParams({status,limit:'50',...filters,...(cursor?{cursor}:{})})}`,{signal:AbortSignal.timeout(15000)}),
 get:async(id:string):Promise<AlarmEvent>=>{
  const row=await request<AlarmEvent>(`/alarms/events/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)})
  try{
   const [ai,channels]=await Promise.all([aiChannelService.get(row.channel_id),channelService.list()])
   return {...row,playback_stream_id:resolveAlarmOutput(row,ai,channels)}
  }catch{return {...row,playback_stream_id:undefined}}
 },
 confirm:(items:AckItem[],note:string,key:string,disposition:AckDisposition='handled')=>request<{items:AckResult[]}>('/alarms/bulk-acknowledgements',{
  method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({items,note,disposition}),signal:AbortSignal.timeout(35000),
 }),
}
