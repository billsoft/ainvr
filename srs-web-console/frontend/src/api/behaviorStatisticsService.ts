import {request} from './httpClient'
export interface BehaviorCount {event_type:string;occurrences:number;tracked_targets:number;group?:string|number|null}
export interface BehaviorStatistics {
 group_by?:string;schema_version:string;from:string;to:string;items:BehaviorCount[]
 buckets?: (BehaviorCount & {from:string;to:string})[]
 bucket?:'minute'|'hour'|'day';timezone?:string
 coverage:{state:string;reason?:string};missing_bucket_policy?:string
}
export interface StatisticsQuery {from:string;to:string;bucket:'minute'|'hour'|'day';channel_id?:string;event_type?:string;timezone?:string;zone_id?:string;label_id?:string;trigger_id?:string;group_by?:'trigger'|'entry_direction'|'exit_direction'|'movement_direction'}
export const behaviorStatisticsService={
 query:(query:StatisticsQuery)=>{
  const params=new URLSearchParams()
  for(const [key,value] of Object.entries(query))if(value)params.set(key,value)
  return request<BehaviorStatistics>(`/alarms/behavior-statistics?${params}`,{signal:AbortSignal.timeout(15000)})
 },
}