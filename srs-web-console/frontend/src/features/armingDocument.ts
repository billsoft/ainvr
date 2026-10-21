import {createArmingDraft,type ArmingSnapshot} from './armingDraft'
import type {ZonePoint} from './alarmGeometry'
import type {ArmingSaveRequest} from './armingSaveSession'
export interface ArmingZoneDocument {
 zone_id:string;channel_id:string;geometry_revision:string;version:number;state:'active';
 name:string;points:ZonePoint[];edge_ids:string[];erp_wrap?:boolean
}
export interface ArmingAssignmentDocument {
 assignment_id:string;trigger_id:string;input_stream_id:string;processor_id:string;
 zone_id:string|null;zone_version:number|null;geometry_revision:string;label_map_version:string;
 entry_edges:string[];exit_edges:string[];approach_width_percent?:number
}
export interface ArmingDocument {
 source_id:string;geometry_revision:string;revision:number;coordinate_space?:'planar'|'erp';
 zones:ArmingZoneDocument[];assignments:ArmingAssignmentDocument[]
}
/** Explicit destructive draft reset only; the original document remains the
 * concurrency/deletion baseline until the user saves the complete replacement. */
export function resetArmingForGeometry(sourceId:string,geometryRevision:string,document:ArmingDocument):ArmingSnapshot{
 if(document.source_id!==sourceId||document.geometry_revision===geometryRevision)throw Error('来源或画面规格不符合重新布防条件')
 return {sourceId,geometryRevision,revision:document.revision,zones:[],assignments:[]}
}
export function readArmingSnapshot(sourceId:string,geometryRevision:string,document:ArmingDocument|null):ArmingSnapshot{
 if(document&&(document.source_id!==sourceId||document.geometry_revision!==geometryRevision))throw Error('来源或画面规格已改变，请重新确认布防')
 const snapshot:ArmingSnapshot={sourceId,geometryRevision,...(document?.coordinate_space?{coordinateSpace:document.coordinate_space}:{}),revision:document?.revision??0,
  zones:(document?.zones??[]).map(z=>({id:z.zone_id,name:z.name,points:structuredClone(z.points),edgeIds:[...z.edge_ids],version:z.version,...(z.erp_wrap?{erpWrap:true}:{})})),
  assignments:(document?.assignments??[]).map(a=>({id:a.assignment_id,triggerId:a.trigger_id,processorId:a.processor_id,zoneId:a.zone_id,
   entryEdges:[...a.entry_edges],exitEdges:[...a.exit_edges],version:0,needsDirectionConfirmation:false,
   ...(a.approach_width_percent===undefined?{}:{approachWidthPercent:a.approach_width_percent})})),
 }
 createArmingDraft(snapshot)
 return snapshot
}
/** API saves the complete source document, never the draft's changed-row delta.
 * An unchanged assignment retains its label contract. Selecting a new processor
 * requires an explicitly observed catalog version, not an inferred latest one. */
export function buildArmingRequest(snapshot:ArmingSnapshot,base:ArmingDocument|null,labelVersions:Record<string,string>={},resetGeometry=false):ArmingSaveRequest{
 if(base&&(base.source_id!==snapshot.sourceId||(!resetGeometry&&base.geometry_revision!==snapshot.geometryRevision)||base.revision!==snapshot.revision))throw Error('布防版本已变化，请重新读取')
 if(resetGeometry&&(!base||base.geometry_revision===snapshot.geometryRevision||
  snapshot.zones.some(z=>base.zones.some(old=>old.zone_id===z.id))||
  snapshot.assignments.some(a=>base.assignments.some(old=>old.assignment_id===a.id))))throw Error('规格变化后请重新绘制热区并重新选用触发器')
 createArmingDraft(snapshot).changeSet()
 const zones:ArmingZoneDocument[]=snapshot.zones.map(z=>{
  const old=base?.zones.find(o=>o.zone_id===z.id)
  const unchanged=old&&old.name===z.name&&!!old.erp_wrap===!!z.erpWrap&&JSON.stringify(old.points)===JSON.stringify(z.points)&&JSON.stringify(old.edge_ids)===JSON.stringify(z.edgeIds)
  return {zone_id:z.id,channel_id:snapshot.sourceId,geometry_revision:snapshot.geometryRevision,
   version:old?(unchanged?old.version:old.version+1):1,state:'active',name:z.name,points:structuredClone(z.points),edge_ids:[...z.edgeIds],...(z.erpWrap?{erp_wrap:true}:{})}
 })
 const assignments:ArmingAssignmentDocument[]=snapshot.assignments.map(a=>{
  const old=base?.assignments.find(o=>o.assignment_id===a.id)
  const labelVersion=labelVersions[a.id]??(old?.processor_id===a.processorId&&old.trigger_id===a.triggerId?old.label_map_version:undefined)
  if(!labelVersion)throw Error('请确认所选 AI 处理器的目标标签')
  return {assignment_id:a.id,trigger_id:a.triggerId,input_stream_id:snapshot.sourceId,processor_id:a.processorId,
   zone_id:a.zoneId,zone_version:zones.find(z=>z.zone_id===a.zoneId)?.version??null,
   geometry_revision:snapshot.geometryRevision,label_map_version:labelVersion,
   entry_edges:[...a.entryEdges],exit_edges:[...a.exitEdges],
   ...(a.approachWidthPercent===undefined?{}:{approach_width_percent:a.approachWidthPercent})}
 })
 return {...(snapshot.coordinateSpace?{coordinateSpace:snapshot.coordinateSpace}:{}),sourceId:snapshot.sourceId,geometryRevision:snapshot.geometryRevision,expectedRevision:snapshot.revision,zones,assignments,
  removedZoneIds:(base?.zones??[]).filter(z=>!zones.some(n=>n.zone_id===z.zone_id)).map(z=>z.zone_id),
  removedAssignmentIds:(base?.assignments??[]).filter(a=>!assignments.some(n=>n.assignment_id===a.assignment_id)).map(a=>a.assignment_id)}
}
