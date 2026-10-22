import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
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
  return <section aria-label="大模型服务监视" className="rounded-panel border border-line bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-medium">大模型微服务 · {error?'未连接或尚未配置':status?(names[status.model]??'状态未知'):'正在读取'}</h2><Link className="btn-secondary" to="/config-center?category=llm-service">服务配置</Link></div>
    <p className="mt-2 text-sm text-ink-subtle">提供图片复审能力，尚未自动接入告警处理。与开放词汇试用模型互斥加载，不会自动停止其他服务。</p>
    {!error&&status?.last_error&&<p role="status" className="mt-2 text-sm text-danger">{status.last_error==='large_model_busy'?'其他大模型正在使用资源，请先卸载后重试。':status.last_error==='ion_budget_exceeded'?'专用内存池容量不满足模型预算。':'模型加载或运行未完成，请查看服务日志后重试。'}</p>}
    <dl className="mt-3 grid grid-cols-3 gap-3 text-sm"><div><dt className="text-ink-subtle">等待请求</dt><dd>{!error&&status?`${status.queue.length} / ${status.queue.capacity}`:'—'}</dd></div><div><dt className="text-ink-subtle">本次运行完成</dt><dd>{!error&&status?status.requests.ok:'—'}</dd></div><div><dt className="text-ink-subtle">本次运行失败</dt><dd>{!error&&status?status.requests.failed:'—'}</dd></div></dl>
    <dl className="mt-3 grid grid-cols-3 gap-3 text-sm"><div><dt className="text-ink-subtle">正在处理</dt><dd>{!error&&status?(status.active_request?'是':'否'):'—'}</dd></div>{(['p50','p95'] as const).map(q=><div key={q}><dt className="text-ink-subtle">请求耗时 {q}</dt><dd>{!error&&status?.latency_ms?.[q]!=null?`${(status.latency_ms[q]!/1000).toFixed(2)} 秒`:'—'}</dd></div>)}</dl>
    <p className="mt-2 text-xs text-ink-subtle">耗时包含排队，统计最近 256 个已结束请求；模型未就绪不代表服务进程已停止。</p>
  </section>
}
