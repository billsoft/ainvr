import type {AlarmEvent} from '@/api/alarmEventService'
import {behaviorNames,edgeNames,sourceSize,type TriggerLabel} from './alarmTriggers'
import {labelDisplay} from './labelNames'

/** What a sentence needs: the trigger's targets and duration, and the zone the alarm happened in. */
export interface AlarmContext {
 labels:TriggerLabel[];duration_ms:number
 bindings?:{channel_id:string;geometry_revision:string;approach_px?:number;zone_snapshot?:{name:string;points:[number,number][]}|null}[]
}

type Stage=NonNullable<AlarmEvent['stages']>[number]
const edgeOf=(direction:unknown,key:'entry_edge'|'exit_edge'|'nearest_edge')=>{
 const v=direction&&typeof direction==='object'?(direction as Record<string,unknown>)[key]:undefined
 return typeof v==='number'&&Number.isInteger(v)?v:null
}
/** One alarm in words: what, where and over which zone edge, from the trigger that produced it. */
export function describeAlarm(alarm:AlarmEvent,trigger:AlarmContext|undefined){
 const stages:Stage[]=alarm.stages??[]
 const binding=trigger?.bindings?.find(b=>b.channel_id===alarm.channel_id)??trigger?.bindings?.[0]
 const zone=binding?.zone_snapshot?.name??null
 const size=binding?sourceSize(binding.geometry_revision):null
 const names=binding?.zone_snapshot?.points?edgeNames(binding.zone_snapshot.points,size?.width,size?.height):[]
 const edge=(i:number|null)=>i===null?'未确定的边':names[i]??`边 ${i+1}`
 const name=trigger?.labels.length===1?labelDisplay(trigger.labels[0]!.name):'目标'
 const target=/[A-Za-z0-9]$/.test(name)?`${name} `:name  // "person 在画面中…"
 const top=[...stages].reverse().find(s=>s.behavior===alarm.behavior)
 const at=(behavior:string)=>stages.find(s=>s.behavior===behavior)?.at
 let sentence:string
 if(!trigger)sentence=`目标${behaviorNames[alarm.behavior]??'触发'}${alarm.behavior==='appearance'?'':'热区'}。`
 else if(alarm.behavior==='appearance')sentence=`${target}在画面中连续出现 ${trigger.duration_ms/1000} 秒。`
 else if(alarm.behavior==='region_approach')sentence=`${target}靠近「${zone??'热区'}」${edge(edgeOf(top?.direction,'nearest_edge'))}一侧（${binding?.approach_px??'?'} 像素内）。`
 else if(alarm.behavior==='region_enter')sentence=`${target}从${edge(edgeOf(top?.direction,'entry_edge'))}进入「${zone??'热区'}」。`
 else if(alarm.behavior==='region_traverse'){
  const entered=at('region_enter'),left=top?.at,seconds=entered&&left?Math.round((Date.parse(left)-Date.parse(entered))/1000):null
  sentence=`${target}从${edge(edgeOf(top?.direction,'entry_edge'))}进入「${zone??'热区'}」，${seconds===null?'随后':`${seconds} 秒后`}从${edge(edgeOf(top?.direction,'exit_edge'))}离开。`
 } else sentence=`${target}${behaviorNames[alarm.behavior]??'触发'}。`
 return {sentence,zone:zone??(alarm.behavior==='appearance'?'整个画面':null),target:name,edgeName:edge}
}
/** Stage label with its zone edge, for the detail sheet. */
export function stageNote(stage:Stage,edge:(i:number|null)=>string){
 if(stage.behavior==='region_enter')return `从${edge(edgeOf(stage.direction,'entry_edge'))}进入`
 if(stage.behavior==='region_traverse')return `从${edge(edgeOf(stage.direction,'entry_edge'))}进，${edge(edgeOf(stage.direction,'exit_edge'))}出`
 if(stage.behavior==='region_approach')return `靠近${edge(edgeOf(stage.direction,'nearest_edge'))}`
 return '进入画面'
}
