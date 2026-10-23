import {useEffect,useRef,useState} from 'react'
import {flowService} from '@/api/flowService'
import {newAlarmOperationId} from '@/api/alarmZoneService'
export interface ClearScope {counterId:string;counterName:string;label:string;bindingIds:string[];from:string;to:string}
/** A frozen range and operation key survive retries; no mutation occurs on opening. */
export function ClearFlowDialog({scope,onClose,onCleared}:{scope:ClearScope;onClose:()=>void;onCleared:()=>void}){
 const [key]=useState(newAlarmOperationId),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const panel=useRef<HTMLElement>(null),busyRef=useRef(false)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  panel.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
  const handler=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();if(!busyRef.current)onClose()}
   if(event.key==='Tab'){
    const items=[...panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]]
    const first=items[0],last=items.at(-1)
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
   }
  }
  document.addEventListener('keydown',handler)
  return()=>{document.removeEventListener('keydown',handler);previous?.focus()}
 },[onClose])
 const clear=async()=>{
  if(busyRef.current)return
  busyRef.current=true;setBusy(true);setError('')
  try{const result=await flowService.clear(scope.counterId,{binding_ids:scope.bindingIds,from:scope.from,to:scope.to},key);if(result.cleared!==true)throw Error('清理结果尚未确认');onCleared()}
  catch(e){setError(e instanceof Error?e.message:'清理尚未确认，请重试')}
  finally{busyRef.current=false;setBusy(false)}
 }
 const time=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false})
 return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
  <section ref={panel} role="alertdialog" aria-modal="true" aria-labelledby="clear-flow-title" aria-describedby="clear-flow-description" className="w-full max-w-lg space-y-4 rounded-panel bg-surface p-5 text-sm shadow-modal">
   <header className="flex items-center justify-between gap-2"><h2 id="clear-flow-title" className="text-base font-semibold text-ink">清理所选时段数据</h2><button type="button" aria-label="关闭" disabled={busy} onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-base hover:bg-surface-hover"><span aria-hidden="true" className="text-xl">×</span></button></header>
   <dl className="space-y-2 rounded-base bg-surface-page p-3"><div><dt className="text-xs text-ink-subtle">计数器 / 范围</dt><dd className="mt-1 font-medium">{scope.counterName} · {scope.label}</dd></div><div><dt className="text-xs text-ink-subtle">固定时间范围（当前设备时区）</dt><dd className="mt-1">{time(scope.from)} — {time(scope.to)}</dd><dd className="text-xs text-ink-subtle">包含起点，不包含终点；等待确认期间不会扩大范围。</dd></div></dl>
   <p id="clear-flow-description" className="text-ink">将清除该范围内的进出记录，合计、分项和趋势同步更新，清理后不能恢复。计数器、热区关联、录像和告警均保留，结束时间之后的通行继续正常计数。</p>
   {error&&<p role="alert" className="text-danger">{error}。重试会沿用本次范围，不会重复扩大清理。</p>}
   <footer className="flex justify-end gap-2"><button type="button" data-cancel disabled={busy} className="btn-secondary min-h-11" onClick={onClose}>取消</button><button type="button" disabled={busy} className="btn-primary min-h-11 !bg-danger hover:!bg-danger-700" onClick={()=>void clear()}>{busy?'正在清理…':error?'重试清理':'确认清理'}</button></footer>
  </section>
 </div>
}
