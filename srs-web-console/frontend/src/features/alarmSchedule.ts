export interface WeeklyWindow {days:number[];start:string;end:string}
export type AlarmSchedule={mode:'always'}|{mode:'weekly';timezone:string;windows:WeeklyWindow[]}
export const weekdayNames=['周一','周二','周三','周四','周五','周六','周日']
export const scheduleMinute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3))
export function scheduleError(schedule:AlarmSchedule):string {
 if(!schedule||typeof schedule!=='object')return '请选择生效方式'
 if(schedule.mode==='always')return Object.keys(schedule).some(k=>k!=='mode')?'全天生效不应包含每周参数':''
 if(schedule.mode!=='weekly')return '不支持的生效方式'
 if(Object.keys(schedule).some(k=>!['mode','timezone','windows'].includes(k)))return '生效时段包含不支持的参数'
 try{
  if(typeof schedule.timezone!=='string'||!schedule.timezone||schedule.timezone.length>64||/^[+-]/.test(schedule.timezone))throw Error()
  new Intl.DateTimeFormat('en',{timeZone:schedule.timezone})
 }catch{return '请选择有效的 IANA 时区，例如 Asia/Shanghai'}
 if(!Array.isArray(schedule.windows)||!schedule.windows.length||schedule.windows.length>28)return '至少设置一个生效时段，最多 28 个'
 const occupied=new Uint8Array(10080),clock=/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
 for(const w of schedule.windows){
  if(!w||Object.keys(w).some(k=>!['days','start','end'].includes(k))||!Array.isArray(w.days)||!w.days.length||w.days.length>7||new Set(w.days).size!==w.days.length||w.days.some(d=>!Number.isInteger(d)||d<1||d>7))return '每个时段至少选择一天，星期不能重复'
  if(typeof w.start!=='string'||typeof w.end!=='string'||!clock.test(w.start)||!(clock.test(w.end)||w.end==='24:00'))return '请填写完整的开始与结束时间'
  const start=scheduleMinute(w.start),end=scheduleMinute(w.end)
  if(start===end)return '开始与结束不能相同；全天请勾选“这几天全天”'
  for(const d of w.days)for(let m=(d-1)*1440+start,to=(d-1)*1440+end+(end<start?1440:0);m<to;m++){
   if(occupied[m%10080])return '生效时段重叠，请检查跨午夜的次日部分'
   occupied[m%10080]=1
  }
 }
 return ''
}
export function scheduleSummary(s:AlarmSchedule):string {
 if(scheduleError(s))return '生效时段尚未设置完整'
 if(s.mode==='always')return '每天全天生效'
 return `${s.timezone} · ${s.windows.map(w=>`${[...w.days].sort((a,b)=>a-b).map(d=>weekdayNames[d-1]).join('、')} ${w.start}–${w.end}${scheduleMinute(w.end)<scheduleMinute(w.start)?'（次日结束）':''}`).join('；')}`
}
