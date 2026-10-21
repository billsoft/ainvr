import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
import {Bell} from 'lucide-react'
import {alarmEventService} from '@/api/alarmEventService'

/** Count all unacknowledged alarms; unavailable is never represented as zero. */
export function AlarmPendingIndicator(){
 const [count,setCount]=useState<number|null>(null)
 useEffect(()=>{
  let cancelled=false
  let timer:ReturnType<typeof setTimeout>
  const poll=async()=>{
   if(!document.hidden){
    try{
     const result=await alarmEventService.summary()
     const valid=Number.isSafeInteger(result.pending)&&result.pending>=0&&Number.isFinite(Date.parse(result.as_of))
     if(!cancelled)setCount(valid?result.pending:null)
    }catch{if(!cancelled)setCount(null)}
   }else if(!cancelled)setCount(null)
   if(!cancelled)timer=setTimeout(poll,10000)
  }
  void poll()
  return()=>{cancelled=true;clearTimeout(timer)}
 },[])
 const label=count===null?'待确认告警数量未知':`待确认告警 ${count} 条`
 return <Link to="/alarms?status=pending&range=all" aria-label={label} title={label}
  className={`flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-card px-2 text-sm ${count?'text-danger-700':'text-ink-subtle'}`}>
  <Bell size={18} aria-hidden="true"/><span className="tabular-nums">{count===null?'—':count>999?'999+':count}</span>
 </Link>
}
