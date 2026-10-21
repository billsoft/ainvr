import {X,PlayCircle} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Link} from 'react-router-dom'
import {flowService,type CounterResult,type Passage} from '@/api/flowService'
import {labelDisplay} from '@/features/labelNames'
import {useFullscreenPortalHost} from '@/hooks/useFullscreenPortalHost'
interface Props {result:CounterResult;from:string;to:string;output:'in'|'out';bindingId?:string;zoneName:(z:CounterResult['zones'][number])=>string;onClose:()=>void}
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
/** Passages behind a number, newest first; each links to the recording around it. */
export function RecordsDrawer({result,from,to,output:initialOutput,bindingId,zoneName,onClose}:Props){
 const host=useFullscreenPortalHost(),panel=useRef<HTMLDivElement>(null)
 const counter=result.counter,outputs:('in'|'out')[]=counter.outputs==='both'?['in','out']:['in']
 const [zone,setZone]=useState(bindingId??result.zones[0]?.binding_id??''),[output,setOutput]=useState(initialOutput)
 const [rows,setRows]=useState<Passage[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false)
 const selected=result.zones.find(z=>z.binding_id===zone)
 const load=async(next?:string)=>{
  if(!zone)return
  setBusy(true);setError('')
  try{const r=await flowService.records({counter_id:counter.counter_id,binding_id:zone,output,from,to,...(next?{cursor:next}:{}),limit:30})
   setRows(old=>next?[...old,...r.items]:r.items);setCursor(r.next_cursor);setLoaded(true)}
  catch(e){setError(e instanceof Error?e.message:'读取失败')}finally{setBusy(false)}
 }
 useEffect(()=>{setRows([]);setLoaded(false);void load()},[zone,output])
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;panel.current?.focus();return()=>previous?.focus()},[])
 const label=(id:string)=>labelDisplay(counter.labels.find(l=>l.label_id===id)?.name??id)
 return createPortal(<div className="fixed inset-0 z-[60] flex justify-end bg-black/40" onClick={onClose}>
  <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`通行记录 · ${counter.name}`} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose()}}}
   className="alarm-workspace flex h-full w-full max-w-[520px] flex-col bg-surface shadow-modal outline-none">
   <header className="flex items-center gap-3 border-b border-line px-5 py-4"><div className="min-w-0 flex-1"><h2 className="text-base font-semibold text-ink">通行记录 · {counter.name}</h2>
    <p className="mt-0.5 text-xs text-ink-subtle">{new Date(from).toLocaleString('zh-CN')} — {new Date(to).toLocaleString('zh-CN')}</p></div>
    <button type="button" className="btn-secondary px-2.5" aria-label="关闭通行记录" onClick={onClose}><X size={16} aria-hidden="true"/></button></header>
   <div className="space-y-3 border-b border-line px-5 py-3">
    {result.zones.length>1&&<div role="group" aria-label="热区" className="flex flex-wrap gap-2">{result.zones.map(z=><button key={z.binding_id} type="button" aria-pressed={zone===z.binding_id} className={choice} onClick={()=>setZone(z.binding_id)}>{zoneName(z)}</button>)}</div>}
    {outputs.length>1&&<div role="group" aria-label="方向" className="flex gap-2">{outputs.map(o=><button key={o} type="button" aria-pressed={output===o} className={choice} onClick={()=>setOutput(o)}>{counter.names[o]} {selected?.[o]?.occurrences??0}</button>)}</div>}
   </div>
   <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
    {error&&<p role="alert" className="text-sm text-danger">{error} <button type="button" className="btn-secondary ml-2" onClick={()=>void load()}>重试</button></p>}
    {loaded&&!rows.length&&!error&&<p className="py-8 text-center text-sm text-ink-subtle">这段时间没有记录。</p>}
    <ul className="divide-y divide-line">{rows.map(r=>{const at=Date.parse(r.occurred_at);return <li key={r.event_id} className="flex items-center gap-3 py-3 text-sm">
     <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${output==='in'?'bg-success-50 text-success-700':'bg-orange-50 text-orange-700'}`}>{counter.names[output]}</span>
     <div className="min-w-0 flex-1"><p className="font-medium text-ink">{new Date(at).toLocaleTimeString('zh-CN')}<span className="ml-2 text-xs font-normal text-ink-subtle">{new Date(at).toLocaleDateString('zh-CN')}</span></p>
      <p className="text-xs text-ink-subtle">{label(r.label_id)}{r.quality?.observation_gaps?' · 中途短暂遮挡':''}</p></div>
     {selected&&<Link className="btn-secondary px-3 py-1.5" to={`/playback/${encodeURIComponent(selected.source_id)}?from=${at-20000}&to=${at+20000}`}><PlayCircle size={16} aria-hidden="true"/>录像</Link>}
    </li>})}</ul>
    {busy&&<p role="status" className="py-3 text-sm text-ink-subtle">正在读取…</p>}
    {cursor&&!busy&&<button type="button" className="btn-secondary mt-2 w-full" onClick={()=>void load(cursor)}>加载更早的记录</button>}
   </div>
  </div>
 </div>,host)
}
