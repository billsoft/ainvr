import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
import {request} from '@/api/httpClient'
type Status={sampled_at?:string;observation_journal?:{state:string;channel_issues?:{channel_id:string|null;reason:string}[]}}
export function AlarmInputNotice(){
 const [blocked,setBlocked]=useState(false),[stale,setStale]=useState(false)
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>
  const controller=new AbortController()
  const poll=async()=>{
   if(!document.hidden)try{
    const status=await request<Status>('/alarms/status',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])})
    if(active){setBlocked(status.observation_journal?.state==='degraded'||!!status.observation_journal?.channel_issues?.length);setStale(false)}
   }catch{if(active)setStale(true)}
   if(active)timer=setTimeout(poll,10000)
  }
  void poll();return()=>{active=false;controller.abort();clearTimeout(timer)}
 },[])
 if(!blocked)return null
 return <div role="alert" className="m-3 rounded-base border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
  {stale?'分析接收状态暂未更新，请检查运行状态。':'部分视频的分析接收受阻，新告警和流量可能缺失；历史数量不代表当前正在采集。'}
  <Link to="/dashboard" className="ml-2 inline-flex min-h-11 items-center underline">查看运行状态</Link>
 </div>
}
