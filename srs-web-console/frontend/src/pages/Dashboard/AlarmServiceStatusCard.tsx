import {useEffect,useState} from 'react'
import {Link} from 'react-router-dom'
import {request} from '@/api/httpClient'
interface AlarmStatus {
 evidence_vault?:{enabled:boolean;used_bytes?:number;max_bytes?:number;counts?:{stored:number;pending:number;capturing:number;unavailable:number};last_error?:string|null}
 sampled_at:string;status:string;config:{applied_version:number};storage:{writable:boolean}
 input:{received:number;persisted:number;failed:number;last_persisted_at:string|null}
 observation_journal?:{state:string;pending?:number;consumed?:number;failed?:number;ignored?:number;last_error?:string|null;last_ignored_reason?:string;channel_issues?:{channel_id:string|null;reason:string;state:string}[]}
}
const inputIssue=(reason:string)=>({source_binding_unavailable:'来源绑定未完成，请重新保存并应用分析规则',source_binding_mismatch:'有结果与区域、画面规格或标签版本不匹配，请重新确认来源和规则',processing_unavailable:'结果处理暂不可用，记录保留并自动重试',acknowledgement_pending:'处理确认尚未完成，正在安全重试',invalid_observation:'有结果未通过校验，请检查来源输出'}[reason]??'结果消费需检查')
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString():'—'
export function AlarmServiceStatusCard(){
 const [status,setStatus]=useState<AlarmStatus|null>(null),[error,setError]=useState(false)
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController()
  const tick=async()=>{
   if(!document.hidden)try{
    const next=await request<AlarmStatus>('/alarms/status',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
    if(active){setStatus(next);setError(false)}
   }catch{if(active)setError(true)}
   if(active)timer=setTimeout(tick,10000)
  }
  void tick();return()=>{active=false;controller.abort();clearTimeout(timer)}
 },[])
 const stale=!!status&&(error||!Number.isFinite(Date.parse(status.sampled_at))||Date.now()-Date.parse(status.sampled_at)>30000)
 const journal=status?.observation_journal
 const transport=journal?.state==='ready'?'消费正常':journal?.state==='degraded'?'消费异常':journal?.state==='waiting'?'等待结果或规则':journal?.state==='disabled'?'结果接线未启用':'状态未知'
 const headline=error&&!status?'未连接或尚未配置':!status?'正在读取':stale?'状态已过期':status.status!=='ready'||!status.storage.writable?'服务需检查':transport
 return <section aria-label="告警服务监视" className="rounded-xl border border-slate-200 bg-white p-4">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">告警微服务 · {headline}</h2><Link className="min-h-11 rounded border border-slate-200 px-3 py-2 text-sm" to="/config-center?category=alarm-service">服务配置</Link></div>
  {(error||stale)&&<p role="status" className="my-2 text-sm text-amber-700">当前状态未确认，历史计数不能当作正在正常消费。</p>}
  {!!journal?.channel_issues?.length&&<div role="alert" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
   <p>部分来源未能正常参与分析。未处理记录仍在暂存；修正后会自动重试，统计可能不完整。</p>
   <ul className="mt-2 space-y-2">{journal.channel_issues.map((issue,i)=><li key={`${issue.channel_id}:${i}`}>来源 {issue.channel_id??'未知'}：{inputIssue(issue.reason)}{issue.state==='blocked'?'（按顺序等待处理）':''}</li>)}</ul>
   <Link className="inline-block min-h-11 py-3 underline" to="/alarm-analysis">检查分析规则</Link>
  </div>}
  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
   <div><dt className="text-slate-500">待消费结果</dt><dd>{number(journal?.pending)}</dd></div>
   <div><dt className="text-slate-500">本次运行已持久化</dt><dd>{number(status?.input.persisted)}</dd></div>
   <div><dt className="text-slate-500">消费失败尝试</dt><dd>{number(journal?.failed??status?.input.failed)}</dd></div>
   <div><dt className="text-slate-500">最近持久化</dt><dd>{status?.input.last_persisted_at?new Date(status.input.last_persisted_at).toLocaleTimeString():'尚无已确认结果'}</dd></div>
  </dl>
  <p className="mt-3 text-xs text-slate-500">计数随服务重启重新开始。消费失败尝试不等于丢失条数；未知数据显示“—”。</p>
  {status?.evidence_vault&&<div className="mt-3 border-t border-slate-200 pt-3 text-sm"><p>告警截图独立保存：{status.evidence_vault.enabled?'已启用':'未保存新截图'}{status.evidence_vault.last_error?' · 最近取证需检查':''}</p><p className="mt-1 text-xs text-slate-500">已保存 {number(status.evidence_vault.counts?.stored)} 项 · 待保存 {number(status.evidence_vault.counts?status.evidence_vault.counts.pending+status.evidence_vault.counts.capturing:undefined)} 项 · 未取得 {number(status.evidence_vault.counts?.unavailable)} 项 · 已用 {number(status.evidence_vault.used_bytes===undefined?undefined:Math.round(status.evidence_vault.used_bytes/1024/1024))} MiB。截图数量来自持久化存储，不随重启清零。</p></div>}
  <div className="mt-2 flex gap-4 text-sm"><Link className="min-h-11 py-3 text-blue-600" to="/alarms">查看告警列表</Link><Link className="min-h-11 py-3 text-blue-600" to="/alarm-analysis">管理分析规则</Link></div>
 </section>
}
