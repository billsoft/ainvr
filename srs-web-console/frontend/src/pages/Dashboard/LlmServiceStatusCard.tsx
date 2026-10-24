import {useEffect,useState} from 'react'
import {request} from '@/api/httpClient'
type Status={ready:boolean;model:string;last_error?:string;active_request?:boolean;latency_ms?:{p50:number|null;p95:number|null};queue:{length:number;capacity:number};requests:{ok:number;failed:number}}
const names:Record<string,string>={ready:'模型就绪',loading:'模型加载中',unloaded:'模型未加载',fault:'模型加载或运行失败',ion_insufficient:'专用内存不足'}
export function LlmServiceStatusCard(){
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(false)
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController()
    const tick=async()=>{
      if(!document.hidden)try{const value=await request<Status>('/llm/status',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(active){setStatus(value);setError(false)}}catch{if(active)setError(true)}
      if(active)timer=setTimeout(tick,10000)
    };void tick();return()=>{active=false;controller.abort();clearTimeout(timer)}
  },[])
  return <div aria-label="大模型服务关键状态" className="space-y-1 py-3 leading-5">
    <p className={error||status?.model==='fault'?'text-amber-700':'text-slate-600'}>{error?'未连接或尚未配置':status?(names[status.model]??'状态未知'):'正在读取'}</p>
    <p>排队 {!error&&status?`${status.queue.length} / ${status.queue.capacity}`:'—'} · 处理中 {!error&&status?(status.active_request?'是':'否'):'—'}</p>
    <p>本次完成 {!error&&status?status.requests.ok:'—'} · 失败 {!error&&status?status.requests.failed:'—'} · 耗时 p95 {!error&&status?.latency_ms?.p95!=null?`${(status.latency_ms.p95/1000).toFixed(2)} 秒`:'—'}</p>
    {!error&&status?.last_error&&<p role="status" className="text-amber-700">{status.last_error==='large_model_busy'?'其他大模型正在使用资源，请先卸载后重试。':status.last_error==='ion_budget_exceeded'?'专用内存池容量不满足模型预算。':'模型加载或运行未完成，请查看服务日志。'}</p>}
  </div>
}
