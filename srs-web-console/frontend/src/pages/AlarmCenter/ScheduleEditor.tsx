import {useRef} from 'react'
import {scheduleError,scheduleMinute,scheduleSummary,weekdayNames,type AlarmSchedule,type WeeklyWindow} from '@/features/alarmSchedule'
const control='form-input'
export function ScheduleEditor({value,onChange}:{value:AlarmSchedule;onChange:(value:AlarmSchedule)=>void}){
 const weekly=useRef<Extract<AlarmSchedule,{mode:'weekly'}>>({mode:'weekly',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',windows:[{days:[1,2,3,4,5],start:'09:00',end:'18:00'}]})
 if(value.mode==='weekly')weekly.current=value
 const update=(index:number,patch:Partial<WeeklyWindow>)=>{
  if(value.mode==='weekly')onChange({...value,windows:value.windows.map((w,i)=>i===index?{...w,...patch}:w)})
 }
 const error=scheduleError(value)
 return <fieldset className="space-y-3 rounded border border-line p-3"><legend className="px-1 font-medium">生效时段</legend>
  <label className="block">生效方式<select className={`${control} block w-full sm:w-64`} value={value.mode} onChange={e=>onChange(e.target.value==='always'?{mode:'always'}:structuredClone(weekly.current))}><option value="always">每天全天</option><option value="weekly">每周指定时段</option></select></label>
  {value.mode==='weekly'&&<>
   <label className="block">规则时区<input className={`${control} block w-full sm:w-72`} list="alarm-rule-timezones" value={value.timezone} onChange={e=>onChange({...value,timezone:e.target.value})}/></label>
   <datalist id="alarm-rule-timezones">{['Asia/Shanghai','UTC','Asia/Hong_Kong','Asia/Tokyo','America/New_York','Europe/London'].map(t=><option key={t} value={t}/>)}</datalist>
   <p className="text-sm text-ink-subtle">初始建议使用当前浏览器时区。保存后固定使用所选时区，不随设备或浏览器时区改变。跨午夜的时段归属于开始当天；夏令时按当地钟表时间生效。</p>
   {value.windows.map((w,index)=>{
    const allDay=w.start==='00:00'&&w.end==='24:00'
    return <fieldset key={index} className="space-y-2 rounded border border-line p-3"><legend className="px-1">时段 {index+1}</legend>
     <div className="flex flex-wrap gap-2">{weekdayNames.map((name,i)=><label key={name} className="flex items-center gap-2 px-2 text-sm"><input type="checkbox" aria-label={`时段 ${index+1} ${name}`} checked={w.days.includes(i+1)} onChange={()=>update(index,{days:w.days.includes(i+1)?w.days.filter(d=>d!==i+1):[...w.days,i+1].sort((a,b)=>a-b)})}/>{name}</label>)}</div>
     <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`时段 ${index+1} 这几天全天`} checked={allDay} onChange={e=>update(index,e.target.checked?{start:'00:00',end:'24:00'}:{start:'09:00',end:'18:00'})}/>这几天全天</label>
     <div className="flex flex-wrap items-end gap-3"><label>开始<input className={`${control} block`} aria-label={`时段 ${index+1} 开始`} type="time" step="60" disabled={allDay} value={w.start} onChange={e=>update(index,{start:e.target.value})}/></label><label>结束<input className={`${control} block`} aria-label={`时段 ${index+1} 结束`} type="time" step="60" disabled={allDay} value={w.end==='24:00'?'00:00':w.end} onChange={e=>update(index,{end:e.target.value})}/></label><button className={control} type="button" aria-label={`删除时段 ${index+1}`} onClick={()=>onChange({...value,windows:value.windows.filter((_,i)=>i!==index)})}>删除时段</button></div>
     {!allDay&&w.start&&w.end&&scheduleMinute(w.end)<scheduleMinute(w.start)&&<p className="text-sm">结束时间在次日。</p>}
    </fieldset>
   })}
   <button className="btn-secondary" type="button" disabled={value.windows.length>=28} onClick={()=>onChange({...value,windows:[...value.windows,{days:[],start:'09:00',end:'18:00'}]})}>添加时段</button>
  </>}
  {error&&<p role="alert" className="text-danger-700">{error}</p>}
  <p className="text-sm" aria-label="生效时段预览">{scheduleSummary(value)}</p>
  <p className="text-xs text-ink-subtle">按图像采集时间判断。时段外不产生此规则的行为记录或告警；跨时段不延续停留计时和穿越轨迹。</p>
 </fieldset>
}
