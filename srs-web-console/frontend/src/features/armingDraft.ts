import {zoneGeometryError,type ZonePoint} from './alarmGeometry'

export interface DraftZone {
  id:string
  name:string
  points:ZonePoint[]
  erpWrap?:boolean
  edgeIds:string[]
  version:number
}
export interface DraftAssignment {
  id:string
  triggerId:string
  processorId:string
  zoneId:string|null
  entryEdges:string[]
  exitEdges:string[]
  version:number
  needsDirectionConfirmation:boolean
  approachWidthPercent?:number
}
export interface ArmingSnapshot {
  coordinateSpace?:'planar'|'erp'
  sourceId:string
  geometryRevision:string
  revision:number
  zones:DraftZone[]
  assignments:DraftAssignment[]
}
const copy=<T,>(value:T):T=>structuredClone(value)
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)

/** Local transaction only: no network calls. Server must repeat compatibility,
 * source, ownership and revision validation before committing this change set. */
export function createArmingDraft(snapshot:ArmingSnapshot){
  const base=copy(snapshot)
  let current=copy(snapshot),past:ArmingSnapshot[]=[],future:ArmingSnapshot[]=[]
  const validate=(s:ArmingSnapshot)=>{
    const names=new Set<string>(),zoneIds=new Set<string>(),assignmentIds=new Set<string>(),bindings=new Set<string>()
    for(const z of s.zones){
      if(!z.id||zoneIds.has(z.id))throw Error('热区编号重复')
      zoneIds.add(z.id)
      const name=z.name.trim()
      if(!name||names.has(name))throw Error('热区名称不能为空或重复')
      names.add(name)
      const error=zoneGeometryError(z.points,z.erpWrap)
      if(error)throw Error(error)
      if(z.edgeIds.length!==z.points.length||new Set(z.edgeIds).size!==z.edgeIds.length||z.edgeIds.some(e=>!e))throw Error('热区边编号无效')
    }
    for(const a of s.assignments){
      if(!a.id||assignmentIds.has(a.id))throw Error('选用编号重复')
      assignmentIds.add(a.id)
      if(!a.triggerId||!a.processorId)throw Error('请选择触发器和 AI 处理器')
      const binding=JSON.stringify([a.triggerId,a.processorId,a.zoneId])
      if(bindings.has(binding))throw Error('同一范围不能重复选用')
      bindings.add(binding)
      const zone=s.zones.find(z=>z.id===a.zoneId)
      if(a.zoneId!==null&&!zone)throw Error('选用的热区不存在')
      if(!zone&&(a.entryEdges.length||a.exitEdges.length))throw Error('整个画面不能设置热区方向')
      if(new Set(a.entryEdges).size!==a.entryEdges.length||new Set(a.exitEdges).size!==a.exitEdges.length||a.entryEdges.some(e=>a.exitEdges.includes(e)))throw Error('方向边重复')
      if(zone&&!a.needsDirectionConfirmation&&[...a.entryEdges,...a.exitEdges].some(e=>!zone.edgeIds.includes(e)))throw Error('方向引用的边不存在')
      if(a.approachWidthPercent!==undefined&&(!Number.isFinite(a.approachWidthPercent)||a.approachWidthPercent<=0||a.approachWidthPercent>100))throw Error('接近距离应为画面宽度的 0～100%（不含 0）')
    }
  }
  validate(base)
  const edit=(operation:(next:ArmingSnapshot)=>void)=>{
    const next=copy(current)
    operation(next);validate(next)
    if(same(next,current))return
    past.push(current);current=next;future=[]
  }
  const findZone=(s:ArmingSnapshot,id:string)=>{
    const zone=s.zones.find(z=>z.id===id)
    if(!zone)throw Error('热区不存在')
    return zone
  }
  return {
    read:()=>copy(current),
    dirty:()=>!same(base,current),
    cancel:()=>{current=copy(base);past=[];future=[]},
    undo:()=>{const prior=past.pop();if(prior){future.push(current);current=prior}},
    redo:()=>{const next=future.pop();if(next){past.push(current);current=next}},
    canUndo:()=>past.length>0,
    canRedo:()=>future.length>0,
    addZone:(zone:DraftZone)=>edit(s=>{s.zones.push(copy(zone))}),
    setCoordinateSpace:(space:'planar'|'erp')=>edit(s=>{if(space!=='erp'&&s.zones.some(z=>z.erpWrap))throw Error('请先移除全景环绕区域');s.coordinateSpace=space}),
    renameZone:(id:string,name:string)=>edit(s=>{findZone(s,id).name=name.trim()}),
    reshapeZone:(id:string,points:ZonePoint[],edgeIds:string[])=>edit(s=>{
      const zone=findZone(s,id)
      if(same(zone.points,points)&&same(zone.edgeIds,edgeIds))return
      zone.points=copy(points);zone.edgeIds=[...edgeIds]
      // Never reinterpret an old direction as "any" after editing its geometry.
      for(const a of s.assignments)if(a.zoneId===id&&(a.entryEdges.length||a.exitEdges.length))a.needsDirectionConfirmation=true
    }),
    replaceZone:(replacement:DraftZone)=>edit(s=>{
      const zone=findZone(s,replacement.id)
      const geometryChanged=!same(zone.points,replacement.points)||!same(zone.edgeIds,replacement.edgeIds)||!!zone.erpWrap!==!!replacement.erpWrap
      Object.assign(zone,copy(replacement),{name:replacement.name.trim(),version:zone.version})
      if(geometryChanged)for(const a of s.assignments)if(a.zoneId===zone.id&&(a.entryEdges.length||a.exitEdges.length))a.needsDirectionConfirmation=true
    }),
    removeZone:(id:string)=>edit(s=>{
      findZone(s,id)
      s.zones=s.zones.filter(z=>z.id!==id)
      s.assignments=s.assignments.filter(a=>a.zoneId!==id)
    }),
    putAssignments:(assignments:DraftAssignment[])=>edit(s=>{
      for(const assignment of assignments){
        const index=s.assignments.findIndex(a=>a.id===assignment.id)
        if(index<0)s.assignments.push(copy(assignment));else s.assignments[index]=copy(assignment)
      }
    }),
    putAssignment:(assignment:DraftAssignment)=>edit(s=>{
      const index=s.assignments.findIndex(a=>a.id===assignment.id)
      if(index<0)s.assignments.push(copy(assignment));else s.assignments[index]=copy(assignment)
    }),
    removeAssignment:(id:string)=>edit(s=>{s.assignments=s.assignments.filter(a=>a.id!==id)}),
    changeSet:()=>{
      if(current.assignments.some(a=>a.needsDirectionConfirmation))throw Error('请重新确认方向')
      return copy({
        sourceId:base.sourceId,geometryRevision:base.geometryRevision,expectedRevision:base.revision,
        zones:current.zones.filter(z=>!same(z,base.zones.find(old=>old.id===z.id))),
        assignments:current.assignments.filter(a=>!same(a,base.assignments.find(old=>old.id===a.id))),
        removedZoneIds:base.zones.filter(z=>!current.zones.some(now=>now.id===z.id)).map(z=>z.id),
        removedAssignmentIds:base.assignments.filter(a=>!current.assignments.some(now=>now.id===a.id)).map(a=>a.id),
      })
    },
  }
}
