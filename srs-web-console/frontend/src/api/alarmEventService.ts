import {request} from './httpClient'
export interface AlarmEvent {
 alarm_id:string;occurred_at:string;last_seen_at:string;channel_id:string;behavior:string;input_stream_id?:string;trigger_id?:string;activity_started_at?:string
 rule:{id:string;name:string};severity:string;lifecycle:{state:string;end_reason?:string}
 handling:{state:string;revision:number;acknowledged_by?:string;acknowledged_at?:string;note?:string;disposition?:string}
 stages?:{event_id:string;behavior:string;at:string;direction:unknown;behavior_event_ids?:string[];trigger_id?:string;zone_id?:string|null}[]
 logs?:{operation_id:string;action:string;actor:string;at:string;note?:string}[]
}
export interface AlarmFilters {channel_id?:string;zone_id?:string;behavior?:string;from?:string;to?:string}
export interface AckItem {alarm_id:string;expected_handling_revision:number}
export interface AckResult {alarm_id:string;outcome:string}
/** handled = dealt with; false_positive = not a real event (kept for statistics review). */
export type AckDisposition='handled'|'false_positive'
export const alarmEventService={
 summary:()=>request<{pending:number;as_of:string}>('/alarms/events/summary',{signal:AbortSignal.timeout(8000)}),
 list:(status:string,cursor?:string,filters:AlarmFilters={})=>request<{items:AlarmEvent[];next_cursor:string|null}>(`/alarms/events?${new URLSearchParams({status,limit:'50',...filters,...(cursor?{cursor}:{})})}`,{signal:AbortSignal.timeout(15000)}),
 get:(id:string)=>request<AlarmEvent>(`/alarms/events/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)}),
 confirm:(items:AckItem[],note:string,key:string,disposition:AckDisposition='handled')=>request<{items:AckResult[]}>('/alarms/bulk-acknowledgements',{
  method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({items,note,disposition}),signal:AbortSignal.timeout(35000),
 }),
}
