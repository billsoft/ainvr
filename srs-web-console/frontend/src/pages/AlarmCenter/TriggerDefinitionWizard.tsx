import {DEFAULT_REVIEW_DESCRIPTION,defaultTriggerReview} from '@/features/triggerDefaults'
import {TriggerTargetPicker} from './TriggerTargetPicker'
import {targetModel,targetError} from '@/features/triggerTargets'
import type {AlarmSource} from '@/api/alarmTriggerService'
import {ChevronLeft,ChevronRight,Save,X} from 'lucide-react'
import {useEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ScheduleEditor} from './ScheduleEditor'
import {scheduleError,scheduleSummary} from '@/features/alarmSchedule'
import {triggerBehaviors,behaviorNames,type TriggerLabel} from '@/features/alarmTriggers'
import {labelDisplay} from '@/features/labelNames'
import type {TriggerDefinition,TriggerDefinitionInput} from '@/features/alarmDefinitions'

interface Props {
 sources?:AlarmSource[];initialStep?:number;usageNames?:Record<string,string>;
 id:string;initial?:TriggerDefinition;labels:TriggerLabel[]
 onSave:(input:TriggerDefinitionInput)=>Promise<void>;onCancel:()=>void
}
const field='form-input'
const steps=['基本信息','检测目标','判定条件','布防与审核']
export function TriggerDefinitionWizard({id,initial,labels,onSave,onCancel,initialStep=0,usageNames={},sources=[]}:Props){
 const [value,setValue]=useState<TriggerDefinitionInput>(()=>initial?{
  target_model:initial.target_model,trigger_id:initial.trigger_id,name:initial.name,behavior:initial.behavior,labels:structuredClone(initial.labels),
  duration_ms:initial.duration_ms,...(initial.approach_width_percent!==undefined?{approach_width_percent:initial.approach_width_percent}:{}),
  review:initial.review?structuredClone(initial.review):undefined,alarm_enabled:initial.alarm_enabled,state:initial.state,schedule:structuredClone(initial.schedule),
 }:{target_model:targetModel('yolo26x'),trigger_id:id,name:'',behavior:'appearance',labels:[],duration_ms:3000,review:defaultTriggerReview(),alarm_enabled:true,state:'enabled',schedule:{mode:'always'}})
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
 const validation=(n:number)=>{
  if(n===0&&(!value.name.trim()||value.name.trim().length>128))return '请填写名称，最多128个字符'
  if(n===1)return targetError(value)
  if(n===2&&value.behavior==='appearance'&&(!seconds.trim()||!Number.isFinite(Number(seconds))||Number(seconds)<0||Number(seconds)>3600))return '持续时间须为0至3600秒'
  if(n===2&&value.behavior==='region_approach'&&(!percent.trim()||!Number.isFinite(Number(percent))||Number(percent)<=0||Number(percent)>100))return '接近距离须大于0且不超过画面宽度的100%'
  if(n===3&&value.review?.enabled&&(!value.review.description.trim()||value.review.description.length>500||value.review.description.includes('<|')))return '请填写审核说明，不使用保留标记'
  if(n===3&&value.review?.enabled&&(!Number.isFinite(value.review.reject_below)||value.review.reject_below<0||value.review.reject_below>0.1||!Number.isFinite(value.review.approve_above)||value.review.approve_above<0.9||value.review.approve_above>1))return '误报上限须为 0–0.1，通过下限须为 0.9–1'
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
   <button type="button" aria-label="关闭" disabled={locked} onClick={close} className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover"><X size={18}/></button>
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
    {step===1&&<TriggerTargetPicker value={value} legacyLabels={labels} sources={sources} onChange={patch}/>}
    {step===2&&<>
     {value.behavior==='appearance'?<>
      <label className="block text-sm font-medium text-ink">连续出现（秒）<input type="number" min="0" max="3600" step="0.1" inputMode="decimal" value={seconds}
       onChange={e=>{setSeconds(e.target.value);setError('')}} className={`${field} mt-1.5 sm:w-64`}/></label>
      <p className="text-sm text-ink-subtle">同一跟踪目标持续达到设定时间后记录。短时推算可续接；告警在真实检出时确认。</p>
     </>:value.behavior==='region_approach'?<>
      <label className="block text-sm font-medium text-ink">接近距离（画面宽度 %）<input type="number" min="0.001" max="100" step="any" inputMode="decimal" value={percent}
       onChange={e=>{setPercent(e.target.value);setError('')}} className={`${field} mt-1.5 sm:w-64`}/></label>
      <p className="text-sm text-ink-subtle">判断热区外侧的距离，按来源画面宽度换算。选用到热区时可以单独调整。</p>
     </>:<p className="text-sm text-ink-subtle">{value.behavior==='region_enter'?'目标须从热区外进入区内；首次出现在区内不算侵入。':'目标须从热区外进入，再从不同边离开；轨迹证据不完整时不触发。'}</p>}
     <p className="rounded-base bg-surface-page p-3 text-xs text-ink-subtle">位置按识别框底边中点判断。{value.behavior==='appearance'?'可选用到整个画面或指定热区。':'具体热区及允许方向，在实时监看的布防弹窗中设置。'}</p>
    </>}
    {step===3&&<>
     <details open={value.schedule.mode!=='always'} className="rounded-panel border border-line"><summary className="cursor-pointer p-3 text-sm font-medium">布防时段 · {scheduleSummary(value.schedule)}</summary><div className="border-t border-line p-3"><ScheduleEditor value={value.schedule} onChange={schedule=>patch({schedule})}/></div></details>
     {!value.alarm_enabled&&<p role="status" className="rounded-base border border-warning bg-amber-50 p-3 text-sm">这是旧版行为记录配置，保存后仍不生成告警。需要告警时请新建告警触发器；原有配置和历史保留。</p>}
     {value.alarm_enabled&&<section aria-label="AI 审核设置" className="space-y-3 rounded-panel border border-line p-3">
      <h4 className="text-sm font-medium">{value.review?.enabled?'AI 辅助审核':'人工审核'}</h4>
      <p className="text-xs leading-5 text-ink-subtle">{value.review?.enabled?'告警先入库，后台优先审核最新的未审核告警。系统自动提供目标类别、告警行为和关键帧说明，通常无需填写提示词。':'此触发器保留人工审核设置，可在高级设置中启用 AI 审核。'}</p>
      <p className="text-xs leading-5 text-ink-subtle">规则引擎判定持续时间、方向和越界，AI 核对关键帧中的指定目标。证据不足、判断不一致或服务不可用时保留未审核；人工决定优先。执行由系统配置中的审核开关和验证条件控制。</p>
      {value.review?.enabled&&<p role="note" className="rounded-base bg-warning-50 p-3 text-sm text-warning-700">勾选后由后台按系统审核策略处理。已授权自动确认时，证据完整且关键帧判断一致的告警会移入“已 AI 审核”；疑难保留人工。未启用自动策略时仅提供参考分析；自动判误报仍须通过模型验证。</p>}
      <details className="rounded-base border border-line"><summary className="cursor-pointer px-3 py-2.5 text-sm text-ink-subtle">高级审核设置（可选）</summary><div className="space-y-3 border-t border-line p-3">
       <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={value.review?.enabled??false} onChange={e=>patch({review:e.target.checked?{...defaultTriggerReview(),...value.review,enabled:true}:value.review?{...value.review,enabled:false}:undefined})}/>此触发器使用 AI 审核</label>
       {value.review?.enabled&&<>
        <label className="block text-sm">补充审核要求（可选）<textarea className={`${field} mt-1 min-h-20`} maxLength={500} value={value.review.description===DEFAULT_REVIEW_DESCRIPTION?'':value.review.description} onChange={e=>patch({review:{...value.review!,description:e.target.value.trim()?e.target.value:DEFAULT_REVIEW_DESCRIPTION}})} placeholder="留空使用系统模板；仅在有额外业务要求时补充"/></label>
        <p className="text-xs leading-5 text-ink-subtle">这是系统提示词末尾的补充要求，不是完整提示词。目标类别和触发条件会自动加入，无需重复填写。</p>
        <div className="grid grid-cols-2 gap-3"><label className="text-sm">误报分数上限<input className={`${field} mt-1`} type="number" min="0" max="0.1" step="0.01" value={value.review.reject_below} onChange={e=>patch({review:{...value.review!,reject_below:Number(e.target.value)}})}/></label><label className="text-sm">确认分数下限<input className={`${field} mt-1`} type="number" min="0.9" max="1" step="0.01" value={value.review.approve_above} onChange={e=>patch({review:{...value.review!,approve_above:Number(e.target.value)}})}/></label></div>
        <p className="text-xs text-warning-700">分数不是概率，也不保证正确。调整补充要求或分数参数需要样本验证；中间分数保留未审核。</p>
       </>}
      </div></details>
     </section>}
     <p className="rounded-base bg-surface-page p-3 text-sm text-ink">将会：{value.labels.length?value.labels.map(l=>labelDisplay(l.name)).join('、'):'（未选目标）'} {value.behavior==='appearance'?`连续出现满 ${seconds||0} 秒`:value.behavior==='region_approach'?`接近热区（画面宽度 ${percent||'?'}% 以内）`:`${behaviorNames[value.behavior]}热区`}时，{value.alarm_enabled?'生成告警':'保留旧版行为记录'}；{scheduleSummary(value.schedule)}。</p>
     <p className="text-xs text-ink-subtle">{!initial?'新建后默认启用；关联到 AI 输出画面或热区并保存布防后才开始告警。':value.state==='enabled'?'当前已启用。启用和暂停可在触发器列表的“更多操作”中管理。':`当前${value.state==='draft'?'为草稿':value.state==='archived'?'已归档':'已暂停'}；保存修改不会自动启用。可在列表的“更多操作”中启用。`}</p>
     {initial?.usages?.length?<section aria-label="修改影响范围" className="rounded-base border border-warning bg-amber-50 p-3 text-sm"><h4 className="font-medium">保存将更新 {initial.usages.length} 处选用</h4>
      <ul>{initial.usages.map(u=><li key={u.assignment_id}>{usageNames[u.source_id]??'来源暂不可用'} · {u.zone_name??'整个画面'} · {usageNames[u.processor_id]??'处理器暂不可用'}</li>)}</ul><p className="mt-2 text-sm">历史记录保留当时版本；本次修改应用后重新累计判定证据。</p></section>
      :null}
    </>}
    </fieldset>
    
    {error&&<p role="alert" className="mt-4 rounded-base border border-danger bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
   </div>
   <footer className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
    <button type="button" disabled={locked} onClick={close} className="btn-secondary"><X size={16} aria-hidden="true"/>取消</button>
    {step>0&&<button type="button" disabled={locked} onClick={()=>{setError('');setStep(step-1)}} className="btn-secondary"><ChevronLeft size={16} aria-hidden="true"/>上一步</button>}
    <button type="button" disabled={saving} onClick={()=>void(step===3?save():next())} className="btn-primary ml-auto">{step===3?<Save size={16} aria-hidden="true"/>:<ChevronRight size={16} aria-hidden="true"/>}{saving?'保存中…':unconfirmed?'重试确认保存':step===3?'保存':'下一步'}</button>
   </footer>
   {discard&&<div className="absolute inset-0 z-10 flex items-center justify-center rounded-panel bg-black/30 p-4"><section ref={discardPanel} tabIndex={-1} role="alertdialog" aria-label="放弃触发器修改" className="relative w-full max-w-sm space-y-3 rounded-panel bg-surface p-5 shadow-modal outline-none"><button type="button" aria-label="关闭" onClick={()=>setDiscard(false)} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-base hover:bg-surface-hover"><X size={18}/></button><p className="pr-7 text-base font-semibold">放弃尚未保存的触发器修改？</p><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="btn-primary bg-danger hover:bg-danger-700" onClick={onCancel}>放弃修改</button></div></section></div>}
  </div>
 </div>,document.body)
}
