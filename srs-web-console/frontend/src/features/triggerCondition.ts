import type {TriggerDefinitionInput} from '@/features/alarmDefinitions'
import {behaviorNames} from '@/features/alarmTriggers'
import {labelDisplay} from '@/features/labelNames'

type Group=NonNullable<TriggerDefinitionInput['group']>
/** What the operator chooses: which labels must take part, how many targets, and the time window. */
export interface TriggerCondition {relation:'any'|'all';count:number;window_ms:number}
/** Passing through counts completions inside the window; state behaviours only tolerate missed detections. */
export const defaultWindowMs=(behavior:TriggerDefinitionInput['behavior'])=>behavior==='region_traverse'?3000:1000
/** "All" needs at least one target of every label, so its count is never below the number of labels. */
export function minimumCount(relation:TriggerCondition['relation'],labels:number){return relation==='all'?Math.max(1,labels):1}
export function conditionOf(value:Pick<TriggerDefinitionInput,'group'|'behavior'|'labels'>):TriggerCondition{
 const g=value.group,relation=g&&value.labels.length>1?g.labels:'any'
 return {relation,count:Math.max(g?.minimum??1,minimumCount(relation,value.labels.length)),window_ms:g?.window_ms??defaultWindowMs(value.behavior)}
}
/** OR with one target is the ordinary single-target trigger; everything else is a group condition. */
export function groupOf(condition:TriggerCondition,labels:number):Group|undefined{
 const relation=labels>1?condition.relation:'any',count=Math.max(Math.round(condition.count),minimumCount(relation,labels))
 if(relation==='any'&&count<=1)return undefined
 return {labels:relation,minimum:Math.min(16,count),window_ms:Math.round(condition.window_ms)}
}
export const needsWindow=(c:TriggerCondition,labels:number)=>!!groupOf(c,labels)
/** One plain sentence: what has to happen, for how many, and within what time. */
export function conditionSentence(value:Pick<TriggerDefinitionInput,'group'|'behavior'|'labels'>,action:string){
 const names=value.labels.map(l=>labelDisplay(l.name)),g=value.group
 const list=(joiner:string)=>names.length?names.join(joiner):'（未选目标）'
 if(!g)return `${list('或')}${action}`
 const seconds=`${g.window_ms/1000} 秒`
 if(value.behavior==='region_traverse'){
  const who=g.labels==='all'?`${list('和')}（每类至少 1 个）`:list('或')
  return `${seconds}内至少 ${g.minimum} 个${who}${action}`
 }
 const tolerance=g.window_ms?`，容许 ${seconds}内的短暂漏检`:'，须在同一帧'
 if(g.labels==='all')return `${list('和')}同时${action}${g.minimum>names.length?`，合计至少 ${g.minimum} 个`:''}${tolerance}`
 return `${list('或')} 至少 ${g.minimum} 个同时${action}${tolerance}`
}
export function actionText(behavior:TriggerDefinitionInput['behavior'],extra:{seconds?:string;percent?:string}={}){
 if(behavior==='appearance')return extra.seconds&&Number(extra.seconds)>0?`连续出现满 ${extra.seconds} 秒`:'出现'
 if(behavior==='region_approach')return `接近热区（画面宽度 ${extra.percent||'?'}% 以内）`
 return behavior==='region_enter'?'进入热区':`${behaviorNames[behavior]}热区`
}
