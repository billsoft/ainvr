import {request} from './httpClient'
import {newAlarmOperationId} from './alarmZoneService'
import {createArmingSaveSession,type ArmingSaveRequest,type ArmingSaveResult} from '@/features/armingSaveSession'
import type {ArmingDocument} from '@/features/armingDocument'
export const alarmArmingService={
 read:(sourceId:string,processorId?:string)=>request<{arming:ArmingDocument|null}>(`/alarms/arming/${encodeURIComponent(sourceId)}${processorId?`?processor_id=${encodeURIComponent(processorId)}`:""}`,{signal:AbortSignal.timeout(15000)}),
 save:(input:ArmingSaveRequest,key:string,processorId?:string)=>request<ArmingSaveResult>(`/alarms/arming/${encodeURIComponent(input.sourceId)}`,{
  method:'POST',headers:{'Idempotency-Key':key},signal:AbortSignal.timeout(35000),
  body:JSON.stringify({arming:{...(processorId?{processor_id:processorId}:{}),...(input.coordinateSpace?{coordinate_space:input.coordinateSpace}:{}),source_id:input.sourceId,geometry_revision:input.geometryRevision,zones:input.zones,assignments:input.assignments,counter_bindings:input.counterBindings},expected_revision:input.expectedRevision}),
 }),
}
export const newArmingSaveSession=()=>createArmingSaveSession(alarmArmingService.save,newAlarmOperationId)
