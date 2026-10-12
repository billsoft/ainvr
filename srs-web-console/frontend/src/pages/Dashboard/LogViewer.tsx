import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { observabilityService as api, type LogResult } from '@/api/observabilityService'
import { names, input, button, time } from './format'

export function LogViewer({initialSource}:{initialSource:string}) {
  const [source,setSource]=useState(initialSource),[level,setLevel]=useState(''),[query,setQuery]=useState('')
  const [hours,setHours]=useState(1),[logs,setLogs]=useState<LogResult|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  const [live,setLive]=useState(false),[version,setVersion]=useState(0),[before,setBefore]=useState<string|null>(null)
  useEffect(()=>{setSource(initialSource);setBefore(null)},[initialSource])
  useEffect(()=>{
    let cancelled=false,timer:ReturnType<typeof setTimeout>
    const tick=async()=>{
      if(!document.hidden){
        setLoading(true)
        try{
          const q=new URLSearchParams({limit:'200',start:String(Date.now()-hours*3600000)})
          if(source)q.set('source',source);if(level)q.set('level',level);if(query)q.set('q',query);if(before)q.set('cursor',before)
          const result=await api.logs(q)
          if(!cancelled){setLogs(result);setError('')}
        }catch(e){if(!cancelled)setError((e as Error).message)}finally{if(!cancelled)setLoading(false)}
      }
      if(!cancelled&&live&&!before)timer=setTimeout(tick,10000)
    }
    const debounce=setTimeout(()=>void tick(),300)
    return()=>{cancelled=true;clearTimeout(debounce);clearTimeout(timer)}
  },[source,level,query,hours,version,live,before])
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2">
      <select aria-label="日志来源" className={input} value={source} onChange={e=>{setSource(e.target.value);setBefore(null)}}><option value="">全部服务</option>{Object.entries(names).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
      <select aria-label="日志级别" className={input} value={level} onChange={e=>{setLevel(e.target.value);setBefore(null)}}><option value="">全部级别</option>{['ERROR','WARN','INFO','DEBUG'].map(v=><option key={v}>{v}</option>)}</select>
      <select aria-label="日志时间" className={input} value={hours} onChange={e=>{setHours(Number(e.target.value));setBefore(null)}}>{[1,6,24,72,168].map(v=><option key={v} value={v}>最近 {v} 小时</option>)}</select>
      <input aria-label="日志关键词" className={input+' min-w-48 flex-1'} placeholder="搜索错误、模块或请求…" value={query} onChange={e=>{setQuery(e.target.value);setBefore(null)}}/>
      <button className={button} disabled={loading} onClick={()=>{setBefore(null);setVersion(v=>v+1)}}><RefreshCw size={16} className={loading?'animate-spin':''}/><span className="sr-only">刷新日志</span></button>
      <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={live} onChange={e=>{setLive(e.target.checked);setBefore(null)}}/>实时跟随</label>
    </div>
    {error&&<p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex justify-between border-b border-slate-100 px-4 py-3 text-xs text-slate-500"><span>{loading?'正在读取…':`本页 ${logs?.items.length??0} 条 · 最新在前`}</span><span>运行日志 · 操作审计 · 浏览器异常</span></div>
      <div className="max-h-[65vh] overflow-auto">
        {logs?.items.map((l,i)=><article key={`${l.ts}-${i}`} className="border-b border-slate-100 px-4 py-3 last:border-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs"><span className={`rounded px-1.5 py-0.5 font-medium ${l.level==='ERROR'?'bg-red-50 text-red-700':l.level==='WARN'?'bg-amber-50 text-amber-700':'bg-slate-100 text-slate-600'}`}>{l.level}</span><time className="tabular-nums text-slate-500">{time(l.ts)}</time><span className="font-medium">{names[l.source]}</span><span className="text-slate-400">{l.module}</span>{l.category==='audit'&&<span className="text-blue-600">操作审计</span>}{l.count>1&&<span className="text-violet-600">合并 {l.count} 次</span>}</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-slate-700">{l.message}</pre>
        </article>)}
        {!logs?.items.length&&!loading&&<div className="p-12 text-center text-sm text-slate-400">{error?'日志暂不可用':'当前条件下没有已归档日志'}</div>}
      </div>
    </div>
    {logs?.cursorExpired&&<p role="status" className="text-xs text-amber-700">部分旧归档已轮转淘汰，可刷新查询最新记录。</p>}
    {logs?.truncated&&<div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">本页达到查询上限，仍有归档未读取。{logs.nextCursor&&<button className={button} disabled={loading} onClick={()=>{setBefore(logs.nextCursor);setLive(false)}}>继续读取更早记录</button>}</div>}
    <p className="text-xs text-slate-500">归档约每 10 秒同步一次。重复事件合并计数；高流量时按有界批次采集，并记录截断提示。原始日志轮转与集中归档的保留时间可能不同。</p>
  </div>
}
