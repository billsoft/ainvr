import {zoneGeometryError,type ZonePoint} from './alarmGeometry'
import type {BindingDirection} from '@/api/flowService'

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
/** A counter selected onto one zone; the counting line refers to stable edge ids. */
export interface DraftCounterBinding {
  id:string
  counterId:string
  processorId:string
  zoneId:string
  direction:BindingDirection
  needsConfirmation:boolean
  /** This save also recounts earlier passages with the new line; sent once, never stored. */
  reclassifyHistory?:boolean
}
/** Edge ids after a reshape: same vertex count keeps every id; otherwise an edge
 * whose two endpoints are unchanged keeps its id and only split or merged edges get new ones. */
export function carryEdgeIds(oldPoints:ZonePoint[],oldIds:string[],points:ZonePoint[],newId:()=>string):string[]{
  if(points.length===oldPoints.length)return [...oldIds]
  const key=(p:ZonePoint,q:ZonePoint)=>JSON.stringify([p,q])
  const old=new Map(oldPoints.map((p,i)=>[key(p,oldPoints[(i+1)%oldPoints.length]!),oldIds[i]!]))
  return points.map((p,i)=>old.get(key(p,points[(i+1)%points.length]!))??newId())
}
/** Edge ids for an edited zone: a redrawn zone gets all new ids (its counting lines must be set again). */
export function edgeIdsAfterEdit(oldPoints:ZonePoint[],oldIds:string[],points:ZonePoint[],redrawn:boolean,newId:()=>string):string[]{
  return redrawn?points.map(()=>newId()):carryEdgeIds(oldPoints,oldIds,points,newId)
}
/** Same counting line, whatever key order the parameter store returned. */
export function sameDirection(a:BindingDirection,b:BindingDirection){
  const canon=(d:BindingDirection)=>d.kind==='line'?['line',d.edge,d.in_side]:d.kind==='gates'?['gates',d.from,d.to]:d.kind==='edges'?['edges',[...d.entry],[...d.exit]]:['angle',d.entry.from,d.entry.to,d.exit.from,d.exit.to]
  return JSON.stringify(canon(a))===JSON.stringify(canon(b))
}
export function bindingEdges(d:BindingDirection):string[]{
  return d.kind==='line'?[d.edge]:d.kind==='gates'?[d.from,d.to]:d.kind==='edges'?[...d.entry,...d.exit]:[]
}
export interface ArmingSnapshot {
  coordinateSpace?:'planar'|'erp'
  sourceId:string
  geometryRevision:string
  revision:number
  zones:DraftZone[]
  assignments:DraftAssignment[]
  counterBindings:DraftCounterBinding[]
}
const copy=<T,>(value:T):T=>structuredClone(value)
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)

/** Local transaction only: no network calls. Server must repeat compatibility,
 * source, ownership and revision validation before committing this change set. */
/** Snapshots from before counter bindings existed carry no counterBindings. */
export type ArmingSnapshotInput=Omit<ArmingSnapshot,'counterBindings'>&{counterBindings?:DraftCounterBinding[]}
export function createArmingDraft(input:ArmingSnapshotInput){
  const snapshot:ArmingSnapshot={...input,counterBindings:input.counterBindings??[]}
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
    const counterIds=new Set<string>(),counterKeys=new Set<string>()
    for(const b of s.counterBindings){
      if(!b.id||counterIds.has(b.id))throw Error('计数选用编号重复')
      counterIds.add(b.id)
      if(!b.counterId||!b.processorId)throw Error('请选择计数器和 AI 处理器')
      const key=JSON.stringify([b.counterId,b.zoneId,b.processorId])
      if(counterKeys.has(key))throw Error('同一热区不能重复选用同一计数器')
      counterKeys.add(key)
      const zone=s.zones.find(z=>z.id===b.zoneId)
      if(!zone)throw Error('计数选用的热区不存在')
      if(zone.erpWrap)throw Error('全景环绕区域暂不支持计数')
      const edges=bindingEdges(b.direction)
      if(new Set(edges).size!==edges.length)throw Error('计数线的边不能重复')
      if(!b.needsConfirmation&&edges.some(e=>!zone.edgeIds.includes(e)))throw Error('计数线引用的边不存在')
    }
  }
  validate(base)
  const edit=(operation:(next:ArmingSnapshot)=>void)=>{
    const next=copy(current)
    operation(next);validate(next)
    if(same(next,current))return
    past.push(current);current=next;future=[]
  }
  // A dragged vertex keeps every edge id, so its counting lines stay valid; only a
  // counting line whose edge disappeared must be set again.
  const markLostEdges=(s:ArmingSnapshot,zone:DraftZone)=>{
    for(const b of s.counterBindings)if(b.zoneId===zone.id&&bindingEdges(b.direction).some(e=>!zone.edgeIds.includes(e)))b.needsConfirmation=true
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
      markLostEdges(s,zone)
    }),
    replaceZone:(replacement:DraftZone)=>edit(s=>{
      const zone=findZone(s,replacement.id)
      const geometryChanged=!same(zone.points,replacement.points)||!same(zone.edgeIds,replacement.edgeIds)||!!zone.erpWrap!==!!replacement.erpWrap
      Object.assign(zone,copy(replacement),{name:replacement.name.trim(),version:zone.version})
      if(geometryChanged)for(const a of s.assignments)if(a.zoneId===zone.id&&(a.entryEdges.length||a.exitEdges.length))a.needsDirectionConfirmation=true
      markLostEdges(s,zone)
    }),
    removeZone:(id:string)=>edit(s=>{
      findZone(s,id)
      s.zones=s.zones.filter(z=>z.id!==id)
      s.assignments=s.assignments.filter(a=>a.zoneId!==id)
      s.counterBindings=s.counterBindings.filter(b=>b.zoneId!==id)
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
    putCounterBinding:(binding:DraftCounterBinding)=>edit(s=>{
      const index=s.counterBindings.findIndex(b=>b.id===binding.id)
      if(index<0)s.counterBindings.push(copy(binding));else s.counterBindings[index]=copy(binding)
    }),
    removeCounterBinding:(id:string)=>edit(s=>{s.counterBindings=s.counterBindings.filter(b=>b.id!==id)}),
    changeSet:()=>{
      if(current.assignments.some(a=>a.needsDirectionConfirmation))throw Error('请重新确认方向')
      if(current.counterBindings.some(b=>b.needsConfirmation))throw Error('热区的边已变化，请重新确认计数线')
      return copy({
        sourceId:base.sourceId,geometryRevision:base.geometryRevision,expectedRevision:base.revision,
        zones:current.zones.filter(z=>!same(z,base.zones.find(old=>old.id===z.id))),
        assignments:current.assignments.filter(a=>!same(a,base.assignments.find(old=>old.id===a.id))),
        removedZoneIds:base.zones.filter(z=>!current.zones.some(now=>now.id===z.id)).map(z=>z.id),
        removedAssignmentIds:base.assignments.filter(a=>!current.assignments.some(now=>now.id===a.id)).map(a=>a.id),
        counterBindings:current.counterBindings.filter(b=>!same(b,base.counterBindings.find(old=>old.id===b.id))),
        removedCounterBindingIds:base.counterBindings.filter(b=>!current.counterBindings.some(now=>now.id===b.id)).map(b=>b.id),
      })
    },
  }
}
