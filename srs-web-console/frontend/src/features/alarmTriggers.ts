import type {AlarmSchedule} from './alarmSchedule'

// A trigger detects exactly one behavior on one or more AI channels. Levels nest:
// a passage includes an intrusion, which includes an approach, which includes an
// appearance; one target gets one alarm at its highest level.
export type TriggerBehavior='appearance'|'region_approach'|'region_enter'|'region_traverse'
export const triggerBehaviors:{id:TriggerBehavior;name:string;level:number;help:string;zone:boolean}[]=[
 {id:'appearance',name:'出现',level:1,zone:false,help:'画面里同一目标连续出现满设定秒数。不需要热区。'},
 {id:'region_approach',name:'接近',level:2,zone:true,help:'进入热区外侧的接近范围，例如坠落区边缘。'},
 {id:'region_enter',name:'碰撞侵入',level:3,zone:true,help:'从热区外进入热区内，例如禁区。'},
 {id:'region_traverse',name:'穿过',level:4,zone:true,help:'从一条边进入、从另一条边离开，可用于进出计数。'},
]
/** Display names, including behaviors recorded by earlier configurations. */
export const behaviorNames:Record<string,string>={appearance:'出现',region_approach:'接近',region_contact:'接触',region_enter:'碰撞侵入',region_traverse:'穿过',line_crossing:'越线'}
export const needsZone=(behavior:TriggerBehavior)=>behavior!=='appearance'

/** Edge indexes of the zone polygon; empty means any direction. */
export interface TriggerDirection {entry_edges:number[];exit_edges:number[]}
export interface TriggerBinding {
 channel_id:string;label_map_version:string;geometry_revision:string
 zone_id:string|null;zone_version:number|null;direction:TriggerDirection;approach_px?:number
}
/** A target is its number and its name: models number their classes, so the same
 * number in another model can be a different target (class 0 may be a person or fire). */
export interface TriggerLabel {label_id:string;name:string}
export const labelName=(l:{label_id:string;name?:string;description?:string})=>l.name||l.description||l.label_id
export const sameLabel=(a:TriggerLabel,b:{label_id:string;name?:string;description?:string})=>a.label_id===b.label_id&&a.name===labelName(b)
export interface TriggerInput {
 trigger_id:string;name:string;behavior:TriggerBehavior;labels:TriggerLabel[];duration_ms:number
 alarm_enabled:boolean;state:'draft'|'enabled'|'paused'|'archived';schedule:AlarmSchedule;bindings:TriggerBinding[]
}
export interface SavedBinding extends TriggerBinding {input_stream_id?:string;zone_snapshot?:{name:string;points:[number,number][];version:number}|null}
export interface AlarmTrigger extends Omit<TriggerInput,'bindings'> {version:number;bindings:SavedBinding[]}

/** Source pixel size from a geometry revision `...:WIDTHxHEIGHT`. */
export function sourceSize(geometryRevision:string){
 const match=/:(\d+)x(\d+)$/.exec(geometryRevision)
 return match?{width:Number(match[1]),height:Number(match[2])}:null
}
const sides=['上边','右上边','右边','右下边','下边','左下边','左边','左上边']
/** Human edge names from where each edge's midpoint sits around the zone centre (screen up = 上). */
export function edgeNames(points:[number,number][],width=16,height=9):string[]{
 const cx=points.reduce((s,p)=>s+p[0],0)/points.length,cy=points.reduce((s,p)=>s+p[1],0)/points.length
 const names=points.map((p,i)=>{
  const q=points[(i+1)%points.length]!,mx=((p[0]+q[0])/2-cx)*width,my=((p[1]+q[1])/2-cy)*height
  const deg=(Math.atan2(mx,-my)*180/Math.PI+360)%360
  return sides[Math.round(deg/45)%8]!
 })
 return names.map((name,i)=>names.filter(n=>n===name).length>1?`${name} ${names.slice(0,i+1).filter(n=>n===name).length}`:name)
}
export function directionText(behavior:TriggerBehavior,direction:TriggerDirection,names:string[]){
 if(behavior==='appearance')return '整个画面'
 const list=(edges:number[])=>edges.map(i=>names[i]??`边 ${i+1}`).join('、')
 if(!direction.entry_edges.length&&!direction.exit_edges.length)return '不限方向'
 if(behavior==='region_traverse')return `从${list(direction.entry_edges)||'任意边'}进入，从${list(direction.exit_edges)||'任意边'}离开`
 return `从${list(direction.entry_edges)}${behavior==='region_approach'?'一侧接近':'进入'}`
}

/** One look per level, shared by the alarm feed and trigger cards (lightness differs too). */
export const levelLook:Record<string,{color:string;soft:string;ink:string}>={
 appearance:{color:'#64748b',soft:'#f1f5f9',ink:'#334155'},
 region_approach:{color:'#f59e0b',soft:'#fffbeb',ink:'#92400e'},
 region_contact:{color:'#f59e0b',soft:'#fffbeb',ink:'#92400e'},
 region_enter:{color:'#ea580c',soft:'#fff7ed',ink:'#9a3412'},
 region_traverse:{color:'#b91c1c',soft:'#b91c1c',ink:'#ffffff'},
 line_crossing:{color:'#b91c1c',soft:'#b91c1c',ink:'#ffffff'},
}
