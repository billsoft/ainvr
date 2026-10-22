import {request} from './httpClient'
import {newAlarmOperationId} from './alarmZoneService'
import type {TriggerApplication} from './alarmTriggerService'

/** A counter defines what is counted and how; it is selected onto zones in 布防. */
export type CounterMethod='line'|'gates'|'zone'
export interface CounterInput {
 counter_id:string;name:string;labels:{label_id:string;name:string}[]
 method:CounterMethod;outputs:'both'|'in';names:{in:string;out:string}
 occupancy:boolean;max_gap_ms:number;state:'enabled'|'paused'
}
export type BindingDirection=
 |{kind:'line';edge:string;in_side:'inward'|'outward'}
 |{kind:'gates';from:string;to:string}
 |{kind:'edges';entry:string[];exit:string[]}
 |{kind:'angle';entry:{from:number;to:number};exit:{from:number;to:number}}
export interface CounterUsage {binding_id:string;source_id:string;processor_id:string;zone_id:string;zone_name:string|null;active:boolean;counting:boolean;direction:BindingDirection}
/** deleting: counting stopped but its records are not purged yet; only a retry is possible. */
export interface Counter extends CounterInput {version:number;bindings:CounterUsage[];deleting?:boolean}
export interface Coverage {state:'complete'|'partial'|'no_data';gaps?:{from:string;to:string}[]}
export interface SeriesTotal {occurrences:number;buckets:{from:string;to:string;occurrences:number}[];coverage:Coverage['state']}
export interface ZoneSeries {occurrences:number;tracked_targets:number;coverage:Coverage;buckets:{from:string;to:string;occurrences:number}[]}
export interface CounterResult {
 counter:Counter;in:SeriesTotal;out?:SeriesTotal
 zones:(Omit<CounterUsage,'zone_name'>&{zone_name:string|null;in?:ZoneSeries;out?:ZoneSeries})[]
}
export interface Passage {
 event_id:string;occurred_at:string;track_id:string;label_id:string;frame_id:string;stream_session_id:string
 quality?:{observation_gaps?:number;gap_ms?:number}
}
export interface LiveCount {binding_id:string;counter_id:string;name:string;names:{in:string;out:string};outputs:'both'|'in';occupancy:boolean;counting:boolean;zone_id:string;direction:BindingDirection;in:number;out?:number}
export interface CounterSaveResult {saved:true;counter:CounterInput&{version:number};application:TriggerApplication}
export const flowService={
 list:()=>request<{items:Counter[]}>('/flow/counters',{signal:AbortSignal.timeout(15000)}),
 save:(counter:CounterInput,version:number,key:string)=>request<CounterSaveResult>('/flow/counters',{method:'POST',headers:{'Idempotency-Key':key},
  body:JSON.stringify({counter,expected_version:version}),signal:AbortSignal.timeout(35000)}),
 query:(input:{counter_ids?:string[];from:string;to:string;bucket?:'minute'|'hour'|'day'|null;timezone:string})=>
  request<{from:string;to:string;items:CounterResult[]}>('/flow/query',{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(60000)}),
 records:(input:{counter_id:string;binding_id:string;output:'in'|'out';from:string;to:string;cursor?:string;limit?:number})=>
  request<{items:Passage[];next_cursor:string|null}>('/flow/records',{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(30000)}),
 remove:(counterId:string,version:number,key:string)=>request<{deleted:true}>(`/flow/counters/${encodeURIComponent(counterId)}/delete`,{method:'POST',headers:{'Idempotency-Key':key},
  body:JSON.stringify({expected_version:version}),signal:AbortSignal.timeout(60000)}),
 live:(sourceId:string,from:string)=>request<{items:LiveCount[]}>(`/flow/live?source_id=${encodeURIComponent(sourceId)}&from=${encodeURIComponent(from)}`,{signal:AbortSignal.timeout(15000)}),
}
/** Same contract as trigger definitions: an unconfirmed save keeps its key and frozen input. */
export function createCounterSaveSession(version:number,send=flowService.save){
 let pending:{input:CounterInput;key:string}|null=null,busy=false
 return {hasPending:()=>!!pending,save:async(input:CounterInput)=>{
  if(busy)throw Error('正在保存')
  if(pending&&JSON.stringify(input)!==JSON.stringify(pending.input))throw Error('请先确认上一次保存，再修改内容')
  pending??={input:structuredClone(input),key:newAlarmOperationId()}
  busy=true
  try{
   const result=await send(pending.input,version,pending.key)
   if(result.saved!==true||result.counter.counter_id!==pending.input.counter_id||result.counter.version!==version+1)throw Error('保存结果尚未确认')
   pending=null;version=result.counter.version;return result
  }catch(e){
   if([400,409,422].includes((e as {status?:number}).status??0))pending=null
   throw e
  }finally{busy=false}
 }}
}
export const methodNames:Record<CounterMethod,string>={line:'越过一条线',gates:'依次经过两条线',zone:'穿过整个区域'}
export const methodHelp:Record<CounterMethod,string>={
 line:'在热区的一条边上计数，最适合门口和通道。',
 gates:'依次越过两条边才计一次，适合狭长通道，最不易误计。',
 zone:'从热区的一边进入、另一边离开时计一次。',
}
export function startOfToday(now=new Date()){const d=new Date(now);d.setHours(0,0,0,0);return d}
