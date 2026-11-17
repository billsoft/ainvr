import {useEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Plus,X,HardHat,Flame,Users,PersonStanding,Eye,Radar,LogIn,MoveRight} from 'lucide-react'
import type {ReactNode} from 'react'
import type {TriggerBehavior} from '@/features/alarmTriggers'
import type {PreviewScene} from '@/features/capabilityPreview/triggerPreviewModel'

export type NewRuleChoice={kind:'scene';scene:PreviewScene;title:string}|{kind:'behavior';behavior:TriggerBehavior}
const scenes:{scene:PreviewScene;title:string;help:string;icon:ReactNode}[]=[
 {scene:'helmet',title:'没戴安全帽',help:'识别到有人没戴安全帽',icon:<HardHat size={20} aria-hidden="true"/>},
 {scene:'fire',title:'冒烟或起火',help:'画面里出现烟雾或明火',icon:<Flame size={20} aria-hidden="true"/>},
 {scene:'understaffed',title:'区域人数不够 / 无人值守',help:'人数少于设定值，或岗位没人',icon:<Users size={20} aria-hidden="true"/>},
 {scene:'fall',title:'有人倒地',help:'有人持续倒在地上',icon:<PersonStanding size={20} aria-hidden="true"/>},
]
const behaviors:{behavior:TriggerBehavior;title:string;help:string;icon:ReactNode}[]=[
 {behavior:'appearance',title:'出现在画面里',help:'人、车等出现就告警，不用画区域',icon:<Eye size={20} aria-hidden="true"/>},
 {behavior:'region_approach',title:'靠近某个区域',help:'走近区域边缘，例如坑边、配电柜',icon:<Radar size={20} aria-hidden="true"/>},
 {behavior:'region_enter',title:'进入某个区域',help:'碰到或进入区域，例如禁区',icon:<LogIn size={20} aria-hidden="true"/>},
 {behavior:'region_traverse',title:'穿过某个区域',help:'从一边进、另一边出，例如闯过通道',icon:<MoveRight size={20} aria-hidden="true"/>},
]
const card='flex min-h-16 w-full items-start gap-3 rounded-panel border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-primary-50'

/** One entry for every new alarm rule: the operator says what should raise an alarm,
 * then lands in the scene setup or in the rule wizard with that choice already made. */
export function NewRuleChooser({disabled,onChoose}:{disabled?:boolean;onChoose:(choice:NewRuleChoice)=>void}){
 const [open,setOpen]=useState(false)
 return <>
  <button type="button" className="btn-primary" disabled={disabled} onClick={()=>setOpen(true)}><Plus size={16} aria-hidden="true"/>新建告警规则</button>
  {open&&<ChooserDialog onClose={()=>setOpen(false)} onChoose={choice=>{setOpen(false);onChoose(choice)}}/>}
 </>
}

function ChooserDialog({onClose,onChoose}:{onClose:()=>void;onChoose:(choice:NewRuleChoice)=>void}){
 const title=useId(),panel=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden';heading.current?.focus()
  return()=>{document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus()}
 },[])
 const option=(icon:ReactNode,name:string,help:string,pick:()=>void)=><button key={name} type="button" className={card} onClick={pick}>
  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-base bg-primary-50 text-primary">{icon}</span>
  <span className="min-w-0"><strong className="block text-sm font-semibold text-ink">{name}</strong><span className="mt-0.5 block text-xs leading-5 text-ink-subtle">{help}</span></span>
 </button>
 return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-5">
  <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="alarm-workspace relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[760px] flex-col rounded-panel bg-surface shadow-modal"
   onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();return}
    if(e.key!=='Tab'||!panel.current)return
    const nodes=Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')),first=nodes[0],last=nodes.at(-1)
    if(e.shiftKey&&(document.activeElement===first||document.activeElement===heading.current)){e.preventDefault();last?.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
   }}>
   <button type="button" aria-label="关闭" onClick={onClose} className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover"><X size={18} aria-hidden="true"/></button>
   <header className="border-b border-line px-5 py-4 pr-16">
    <h2 ref={heading} id={title} tabIndex={-1} className="text-base font-semibold outline-none">你想在什么情况下报警？</h2>
    <p className="mt-1 text-sm text-ink-subtle">选一项开始，下一步再设置细节。建好后到“实时监看 → 布防”关联到整个画面或某个区域。</p>
   </header>
   <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
    <section role="group" aria-label="常见情况" className="space-y-2">
     <h3 className="text-sm font-semibold text-ink">常见情况 <span className="font-normal text-ink-subtle">· 选了就能用</span></h3>
     <div className="grid gap-2 sm:grid-cols-2">{scenes.map(s=>option(s.icon,s.title,s.help,()=>onChoose({kind:'scene',scene:s.scene,title:s.title})))}</div>
    </section>
    <section role="group" aria-label="自己设定" className="space-y-2">
     <h3 className="text-sm font-semibold text-ink">自己设定 <span className="font-normal text-ink-subtle">· 什么东西、做了什么</span></h3>
     <div className="grid gap-2 sm:grid-cols-2">{behaviors.map(b=>option(b.icon,b.title,b.help,()=>onChoose({kind:'behavior',behavior:b.behavior})))}</div>
    </section>
   </div>
  </div>
 </div>,document.fullscreenElement??document.body)
}
