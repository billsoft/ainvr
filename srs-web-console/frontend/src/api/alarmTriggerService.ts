import {request} from './httpClient'
import {newAlarmOperationId} from './alarmZoneService'
import type {AlarmTrigger,TriggerInput} from '@/features/alarmTriggers'

/** One AI channel's current input, model labels and tracking state, as confirmed by the console. */
export interface AlarmSource {
 channel_id:string;channel_name:string;input_stream_id:string;input_name:string
 label_map_version:string;geometry_revision:string;tracking_available:boolean;detection_available?:boolean
 labels:{class_id:number;label_id:string;name:string;description:string}[]
}
export interface TriggerApplication {state:'applied'|'pending'|'unavailable';desired_revision?:string|null;applied_revision?:string|null;reason?:string}
export interface TriggerSaveResult {saved:true;trigger:AlarmTrigger;application:TriggerApplication}
export const alarmTriggerService={
 source:(id:string)=>request<AlarmSource>(`/alarms/sources/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(20000)}),
 list:()=>request<{items:AlarmTrigger[]}>('/alarms/triggers',{signal:AbortSignal.timeout(15000)}),
 save:(trigger:TriggerInput,version:number,key:string)=>request<TriggerSaveResult>('/alarms/triggers',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({trigger,expected_version:version}),signal:AbortSignal.timeout(35000)}),
 setState:async(id:string,state:'paused'|'archived',version:number,key:string)=>{
  const result=await request<TriggerSaveResult>(`/alarms/triggers/${encodeURIComponent(id)}/state`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({state,expected_version:version}),signal:AbortSignal.timeout(35000)})
  if(result.saved!==true||result.trigger.trigger_id!==id||result.trigger.version!==version+1||result.trigger.state!==state)throw Error('停用返回值未确认')
  return result
 },
 synchronize:()=>request<TriggerApplication>('/alarms/triggers/synchronize',{method:'POST',body:'{}',signal:AbortSignal.timeout(35000)}),
}
// An uncertain write is settled with the same key before any edited save.
export function createTriggerSaveSession(initialVersion:number,send=alarmTriggerService.save){
 let version=initialVersion,pending:{input:TriggerInput;version:number;key:string}|undefined,last:TriggerSaveResult|undefined,busy=false
 const settle=async()=>{
  if(!pending)return
  const op=pending,result=await send(op.input,op.version,op.key)
  if(result.saved!==true||result.trigger.trigger_id!==op.input.trigger_id||result.trigger.version!==op.version+1)throw Error('触发器保存响应不匹配')
  version=result.trigger.version;last=result;pending=undefined
 }
 return {save:async(input:TriggerInput)=>{
  if(busy)throw Error('触发器正在保存')
  busy=true
  try{
   const desired=structuredClone(input),previous=pending?.input
   await settle()
   if(previous&&JSON.stringify(previous)===JSON.stringify(desired))return last!
   pending={input:desired,version,key:newAlarmOperationId()};await settle();return last!
  }finally{busy=false}
 }}
}
