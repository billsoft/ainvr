import {useSearchParams} from 'react-router-dom'
import type {AlarmLocation} from '@/api/alarmEventService'
import {field,fieldSelect} from '@/components/ui/filterStyles'

/**
 * Passages (people, vehicles, any statistic) or alarms. Vehicles are not a subject of their own: a vehicle
 * statistic is an ordinary statistic, chosen like any other. Old `subject=vehicles` links read as passages.
 * Switching subject never silently applies trigger filters to passage counts.
 */
export function AnalyticsSubjectSwitch({locations,disabled=false}:{locations?:AlarmLocation[];disabled?:boolean}={}){
 const [params,setParams]=useSearchParams()
 const subject=params.get('subject')==='alarms'?'alarms':'flow'
 return <label className={field}>
  <span className="sr-only">统计对象</span>
  <select aria-label="统计对象" disabled={disabled} title={disabled?'正在读取所选位置，请稍候':undefined} className={fieldSelect+' !pl-0'} value={subject} onChange={e=>{
   const next=e.target.value
   setParams(old=>{
    const p=new URLSearchParams(old);p.set('subject',next)
    if(next==='alarms'&&locations){
     if(locations.length>0&&locations.length<=100&&JSON.stringify(locations).length<=4096){p.set('alarm_locations',JSON.stringify(locations));p.set('alarm_scope_origin','flow')}
     else if(locations.length){p.set('alarm_locations','[]');p.set('alarm_scope_origin','limit')}
     else{p.delete('alarm_locations');p.delete('alarm_scope_origin')}
    }
    return p
   })
  }}><option value="flow">通行统计</option><option value="alarms">告警分析</option></select>
 </label>
}
