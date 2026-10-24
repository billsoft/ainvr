import {useEffect,useState} from 'react'
import {request} from '@/api/httpClient'
interface AlarmStatus {
 review?:{counts?:Record<string,number>;last_error?:string;evidence?:{capture_counts?:Record<string,number>;cache?:{written:number;dropped:number;failed:number;evicted:number};max_bytes?:number;retention_days?:number}}
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
 const current=!!status&&!error&&!stale
 return <div aria-label="告警服务关键状态" className="space-y-1 py-3 leading-5">
  <p className={!current||headline==='消费异常'||headline==='服务需检查'?'text-amber-700':'text-slate-600'}>{headline}</p>
  <p>待消费 {current?number(journal?.pending):'—'} · 本次持久化 {current?number(status?.input.persisted):'—'}</p>
  {current&&status?.review&&<p>审核：待验证 {number(status.review.counts?.waiting_validation)} · 排队 {number(status.review.counts?.queued)} · 执行 {number(status.review.counts?.running)} · 未完成 {number(status.review.counts?.failed)}</p>}
  {current&&status?.evidence_vault&&<p>截图：已保存 {number(status.evidence_vault.counts?.stored)} · 未取得 {number(status.evidence_vault.counts?.unavailable)}{status.evidence_vault.last_error?' · 取证需检查':''}</p>}
  {current&&!!journal?.channel_issues?.length&&<p role="alert" className="text-amber-700">{journal.channel_issues.length} 个来源分析受阻，统计可能不完整。{inputIssue(journal.channel_issues[0]!.reason)}</p>}
  {!current&&<p>当前指标 —，等待状态更新</p>}
 </div>
}
