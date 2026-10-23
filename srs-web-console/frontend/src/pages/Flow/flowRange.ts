import {startOfToday} from '@/api/flowService'
export type Preset='today'|'yesterday'|'7d'|'30d'|'custom'
/** The picker exposes inclusive seconds; API queries use [from,to). */
export interface CustomRange {from:Date;to:Date}
export function validateCustomRange(from:Date,to:Date){
 const duration=to.getTime()+1000-from.getTime()
 if(!Number.isFinite(duration)||duration<=0)return '请选择有效的起止时间'
 return duration>31*86400000?'流量统计每次最多查询 31 天，请缩短时间范围':null
}
export function rangeOf(preset:Preset,now=new Date(),custom:CustomRange|null=null){
 const today=startOfToday(now),day=86400000
 if(preset==='custom'&&custom){
  const from=custom.from,to=new Date(custom.to.getTime()+1000),duration=to.getTime()-from.getTime()
  return {from,to,bucket:duration<=2*day?'hour' as const:'day' as const,previous:{from:new Date(from.getTime()-duration),to:new Date(from)},compare:'上一同长时段'}
 }
 if(preset==='today')return {from:today,to:now,bucket:'hour' as const,previous:{from:new Date(today.getTime()-day),to:new Date(now.getTime()-day)},compare:'昨天同时段'}
 if(preset==='yesterday')return {from:new Date(today.getTime()-day),to:today,bucket:'hour' as const,previous:{from:new Date(today.getTime()-2*day),to:new Date(today.getTime()-day)},compare:'前一天'}
 const days=preset==='7d'?7:30,from=new Date(today.getTime()-(days-1)*day)
 return {from,to:now,bucket:'day' as const,previous:{from:new Date(from.getTime()-days*day),to:new Date(now.getTime()-days*day)},compare:`前 ${days} 天`}
}
