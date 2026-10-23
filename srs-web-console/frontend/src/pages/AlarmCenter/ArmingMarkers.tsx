import {AlertTriangle,Bell,ArrowLeftRight,Plus,Check,ChevronRight} from 'lucide-react'
import {useLayoutEffect,useRef,useState} from 'react'
import {placeMarkers,type MarkerTarget} from '@/features/armingMarkerLayout'
interface MarkerProps {targets:MarkerTarget[];selected:string|null;disabled:boolean;onSelect:(id:string)=>void;onGroup:(target:MarkerTarget,kind:'trigger'|'counter')=>void}
export function ArmingMarkers({targets,selected,disabled,onSelect,onGroup}:MarkerProps){
 const ref=useRef<HTMLDivElement>(null),[size,setSize]=useState({width:1000,height:500})
 useLayoutEffect(()=>{const el=ref.current;if(!el)return;const update=()=>{const b=el.getBoundingClientRect();if(b.width&&b.height)setSize({width:b.width,height:b.height})};update();if(typeof ResizeObserver==='undefined'){window.addEventListener('resize',update);return()=>window.removeEventListener('resize',update)}const ro=new ResizeObserver(update);ro.observe(el);return()=>ro.disconnect()},[])
 const positions=placeMarkers(targets,size.width,size.height)
 return <div ref={ref} className="pointer-events-none absolute inset-0" aria-label="画面关联标记">
  <svg className="absolute inset-0 h-full w-full" aria-hidden="true">{targets.map((t,i)=>{const p=positions[i]!;return !t.frame&&<line key={t.id} x1={p.ax} y1={p.ay} x2={p.x+p.w/2} y2={p.y+p.h} stroke="white" strokeOpacity=".7" strokeWidth="1"/>})}</svg>
  {targets.map((t,i)=>{const p=positions[i]!,warn=[...t.triggers,...t.counters].some(i=>i.warn);return <div key={t.id} style={{left:p.x,top:p.y,width:p.w}} className={`pointer-events-auto absolute flex h-11 items-center overflow-hidden rounded-base border text-sm text-white shadow-sm backdrop-blur-sm ${selected===t.id?'border-primary bg-slate-900/95 ring-1 ring-primary':'border-white/30 bg-slate-900/80'}`}>
   <button type="button" disabled={disabled} className="flex h-11 min-w-0 flex-1 items-center gap-1 px-2 text-left hover:bg-white/10" aria-label={`${t.name}：触发器 ${t.triggers.length}，计数器 ${t.counters.length}`} onClick={()=>onSelect(t.id)}><span className="truncate">{t.name}</span>{warn&&<AlertTriangle size={14} className="shrink-0 text-amber-300" aria-hidden="true"/>}</button>
   <button type="button" disabled={disabled} className="flex h-11 min-w-11 items-center justify-center gap-1 border-l border-white/20 hover:bg-white/10" aria-label={`${t.name}的触发器（${t.triggers.length}）`} onClick={()=>onGroup(t,'trigger')}><Bell size={15} aria-hidden="true"/>{t.triggers.length}</button>
   {!t.frame&&<button type="button" disabled={disabled} className="flex h-11 min-w-11 items-center justify-center gap-1 border-l border-white/20 text-teal-200 hover:bg-white/10" aria-label={`${t.name}的计数器（${t.counters.length}）`} onClick={()=>onGroup(t,'counter')}><ArrowLeftRight size={15} aria-hidden="true"/>{t.counters.length}</button>}
  </div>})}
 </div>
}
interface SelectionProps {target:MarkerTarget;disabled:boolean;onTrigger:(id:string)=>void;onCounter:(id:string)=>void;onAddTrigger:()=>void;onAddCounter:()=>void}
/** Full controls stay beside/below the image; labels on the image never expand. */
export function ArmingSelection({target:t,disabled,onTrigger,onCounter,onAddTrigger,onAddCounter}:SelectionProps){
 return <section aria-label={`${t.name} 的选用`} className="space-y-5 text-sm">
  {t.frame&&<header className="space-y-2"><h3 className="break-words text-base font-semibold text-ink">{t.name}</h3><p className="text-xs text-ink-subtle">{t.frame?'整个画面的出现检测':'此处设置只影响当前热区，统一保存布防后生效。'}</p></header>}
  {(['trigger','counter'] as const).filter(k=>!t.frame||k==='trigger').map(kind=>{const items=kind==='trigger'?t.triggers:t.counters,Icon=kind==='trigger'?Bell:ArrowLeftRight;return <div key={kind} className="space-y-2 border-t border-line pt-4">
   <h4 className="flex items-center gap-2 font-medium text-ink"><Icon size={16} aria-hidden="true"/>已关联{kind==='trigger'?'触发器':'计数器'} <span className="rounded-full bg-surface-page px-2 py-0.5 text-xs text-ink-subtle">{items.length}</span></h4>
   {items.map(i=><button key={i.id} type="button" disabled={disabled} aria-label={i.label} className={`group flex min-h-11 w-full items-center gap-3 rounded-card border p-3 text-left transition-colors ${i.warn?'border-warning bg-amber-50':kind==='trigger'?'border-blue-200 bg-blue-50/70 hover:border-blue-400 hover:bg-blue-50':'border-teal-200 bg-teal-50/70 hover:border-teal-400 hover:bg-teal-50'}`} onClick={()=>kind==='trigger'?onTrigger(i.id):onCounter(i.id)}>
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-base ${i.warn?'bg-amber-100 text-amber-700':kind==='trigger'?'bg-blue-100 text-blue-700':'bg-teal-100 text-teal-700'}`}><Icon size={18} aria-hidden="true"/></span>
    <span className="min-w-0 flex-1"><strong className="block break-words text-sm font-semibold text-ink">{i.name}</strong><span className={`mt-1 flex items-center gap-1 text-xs ${i.warn?'text-amber-800':i.muted?'text-ink-subtle':kind==='trigger'?'text-blue-700':'text-teal-700'}`}>{i.warn?<><AlertTriangle size={13} aria-hidden="true"/>需要重新设置</>:i.muted?'未启用':<><Check size={13} aria-hidden="true"/>已关联</>}</span></span>
    <ChevronRight size={16} className="shrink-0 text-ink-subtle" aria-hidden="true"/>
   </button>)}
   {!items.length&&<p className="text-ink-subtle">尚未关联{kind==='trigger'?'触发器':'计数器'}</p>}
   <button type="button" disabled={disabled||(kind==='counter'&&!!t.noCounting)} className="btn-secondary min-h-11 w-full" aria-label={kind==='trigger'?(t.frame?'整个画面选用触发器':`为 ${t.name} 选用触发器`):`为 ${t.name} 选用计数器`} onClick={kind==='trigger'?onAddTrigger:onAddCounter}><Plus size={16} aria-hidden="true"/>添加{kind==='trigger'?'触发器':'计数器'}</button>
   {kind==='counter'&&t.noCounting&&<p className="text-xs text-ink-subtle">{t.noCounting}</p>}
  </div>})}
 </section>
}
