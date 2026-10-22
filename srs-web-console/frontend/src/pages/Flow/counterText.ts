import {edgeNames,sourceSize} from '@/features/alarmTriggers'
import type {BindingDirection,CounterInput} from '@/api/flowService'
/** Plain words for a counting line, e.g. "右边计数线，向内记为“进”". */
export function directionSummary(d:BindingDirection,points:[number,number][],edgeIds:string[],counter:Pick<CounterInput,'names'|'outputs'>,geometryRevision?:string){
 const size=geometryRevision?sourceSize(geometryRevision):null,names=edgeNames(points,size?.width,size?.height)
 const edge=(id:string)=>{const i=edgeIds.indexOf(id);return i<0?'已变化的边':`边 ${i+1}（${names[i]}）`}
 const out=counter.outputs==='both'?`，反向记为“${counter.names.out}”`:''
 if(d.kind==='line')return `${edge(d.edge)}计数线，${d.in_side==='inward'?'进入热区':'离开热区'}的方向记为“${counter.names.in}”${out}`
 if(d.kind==='gates')return `${edge(d.from)} → ${edge(d.to)} 记为“${counter.names.in}”${out}`
 if(d.kind==='edges')return `${d.entry.map(edge).join('、')}进、${d.exit.map(edge).join('、')}出记为“${counter.names.in}”${out}`
 return `按角度判定，记为“${counter.names.in}”${out}`
}
export const counterStates={enabled:'已启用',paused:'已暂停'} as const
export function formatRangeLabel(from:Date,to:Date){
 const day=(d:Date)=>d.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})
 return day(from)===day(new Date(to.getTime()-1))?day(from):`${day(from)} — ${day(new Date(to.getTime()-1))}`
}
