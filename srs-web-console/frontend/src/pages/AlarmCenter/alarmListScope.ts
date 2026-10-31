import type {AlarmEvent,AlarmLocation} from '@/api/alarmEventService'

export type AlarmListScope=
 | {kind:'none'}
 | {kind:'invalid'}
 | {kind:'valid';from:string;to:string;locations:AlarmLocation[]}

const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=256&&!/[\x00-\x1f]/.test(value)

export function parseAlarmListScope(search:string):AlarmListScope {
 const params=new URLSearchParams(search)
 if(!['from','to','locations'].some(key=>params.has(key)))return {kind:'none'}
 if(['from','to','locations','status'].some(key=>params.getAll(key).length!==1)||params.get('status')!=='all')return {kind:'invalid'}
 const from=params.get('from')!,to=params.get('to')!,raw=params.get('locations')!
 const start=Date.parse(from),end=Date.parse(to)
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000||raw.length>4096)return {kind:'invalid'}
 try{
  const locations:unknown=JSON.parse(raw)
  if(!Array.isArray(locations)||locations.length<1||locations.length>100||JSON.stringify(locations).length>4096)return {kind:'invalid'}
  if(locations.some(item=>!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>k!=='channel_id'&&k!=='zone_id')||!validId(item.channel_id)||!validId(item.zone_id)))return {kind:'invalid'}
  return {kind:'valid',from,to,locations}
 }catch{return {kind:'invalid'}}
}

export function alarmInScope(alarm:AlarmEvent,scope:Extract<AlarmListScope,{kind:'valid'}>):boolean {
 const at=Date.parse(alarm.occurred_at)
 if(!Number.isFinite(at)||at<Date.parse(scope.from)||at>=Date.parse(scope.to))return false
 const rule=alarm.rule as AlarmEvent['rule']&{snapshot?:{zone_id?:string|null}}
 return scope.locations.some(pair=>pair.channel_id===alarm.channel_id&&
  (rule.snapshot?.zone_id===pair.zone_id||alarm.stages?.some(stage=>stage.zone_id===pair.zone_id)))
}
