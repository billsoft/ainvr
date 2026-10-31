import type {AlarmEvent,AlarmLocation} from '@/api/alarmEventService'
import type {AlarmAnalyticsQuery} from '@/api/alarmAnalyticsService'

export type AlarmListScope=
 | {kind:'none'}
 | {kind:'invalid'}
 | {kind:'valid';from:string;to:string;locations:AlarmLocation[];analytics?:AlarmAnalyticsQuery}

const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=256&&!/[\x00-\x1f]/.test(value)

export function parseAlarmListScope(search:string):AlarmListScope {
 const params=new URLSearchParams(search)
 if(params.has('analytics_scope')){
  if(params.getAll('analytics_scope').length!==1||params.getAll('status').length!==1||params.get('status')!=='all'||['from','to','locations'].some(k=>params.has(k)))return {kind:'invalid'}
  try{
   const raw=params.get('analytics_scope')!;if(raw.length>8192)return {kind:'invalid'}
   const q:AlarmAnalyticsQuery=JSON.parse(raw)
   if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['from','to','timezone','bucket','locations','trigger_id','primary_type','audit','weekday','hour','association'].includes(k)))return {kind:'invalid'}
   const start=Date.parse(q.from),end=Date.parse(q.to)
   if(typeof q.from!=='string'||typeof q.to!=='string'||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>31*86400000)return {kind:'invalid'}
   if(typeof q.timezone!=='string'||q.timezone.length>80||!['hour','day'].includes(q.bucket))return {kind:'invalid'}
   new Intl.DateTimeFormat('en',{timeZone:q.timezone}).format(new Date())
   if(q.locations!==undefined&&(!Array.isArray(q.locations)||!q.locations.length||q.locations.length>100||JSON.stringify(q.locations).length>4096||q.locations.some(x=>!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['channel_id','zone_id'].includes(k))||!validId(x.channel_id)||!validId(x.zone_id))))return {kind:'invalid'}
   if(q.trigger_id!==undefined&&!validId(q.trigger_id))return {kind:'invalid'}
   if(q.primary_type!==undefined&&!validId(q.primary_type))return {kind:'invalid'}
   if(q.audit!==undefined&&!['pending','human_confirmed','human_false_positive','ai_reviewed','unknown'].includes(q.audit))return {kind:'invalid'}
   if(q.weekday!==undefined&&(!Number.isInteger(q.weekday)||q.weekday<0||q.weekday>6))return {kind:'invalid'}
   if(q.hour!==undefined&&(!Number.isInteger(q.hour)||q.hour<0||q.hour>23))return {kind:'invalid'}
   if(q.association!==undefined&&q.association!=='unassociated')return {kind:'invalid'}
   return {kind:'valid',from:q.from,to:q.to,locations:q.locations??[],analytics:q}
  }catch{return {kind:'invalid'}}
 }
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
 if(scope.analytics){
  const q=scope.analytics,h=alarm.handling
  const audit=h?.state==='unacknowledged'&&h.disposition!=='false_positive'?'pending':h?.state==='acknowledged'&&h.reviewed_by_kind==='ai'?'ai_reviewed':h?.state==='acknowledged'&&h.reviewed_by_kind==='human'&&h.disposition==='handled'?'human_confirmed':h?.state==='acknowledged'&&h.reviewed_by_kind==='human'&&h.disposition==='false_positive'?'human_false_positive':'unknown'
  if(q.audit&&q.audit!==audit||q.primary_type&&q.primary_type!==alarm.behavior)return false
  const refs=[{zone_id:rule.snapshot?.zone_id,trigger_id:alarm.trigger_id??alarm.rule.id},...(alarm.stages??[])]
  if(q.association==='unassociated'&&refs.some(x=>validId(x.zone_id)))return false
  if((q.locations||q.trigger_id)&&!refs.some(x=>(!q.trigger_id||x.trigger_id===q.trigger_id)&&(!q.locations||q.locations.some(p=>p.channel_id===alarm.channel_id&&p.zone_id===x.zone_id))))return false
  if(q.weekday!==undefined||q.hour!==undefined){
   const parts=new Intl.DateTimeFormat('en-US',{timeZone:q.timezone,weekday:'short',hour:'numeric',hourCycle:'h23'}).formatToParts(new Date(at))
   const weekday=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.find(p=>p.type==='weekday')?.value??'')
   const hour=Number(parts.find(p=>p.type==='hour')?.value)
   if(q.weekday!==undefined&&q.weekday!==weekday||q.hour!==undefined&&q.hour!==hour)return false
  }
  return true
 }
 return scope.locations.some(pair=>pair.channel_id===alarm.channel_id&&
  (rule.snapshot?.zone_id===pair.zone_id||alarm.stages?.some(stage=>stage.zone_id===pair.zone_id)))
}
