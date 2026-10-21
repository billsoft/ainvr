import {Save,X,ArrowRight,ArrowLeftRight,Columns2,Square} from 'lucide-react'
import {useEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {newAlarmOperationId} from '@/api/alarmZoneService'
import {createCounterSaveSession,flowService,methodHelp,methodNames,type Counter,type CounterInput,type CounterMethod} from '@/api/flowService'
import {labelDisplay,isCommonTarget,commonTargets} from '@/features/labelNames'
import {useFullscreenPortalHost} from '@/hooks/useFullscreenPortalHost'

interface Props {initial?:Counter;labels:{label_id:string;name:string}[];onCancel:()=>void;onSaved:(counter:CounterInput&{version:number})=>void;send?:typeof flowService.save}
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const methodIcons={line:ArrowRight,gates:Columns2,zone:Square}
// Fire and smoke are detected, not tracked targets that walk through a line.
const uncountable=new Set(['fire','smoke','火情','烟雾'])
/** One page: what is counted and how. Where the counting line lies is set in 布防. */
export function CounterDialog({initial,labels,onCancel,onSaved,send=flowService.save}:Props){
 const host=useFullscreenPortalHost(),title=useId()
 const [value,setValue]=useState<CounterInput>(()=>initial?{counter_id:initial.counter_id,name:initial.name,labels:structuredClone(initial.labels),method:initial.method,outputs:initial.outputs,
  names:{...initial.names},occupancy:initial.occupancy,max_gap_ms:initial.max_gap_ms,state:initial.state}:
  {counter_id:`counter-${newAlarmOperationId()}`,name:'',labels:labels.filter(l=>l.label_id==='person'||l.name==='person').slice(0,1),method:'line',outputs:'both',names:{in:'进',out:'出'},occupancy:true,max_gap_ms:1000,state:'enabled'})
 const [session]=useState(()=>createCounterSaveSession(initial?.version??0,send))
 const [error,setError]=useState(''),[saving,setSaving]=useState(false),[discard,setDiscard]=useState(false)
 const original=useRef(JSON.stringify(value)),dialog=useRef<HTMLDivElement>(null),first=useRef<HTMLInputElement>(null),discardPanel=useRef<HTMLElement>(null)
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;first.current?.focus();return()=>previous?.focus()},[])
 useEffect(()=>{if(discard)discardPanel.current?.querySelector('button')?.focus()},[discard])
 const patch=(change:Partial<CounterInput>)=>{setValue(v=>({...v,...change}));setError('')}
 const locked=saving||session.hasPending()
 const close=()=>{if(locked)return;if(JSON.stringify(value)!==original.current)setDiscard(true);else onCancel()}
 const merged=[...new Map([...value.labels,...labels].map(l=>[l.label_id,l])).values()].filter(l=>!uncountable.has(l.label_id)&&!uncountable.has(l.name))
 const common=(l:{label_id:string;name:string})=>isCommonTarget(l.name)||commonTargets.includes(l.label_id)
 const save=async()=>{
  if(saving)return
  const name=value.name.trim()
  if(!name)return setError('请填写计数器名称')
  if(!value.labels.length)return setError('至少选择一个统计目标')
  if(!value.names.in.trim()||(value.outputs==='both'&&(!value.names.out.trim()||value.names.in.trim()===value.names.out.trim())))return setError('请填写两个不同的方向名称')
  setSaving(true);setError('')
  try{
   const result=await session.save({...value,name,names:{in:value.names.in.trim(),out:value.names.out.trim()||'出'},occupancy:value.outputs==='both'&&value.occupancy})
   onSaved(result.counter)
  }catch(e){
   const status=(e as {status?:number}).status
   setError(status===409?'计数器已被修改，请关闭后重新打开。':[400,422].includes(status??0)?(e instanceof Error?e.message:'保存未成功，请检查后重试。'):'保存结果尚未确认，请重试保存，不会重复创建。')
  }finally{setSaving(false)}
 }
 return createPortal(<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-2 sm:p-5">
  <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title} className="alarm-workspace relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[760px] flex-col rounded-panel bg-surface shadow-modal"
   onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(discard)setDiscard(false);else close()}}}>
   <header className="border-b border-line px-6 py-4"><h2 id={title} className="text-base font-semibold">{initial?'编辑计数器':'新建计数器'}</h2>
    <p className="mt-1 text-sm text-ink-subtle">这里只定义数什么、怎么数。计数线画在哪里，到实时监看的布防中选用到热区时设置。</p></header>
   <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 py-5"><fieldset disabled={locked} className="space-y-5">
    <label className="block text-sm font-medium text-ink">名称<input ref={first} className="form-input mt-1.5" maxLength={128} placeholder="例如：客流、车辆进出" value={value.name} onChange={e=>patch({name:e.target.value})}/></label>
    <section aria-label="统计目标" className="space-y-2">
     <h3 className="text-sm font-medium text-ink">统计目标 · 已选 {value.labels.length}</h3>
     <div className="flex flex-wrap gap-2">{merged.filter(common).map(l=>{const on=value.labels.some(x=>x.label_id===l.label_id);return <button key={l.label_id} type="button" aria-pressed={on} className={choice} onClick={()=>patch({labels:on?value.labels.filter(x=>x.label_id!==l.label_id):[...value.labels,l]})}>{labelDisplay(l.name)}</button>})}</div>
     {!!merged.filter(l=>!common(l)).length&&<details className="rounded-panel border border-line"><summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-ink">更多类别（{merged.filter(l=>!common(l)).length}）</summary>
      <div className="flex flex-wrap gap-2 border-t border-line p-3">{merged.filter(l=>!common(l)).map(l=>{const on=value.labels.some(x=>x.label_id===l.label_id);return <button key={l.label_id} type="button" aria-pressed={on} className={choice} onClick={()=>patch({labels:on?value.labels.filter(x=>x.label_id!==l.label_id):[...value.labels,l]})}>{labelDisplay(l.name)}</button>})}</div></details>}
     {!merged.length&&<p role="status" className="text-sm text-ink-subtle">尚未读到模型目标，请先检查 AI 处理器。</p>}
    </section>
    <section aria-label="计数方式" className="space-y-2">
     <h3 className="text-sm font-medium text-ink">计数方式{initial&&<span className="ml-2 text-xs font-normal text-ink-faint">已有计数器不能更改，可新建</span>}</h3>
     <div role="radiogroup" aria-label="计数方式" className="grid gap-3 sm:grid-cols-3">{(['line','gates','zone'] as CounterMethod[]).map(m=>{const Icon=methodIcons[m];return <button key={m} type="button" role="radio" aria-checked={value.method===m} disabled={!!initial} onClick={()=>patch({method:m})}
      className={`relative rounded-panel border p-4 text-left transition-colors disabled:cursor-not-allowed ${value.method===m?'border-primary bg-primary-50 ring-1 ring-primary':'border-line bg-surface hover:bg-surface-hover disabled:opacity-60'}`}>
      <Icon size={20} aria-hidden="true" className="mb-2 text-primary"/><strong className="block text-sm font-semibold text-ink">{methodNames[m]}</strong><span className="mt-1 block text-xs leading-5 text-ink-subtle">{methodHelp[m]}</span>
      {value.method===m&&<span aria-hidden="true" className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-white">✓</span>}
     </button>})}</div>
    </section>
    <section aria-label="分项" className="space-y-3">
     <h3 className="text-sm font-medium text-ink">分项</h3>
     <div role="group" aria-label="统计方向" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={value.outputs==='both'} className={choice} onClick={()=>patch({outputs:'both'})}><ArrowLeftRight size={16} aria-hidden="true"/>两个方向分别计</button>
      <button type="button" aria-pressed={value.outputs==='in'} className={choice} onClick={()=>patch({outputs:'in',occupancy:false})}><ArrowRight size={16} aria-hidden="true"/>只计一个方向</button>
     </div>
     <div className="flex flex-wrap gap-3">
      <label className="block text-sm font-medium text-ink">{value.outputs==='both'?'方向名称':'名称'}<input className="form-input mt-1.5 block w-40" maxLength={32} value={value.names.in} onChange={e=>patch({names:{...value.names,in:e.target.value}})}/></label>
      {value.outputs==='both'&&<label className="block text-sm font-medium text-ink">反方向名称<input className="form-input mt-1.5 block w-40" maxLength={32} value={value.names.out} onChange={e=>patch({names:{...value.names,out:e.target.value}})}/></label>}
     </div>
     <div role="group" aria-label="常用名称" className="flex flex-wrap items-center gap-2"><span className="text-xs text-ink-subtle">常用</span>{[['进','出'],['左到右','右到左'],['上行','下行']].map(([a,b])=><button key={a} type="button" aria-pressed={value.names.in===a&&(value.outputs!=='both'||value.names.out===b)} className={choice} onClick={()=>patch({names:{in:a!,out:b!}})}>{value.outputs==='both'?`${a} / ${b}`:a}</button>)}</div>
     {value.outputs==='both'&&<label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={value.occupancy} onChange={e=>patch({occupancy:e.target.checked})}/>显示在场人数（今日“{value.names.in||'进'}”减“{value.names.out||'出'}”，每天零点清零）</label>}
    </section>
    <details className="rounded-panel border border-line"><summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-ink">高级</summary>
     <div className="space-y-2 border-t border-line p-3"><label className="block text-sm font-medium text-ink">短时漏检保留（秒）<input type="number" min="0" max="2" step="0.1" className="form-input mt-1.5 block w-32" value={value.max_gap_ms/1000} onChange={e=>patch({max_gap_ms:Math.round(Math.min(2,Math.max(0,Number(e.target.value)||0))*1000)})}/></label>
      <p className="text-xs text-ink-subtle">目标被遮挡片刻后同一编号恢复时，仍按一次通行计数；0 表示不保留。</p></div></details>
    {initial&&<label className="block text-sm font-medium text-ink">状态<select className="form-input mt-1.5 w-auto" value={value.state} onChange={e=>patch({state:e.target.value as CounterInput['state']})}><option value="enabled">启用</option><option value="paused">暂停</option><option value="archived">归档</option></select></label>}
    {initial&&value.state==='archived'&&<p className="rounded-base border border-warning bg-amber-50 p-3 text-sm">归档后从各热区解除，停止计数；已有统计保留，可在“查看已归档”中查看，不能恢复。</p>}
    {initial&&!!initial.bindings.length&&value.state!=='archived'&&<p className="rounded-base bg-surface-page p-3 text-sm">已选用到 {initial.bindings.length} 个热区，保存后同时生效。</p>}
   </fieldset>
   {error&&<p role="alert" className="rounded-base border border-danger bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}</div>
   <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-6 py-3">
    <button type="button" className="btn-secondary" disabled={locked} onClick={close}><X size={16} aria-hidden="true"/>取消</button>
    <button type="button" className="btn-primary" disabled={saving} onClick={()=>void save()}><Save size={16} aria-hidden="true"/>{saving?'保存中…':session.hasPending()?'重试保存':'保存'}</button>
   </footer>
   {discard&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4"><section ref={discardPanel} role="alertdialog" aria-label="放弃计数器修改" className="w-full max-w-sm space-y-3 rounded-panel bg-surface p-5 shadow-modal">
    <p className="text-base font-semibold">放弃尚未保存的修改？</p><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onCancel}>放弃修改</button></div></section></div>}
  </div>
 </div>,host)
}
