import {request} from './httpClient'
import type {ZonePoint} from '@/features/alarmGeometry'
import {newOperationId} from '@/utils/operationId'

export function newAlarmOperationId(){
  return newOperationId()
}
export interface AlarmZoneInput {
  zone_id:string;channel_id:string;name:string;geometry_revision:string
  points:ZonePoint[];erp_wrap?:boolean;state:'active'|'archived'
}
export interface AlarmZone extends AlarmZoneInput {version:number;updated_at?:string}
export interface ZoneSaveResult {zone:AlarmZone;saved:true;monitoring_enabled:false}
export const alarmZoneService={
  list:(channelId:string)=>request<{items:AlarmZone[]}>(`/alarms/zones?channel_id=${encodeURIComponent(channelId)}`,{signal:AbortSignal.timeout(15000)}),
  save:(zone:AlarmZoneInput,expectedVersion:number,key:string)=>request<ZoneSaveResult>('/alarms/zones',{
    method:'POST',signal:AbortSignal.timeout(15000),headers:{'Idempotency-Key':key},
    body:JSON.stringify({zone,expected_version:expectedVersion}),
  }),
}

// Keep an uncertain write immutable: settle it with the same key before saving edits.
// A timeout may mean the server committed successfully but its reply was lost.
export function createZoneSaveSession(initialVersion:number,send=alarmZoneService.save){
  let version=initialVersion
  let pending:{zone:AlarmZoneInput;version:number;key:string}|undefined
  let busy=false
  let last:ZoneSaveResult|undefined
  const settle=async()=>{
    if(!pending)return
    const operation=pending
    const result=await send(operation.zone,operation.version,operation.key)
    if(result.saved!==true||result.zone.zone_id!==operation.zone.zone_id||result.zone.version!==operation.version+1)throw Error('区域保存返回值不匹配')
    version=result.zone.version;last=result;pending=undefined
  }
  return {save:async(zone:AlarmZoneInput)=>{
    if(busy)throw Error('正在保存区域')
    busy=true
    try{
      const desired=structuredClone(zone)
      const previous=pending?.zone
      await settle()
      if(previous&&JSON.stringify(previous)===JSON.stringify(desired))return last!
      pending={zone:desired,version,key:newAlarmOperationId()}
      await settle()
      return last!
    }finally{busy=false}
  }}
}
