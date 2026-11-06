import type { MemoryBudget } from '../../api/observabilityService'
const mib=(n:number)=>`${(n/1048576).toFixed(n<10485760?1:0)} MiB`
export function ServiceMemoryBudget({budget}:{budget?:MemoryBudget}) {
  if(!budget||!Number.isFinite(budget.budget_bytes)||budget.budget_bytes<=0)return null
  if(budget.scope==='container')return <div className="mt-1 text-[11px] text-slate-500">容器上限 {mib(budget.budget_bytes)}</div>
  if(!Number.isFinite(budget.reserved_bytes)||budget.reserved_bytes!<0)return null
  const used=budget.reserved_bytes!,ratio=Math.min(100,100*used/budget.budget_bytes)
  return <div className="mt-2 min-w-[150px] text-[11px] text-slate-500" title="仅表示缓冲额度预留，不是实际内存占用，也不包含进程及驱动开销。停止后的安全收尾仍占额度。">
    <div className="flex justify-between gap-2"><span>{budget.scope==='recording_gop_buffer'?'录像缓冲预留':'编码缓冲预留'}</span><span className="tabular-nums">{mib(used)} / {mib(budget.budget_bytes)}</span></div>
    <div className="mt-1 h-1 overflow-hidden rounded bg-slate-100"><div className={used>=budget.budget_bytes?'h-full bg-amber-500':'h-full bg-blue-400'} style={{width:`${Math.max(0,ratio)}%`}}/></div>
    {budget.active_channel_limit!==undefined&&<div className="mt-1">活动通道 {budget.active_channels??0} / {budget.active_channel_limit}</div>}
    {!!budget.retiring_bytes&&<div className="mt-1">收尾占用 {mib(budget.retiring_bytes)}</div>}
  </div>
}
