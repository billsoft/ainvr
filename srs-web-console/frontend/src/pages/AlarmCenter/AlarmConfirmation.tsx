import {useEffect,useRef,type ReactNode} from 'react'
import {X} from 'lucide-react'

/** A single confirmation layer; it never inserts a form between alarm rows. */
export function AlarmConfirmation({busy,close,children}:{busy:boolean;close:()=>void;children:ReactNode}){
 const dialog=useRef<HTMLElement>(null),cancel=useRef<HTMLButtonElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden';cancel.current?.focus()
  return()=>{document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();else document.querySelector<HTMLElement>('[aria-label="处理状态"] button')?.focus()}
 },[])
 return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4" onClick={e=>{if(e.target===e.currentTarget&&!busy)close()}}>
  <section ref={dialog} role="dialog" aria-modal="true" aria-label="批量确认告警" className="w-full max-w-lg overflow-hidden rounded-panel bg-surface shadow-modal" onKeyDown={e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)close();return}
   if(e.key!=='Tab')return
   const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')??[]),first=nodes[0],last=nodes[nodes.length-1]
   if(!first){e.preventDefault();return}
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  }}>
   <header className="flex items-center justify-between border-b border-line px-5 py-3"><h2 className="text-base font-semibold">批量确认告警</h2><button ref={cancel} type="button" aria-label="关闭批量确认" disabled={busy} onClick={close} className="flex h-11 w-11 items-center justify-center rounded-base hover:bg-surface-page"><X size={20} aria-hidden="true"/></button></header>
   <div className="p-5">{children}</div>
  </section>
 </div>
}
