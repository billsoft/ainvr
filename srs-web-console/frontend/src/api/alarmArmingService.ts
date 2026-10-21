import {request} from './httpClient'
import {newAlarmOperationId} from './alarmZoneService'
import {createArmingSaveSession,type ArmingSaveRequest,type ArmingSaveResult} from '@/features/armingSaveSession'
import type {ArmingDocument} from '@/features/armingDocument'
export const alarmArmingService={
 read:(sourceId:string)=>request<{arming:ArmingDocument|null}>(`/alarms/arming/${encodeURIComponent(sourceId)}`,{signal:AbortSignal.timeout(15000)}),
 save:(input:ArmingSaveRequest,key:string)=>request<ArmingSaveResult>(`/alarms/arming/${encodeURIComponent(input.sourceId)}`,{
  method:'POST',headers:{'Idempotency-Key':key},signal:AbortSignal.timeout(35000),
  body:JSON.stringify({arming:{...(input.coordinateSpace?{coordinate_space:input.coordinateSpace}:{}),source_id:input.sourceId,geometry_revision:input.geometryRevision,zones:input.zones,assignments:input.assignments},expected_revision:input.expectedRevision}),
 }),
}
export const newArmingSaveSession=()=>createArmingSaveSession(alarmArmingService.save,newAlarmOperationId)
