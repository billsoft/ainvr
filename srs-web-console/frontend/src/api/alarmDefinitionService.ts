import {request} from './httpClient'
import {newAlarmOperationId} from './alarmZoneService'
import type {TriggerApplication} from './alarmTriggerService'
import type {TriggerDefinition,TriggerDefinitionInput} from '@/features/alarmDefinitions'
export interface DefinitionSaveResult {saved:true;trigger:TriggerDefinition;application:TriggerApplication}
export const alarmDefinitionService={
 list:()=>request<{items:TriggerDefinition[]}>('/alarms/definitions',{signal:AbortSignal.timeout(15000)}),
 save:(definition:TriggerDefinitionInput,version:number,key:string)=>request<DefinitionSaveResult>('/alarms/definitions',{
  method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({definition,expected_version:version}),signal:AbortSignal.timeout(35000),
 }),
}
export function createDefinitionSaveSession(version:number,send=alarmDefinitionService.save){
 let pending:{input:TriggerDefinitionInput;key:string}|null=null,busy=false
 return {save:async(input:TriggerDefinitionInput)=>{
  if(busy)throw Error('正在保存')
  if(pending&&JSON.stringify(input)!==JSON.stringify(pending.input))throw Error('请先确认上一次保存，再修改内容')
  pending??={input:structuredClone(input),key:newAlarmOperationId()}
  busy=true
  try{
   const result=await send(pending.input,version,pending.key)
   if(result.saved!==true||result.trigger.trigger_id!==pending.input.trigger_id||result.trigger.version!==version+1||
    !['applied','pending','unavailable'].includes(result.application?.state))throw Error('保存结果尚未确认')
   pending=null;version=result.trigger.version;return result
  }catch(e){
   // A definitive validation/conflict result permits a corrected request. Unknown
   // transport outcomes retain the exact key and frozen input.
   if([400,409,422].includes((e as {status?:number}).status??0))pending=null
   throw e
  }finally{busy=false}
 }}
}
