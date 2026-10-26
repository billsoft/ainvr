import {Archive,MoreVertical,Pencil,Play,Square,X} from 'lucide-react'
import {useEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import type {TriggerDefinition} from '@/features/alarmDefinitions'

export function TriggerActionMenu({trigger,disabled,onEdit,onState,onArchive}:{trigger:TriggerDefinition;disabled:boolean;onEdit:()=>void;onState:(state:'enabled'|'paused')=>void;onArchive:()=>void}){
 const [open,setOpen]=useState(false),button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(open)menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()},[open])
 useEffect(()=>{if(disabled)setOpen(false)},[disabled])
 const close=()=>{setOpen(false);button.current?.focus()}
 const start=trigger.state!=='enabled'
 return <div className="relative shrink-0">
  <button ref={button} type="button" disabled={disabled} aria-label="更多操作" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex h-11 w-11 items-center justify-center rounded-base text-ink-faint hover:bg-surface-page hover:text-ink disabled:opacity-40"><MoreVertical size={18}/></button>
  {open&&<><div className="fixed inset-0 z-10" onClick={close}/><div ref={menu} role="menu" aria-label={`${trigger.name}的操作`} className="absolute right-0 z-20 mt-1 w-44 rounded-base border border-line bg-surface py-1 shadow-modal" onKeyDown={e=>{
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}
   const items=Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=items.indexOf(document.activeElement as HTMLButtonElement)
   if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus()}
  }}>
   <button type="button" role="menuitem" disabled={start&&trigger.migration_review?.required} title={start&&trigger.migration_review?.required?'请先编辑并重新确认旧配置':`${start?'启用':'暂停'}此触发器的全部选用`} onClick={()=>{close();onState(start?'enabled':'paused')}} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-surface-page disabled:opacity-40">{start?<Play size={15}/>:<Square size={15}/>} {start?'启用':'暂停'}</button>
   <button type="button" role="menuitem" onClick={()=>{close();onEdit()}} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-surface-page"><Pencil size={15}/> 编辑</button>
   <button type="button" role="menuitem" onClick={()=>{close();onArchive()}} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-danger hover:bg-danger-50"><Archive size={15}/> 归档</button>
  </div></>}
 </div>
}

export function TriggerArchiveDialog({trigger,busy,uncertain,error,onConfirm,onCancel}:{trigger:TriggerDefinition;busy:boolean;uncertain:boolean;error:string;onConfirm:()=>void;onCancel:()=>void}){
 const title=useId(),dialog=useRef<HTMLDivElement>(null),cancel=useRef<HTMLButtonElement>(null)
 const locked=busy||uncertain
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';cancel.current?.focus();return()=>{document.body.style.overflow=overflow;previous?.focus()}},[])
 return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title} className="relative w-full max-w-md space-y-4 rounded-panel bg-surface p-6 shadow-modal" onKeyDown={e=>{
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!locked)onCancel()}
  if(e.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
 }}>
  <button type="button" aria-label="关闭" disabled={locked} onClick={onCancel} className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page disabled:opacity-40"><X size={18}/></button>
  <h2 id={title} className="pr-8 text-base font-semibold">归档触发器</h2>
  <p className="text-sm leading-6">归档“{trigger.name}”将停止告警并解除全部{trigger.usages?.length?` ${trigger.usages.length} 处`:''}选用。历史告警、审核和触发记录保留；归档后不能直接恢复。</p>
  {error&&<p role="alert" className="rounded-base bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
  <div className="flex justify-end gap-2"><button ref={cancel} type="button" disabled={locked} className="btn-secondary" onClick={onCancel}>取消</button><button type="button" disabled={busy} className="btn-primary bg-danger hover:bg-danger/90" onClick={onConfirm}>{busy?'正在归档…':uncertain?'重试确认归档':'确认归档'}</button></div>
 </div></div>,document.body)
}
