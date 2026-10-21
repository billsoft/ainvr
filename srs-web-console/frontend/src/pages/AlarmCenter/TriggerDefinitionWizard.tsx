import {ChevronLeft,ChevronRight,Save,X} from 'lucide-react'
import {useEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ScheduleEditor} from './ScheduleEditor'
import {scheduleError,scheduleSummary} from '@/features/alarmSchedule'
import {triggerBehaviors,behaviorNames,sameLabel,type TriggerLabel} from '@/features/alarmTriggers'
import {labelDisplay,isCommonTarget,commonTargets} from '@/features/labelNames'
import type {TriggerDefinition,TriggerDefinitionInput} from '@/features/alarmDefinitions'

interface Props {
 initialStep?:number;usageNames?:Record<string,string>;
 id:string;initial?:TriggerDefinition;labels:TriggerLabel[]
 onSave:(input:TriggerDefinitionInput)=>Promise<void>;onCancel:()=>void
}
const field='form-input'
const choice='btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary'
const steps=['基本信息','检测目标','判定条件','时段与用途']
export function TriggerDefinitionWizard({id,initial,labels,onSave,onCancel,initialStep=0,usageNames={}}:Props){
 const [value,setValue]=useState<TriggerDefinitionInput>(()=>initial?{
  trigger_id:initial.trigger_id,name:initial.name,behavior:initial.behavior,labels:structuredClone(initial.labels),
  duration_ms:initial.duration_ms,...(initial.approach_width_percent!==undefined?{approach_width_percent:initial.approach_width_percent}:{}),
  alarm_enabled:initial.alarm_enabled,state:initial.state,schedule:structuredClone(initial.schedule),
 }:{trigger_id:id,name:'',behavior:'appearance',labels:[],duration_ms:3000,alarm_enabled:true,state:'enabled',schedule:{mode:'always'}})
 const [seconds,setSeconds]=useState(String((initial?.duration_ms??3000)/1000))
 const [percent,setPercent]=useState(String(initial?.approach_width_percent??''))
 const [step,setStep]=useState(initialStep),[error,setError]=useState(''),[saving,setSaving]=useState(false)
 const discardPanel=useRef<HTMLElement>(null)
 const original=useRef(JSON.stringify({value,seconds,percent}))
 const [discard,setDiscard]=useState(false)
 const [unconfirmed,setUnconfirmed]=useState(false)
 const locked=saving||unconfirmed
 const busy=useRef(false),dialog=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null),title=useId()
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow
  document.body.style.overflow='hidden'
  return()=>{document.body.style.overflow=overflow;previous?.focus()}
 },[])
 useEffect(()=>{heading.current?.focus()},[step])
 useEffect(()=>{if(discard)discardPanel.current?.focus();else if(dialog.current&&!dialog.current.contains(document.activeElement))heading.current?.focus()},[discard])
 const close=()=>{if(locked)return;if(JSON.stringify({value,seconds,percent})!==original.current)setDiscard(true);else onCancel()}
 const patch=(change:Partial<TriggerDefinitionInput>)=>{setValue(v=>({...v,...change}));setError('')}
 const merged=[...new Map([...value.labels,...labels].map(l=>[JSON.stringify([l.label_id,l.name]),l])).values()]
 const common=(l:TriggerLabel)=>isCommonTarget(l.name)||commonTargets.includes(l.label_id)
 const renderTargets=(items:TriggerLabel[])=>items.map(l=>{const selected=value.labels.some(x=>sameLabel(x,l));return <button key={JSON.stringify(l)} type="button" aria-pressed={selected} className={choice} onClick={()=>patch({labels:selected?value.labels.filter(x=>!sameLabel(x,l)):[...value.labels,l]})}>{labelDisplay(l.name)}</button>})
 const validation=(n:number)=>{
  if(n===0&&(!value.name.trim()||value.name.trim().length>128))return '请填写名称，最多128个字符'
  if(n===1&&!value.labels.length)return '至少选择一个检测目标'
  if(n===2&&value.behavior==='appearance'&&(!seconds.trim()||!Number.isFinite(Number(seconds))||Number(seconds)<0||Number(seconds)>3600))return '持续时间须为0至3600秒'
  if(n===2&&value.behavior==='region_approach'&&(!percent.trim()||!Number.isFinite(Number(percent))||Number(percent)<=0||Number(percent)>100))return '接近距离须大于0且不超过画面宽度的100%'
  return n===3?scheduleError(value.schedule):''
 }
 const next=()=>{const problem=validation(step);if(problem)setError(problem);else{setError('');setStep(step+1)}}
 const save=async()=>{
  if(busy.current)return
  for(let n=0;n<4;n++){const problem=validation(n);if(problem){setStep(n);setError(problem);return}}
  busy.current=true;setSaving(true);setError('')
  try{
   const {approach_width_percent:_,...base}=value
   await onSave({...base,name:value.name.trim(),duration_ms:value.behavior==='appearance'?Math.round(Number(seconds)*1000):0,
    ...(value.behavior==='region_approach'?{approach_width_percent:Number(percent)}:{})})
  }catch(e){
   const status=(e as {status?:number}).status
   const definitive=[400,409,422].includes(status??0)
   setUnconfirmed(!definitive)
   setError(status===409?'配置已变化，请重新读取后确认。当前草稿仍保留。':
    definitive?'保存未成功，请检查当前条件后重试。':'保存结果尚未确认，草稿已锁定。请重试确认原操作，避免重复创建。')
  }
  finally{busy.current=false;setSaving(false)}
 }
 return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-5">
  <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={title}
   className="alarm-workspace relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[880px] flex-col rounded-panel bg-surface shadow-modal"
   onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(discard)setDiscard(false);else close();return}
    if(e.key!=='Tab')return
    const scope=discard?discardPanel.current:dialog.current
    const nodes=Array.from(scope?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[])
    const first=nodes[0],last=nodes.at(-1)
    if(e.shiftKey&&(document.activeElement===first||document.activeElement===heading.current||document.activeElement===scope)){e.preventDefault();last?.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
   }}>
   <header className="border-b border-line px-6 pb-4 pt-5">
    <h2 id={title} className="text-base font-semibold">{initial?'编辑触发器':'新建触发器'}</h2>
    <ol aria-label="创建步骤" className="mt-3 grid grid-cols-4 gap-2 text-xs">{steps.map((s,i)=><li key={s} aria-current={step===i?'step':undefined} className={`flex items-center gap-2 py-2 ${step===i?'font-semibold text-primary-700':'text-ink-subtle'}`}><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${step===i?'bg-primary text-white':'border border-line'}`}>{i+1}</span><span>{s}</span></li>)}</ol>
   </header>
   <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
    <h3 ref={heading} tabIndex={-1} className="mb-4 text-sm font-medium text-ink outline-none">{steps[step]}</h3>
    <fieldset disabled={locked} className="space-y-4">
    {step===0&&<>
     <label className="block text-sm font-medium text-ink">触发器名称<input className={`${field} mt-1.5`} placeholder="例如：门前人员出现" maxLength={128} value={value.name} onChange={e=>patch({name:e.target.value})}/></label>
     <div role="group" aria-label="检测行为" className="grid gap-3 sm:grid-cols-2">{triggerBehaviors.map(b=><button key={b.id} type="button" aria-pressed={value.behavior===b.id}
      onClick={()=>patch({behavior:b.id})} className={`relative rounded-panel border p-4 text-left transition-colors ${value.behavior===b.id?'border-primary bg-primary-50 ring-1 ring-primary':'border-line bg-surface hover:bg-surface-hover'}`}>
      <strong className="block text-sm font-semibold text-ink">{b.name}</strong><span className="mt-1 block text-xs leading-5 text-ink-subtle">{b.help}</span>
      {value.behavior===b.id&&<span aria-hidden="true" className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-white">✓</span>}
     </button>)}</div>
     <p className="text-sm text-ink-subtle">先定义检测什么，再到实时监看中选用到整个画面或热区。</p>
    </>}
    {step===1&&<>
     <section aria-label="已选目标" className="rounded-panel border border-primary-200 bg-primary-50 p-3">
      <h4 className="text-sm font-medium text-ink">已选目标 · {value.labels.length}</h4>
      <div className="mt-2 flex flex-wrap gap-2">{value.labels.length?value.labels.map(l=><button type="button" key={JSON.stringify(l)} aria-label={`移除目标 ${labelDisplay(l.name)}`} className="btn-secondary border-primary py-1.5 text-primary" onClick={()=>patch({labels:value.labels.filter(x=>!sameLabel(x,l))})}>{labelDisplay(l.name)}<span aria-hidden="true" className="ml-2">×</span></button>):<span className="text-sm text-ink-subtle">尚未选择</span>}</div>
     </section>
     <div className="space-y-3">
      {!!merged.filter(common).length&&<><h4 className="text-sm font-medium text-ink">常用目标</h4><div role="group" aria-label="常用目标" className="flex flex-wrap gap-2">{renderTargets(merged.filter(common))}</div></>}
      {!!merged.filter(l=>!common(l)).length&&<details open={!merged.some(common)} className="rounded-panel border border-line"><summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-ink">更多类别（{merged.filter(l=>!common(l)).length}）</summary><div role="group" aria-label="更多类别" className="flex flex-wrap gap-2 border-t border-line p-3">{renderTargets(merged.filter(l=>!common(l)))}</div></details>}
     </div>
     {!merged.length&&<p role="status">尚未读到模型目标目录，请先检查 AI 处理器。已有草稿不会丢失。</p>}
     <p className="text-sm text-ink-subtle">可选多个；未选择的目标不监控。选用时会再次检查模型是否支持。</p>
    </>}
    {step===2&&<>
     {value.behavior==='appearance'?<>
      <label className="block text-sm font-medium text-ink">连续出现（秒）<input type="number" min="0" max="3600" step="0.1" inputMode="decimal" value={seconds}
       onChange={e=>{setSeconds(e.target.value);setError('')}} className={`${field} mt-1.5 sm:w-64`}/></label>
      <p className="text-sm text-ink-subtle">同一跟踪目标持续达到设定时间后记录。短时推算可续接；告警在真实检出时确认。</p>
     </>:value.behavior==='region_approach'?<>
      <label className="block text-sm font-medium text-ink">接近距离（画面宽度 %）<input type="number" min="0.001" max="100" step="any" inputMode="decimal" value={percent}
       onChange={e=>{setPercent(e.target.value);setError('')}} className={`${field} mt-1.5 sm:w-64`}/></label>
      <p className="text-sm text-ink-subtle">判断热区外侧的距离，按来源画面宽度换算。选用到热区时可以单独调整。</p>
     </>:<p className="text-sm text-ink-subtle">{value.behavior==='region_enter'?'目标须从热区外进入区内；首次出现在区内不算侵入。':'目标须从热区外进入，再从不同边离开；轨迹证据不完整时不计数。'}</p>}
     <p className="rounded-base bg-surface-page p-3 text-xs text-ink-subtle">位置按识别框底边中点判断。{value.behavior==='appearance'?'可选用到整个画面或指定热区。':'具体热区及允许方向，在实时监看的布防弹窗中设置。'}</p>
    </>}
    {step===3&&<>
     <ScheduleEditor value={value.schedule} onChange={schedule=>patch({schedule})}/>
     <div><p className="text-sm font-medium text-ink">用途</p><div role="group" aria-label="用途" className="mt-1.5 flex gap-2">{([[false,'仅统计'],[true,'统计并告警']] as const).map(([v,n])=><button key={String(v)} type="button" aria-pressed={value.alarm_enabled===v} className={choice} onClick={()=>patch({alarm_enabled:v})}>{n}</button>)}</div></div>
     <label className="block text-sm font-medium text-ink">保存后状态<select className={`${field} mt-1.5`} value={value.state} onChange={e=>patch({state:e.target.value as TriggerDefinitionInput['state']})}>
      <option value="enabled">已启用</option><option value="paused">已暂停</option><option value="draft">草稿</option>{initial&&<option value="archived">归档</option>}</select></label>
     <p className="rounded-base bg-surface-page p-3 text-sm text-ink">将会：{value.labels.length?value.labels.map(l=>labelDisplay(l.name)).join('、'):'（未选目标）'} {value.behavior==='appearance'?`连续出现满 ${seconds||0} 秒`:value.behavior==='region_approach'?`接近热区（画面宽度 ${percent||'?'}% 以内）`:`${behaviorNames[value.behavior]}热区`}时，{value.alarm_enabled?'记录并告警':'只记录统计'}；{scheduleSummary(value.schedule)}。</p>
     {value.state==='archived'&&<p className="rounded-base border border-warning p-3 text-sm">保存后归档此触发器，解除全部选用。历史告警与统计保留；归档后不能直接恢复。</p>}
     {initial?.usages?.length?<section aria-label="修改影响范围" className="rounded-base border border-warning bg-amber-50 p-3 text-sm"><h4 className="font-medium">保存将更新 {initial.usages.length} 处选用</h4>
      <ul>{initial.usages.map(u=><li key={u.assignment_id}>{usageNames[u.source_id]??'来源暂不可用'} · {u.zone_name??'整个画面'} · {usageNames[u.processor_id]??'处理器暂不可用'}</li>)}</ul><p className="mt-2 text-sm">历史记录保留当时版本；本次修改应用后重新累计判定证据。</p></section>
      :<p className="text-sm text-ink-subtle">尚未选用。保存后，到实时监看中布防才能开始统计或告警。</p>}
    </>}
    </fieldset>
    
    {error&&<p role="alert" className="mt-4 rounded-base border border-danger bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
   </div>
   <footer className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
    <button type="button" disabled={locked} onClick={close} className="btn-secondary"><X size={16} aria-hidden="true"/>取消</button>
    {step>0&&<button type="button" disabled={locked} onClick={()=>{setError('');setStep(step-1)}} className="btn-secondary"><ChevronLeft size={16} aria-hidden="true"/>上一步</button>}
    <button type="button" disabled={saving} onClick={()=>void(step===3?save():next())} className="btn-primary ml-auto">{step===3?<Save size={16} aria-hidden="true"/>:<ChevronRight size={16} aria-hidden="true"/>}{saving?'保存中…':unconfirmed?'重试确认保存':step===3?'保存':'下一步'}</button>
   </footer>
   {discard&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4"><section ref={discardPanel} tabIndex={-1} role="alertdialog" aria-label="放弃触发器修改" className="w-full max-w-sm space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none"><p className="text-base font-semibold">放弃尚未保存的触发器修改？</p><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onCancel}>放弃修改</button></div></section></div>}
  </div>
 </div>,document.body)
}
