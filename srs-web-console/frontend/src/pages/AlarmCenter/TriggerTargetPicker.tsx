import {useState} from 'react'
import {AI_MODEL_PRESETS,SELECTABLE_AI_MODEL_PRESET_KEYS,promptSlotLimit,type AiModelPresetKey} from '@/types/aiChannel'
import type {TriggerDefinitionInput} from '@/features/alarmDefinitions'
import type {TriggerLabel} from '@/features/alarmTriggers'
import {sameLabel} from '@/features/alarmTriggers'
import {labelDisplay,isCommonTarget} from '@/features/labelNames'
import {fixedTargets,targetModel,targetModelMatches} from '@/features/triggerTargets'
import type {AlarmSource} from '@/api/alarmTriggerService'
import {PromptLabelEditor} from '../AiChannels/PromptLabelEditor'

interface Props {
 value:Pick<TriggerDefinitionInput,'target_model'|'labels'>
 legacyLabels:TriggerLabel[]
 sources:AlarmSource[]
 onChange:(change:Pick<TriggerDefinitionInput,'target_model'|'labels'>)=>void
}
/** Model choice defines label identity, not an instruction to reconfigure a detector. */
export function TriggerTargetPicker({value,legacyLabels,sources,onChange}:Props){
 const [search,setSearch]=useState(''),[pending,setPending]=useState<AiModelPresetKey|null>(null)
 const key=SELECTABLE_AI_MODEL_PRESET_KEYS.find(k=>targetModelMatches(value.target_model,targetModel(k)))
 const selected=value.target_model?key:undefined
 const open=value.target_model?.mode==='open'
 const changeModel=(k:AiModelPresetKey)=>{onChange({target_model:targetModel(k),labels:[]});setPending(null);setSearch('')}
 const requestModel=(k:AiModelPresetKey)=>{if(value.labels.length)setPending(k);else changeModel(k)}
 const catalog=value.target_model?(selected?fixedTargets(selected):[]):legacyLabels
 const available=[...new Map([...catalog,...value.labels].map(l=>[l.label_id,l])).values()]
 const single=!open&&available.length===1
 const searchable=available.length>12
 const searchExample=available.slice(0,3).map(l=>labelDisplay(l.name)).join('、')
 const query=searchable?search.trim().toLowerCase():''
 const visible=available.filter(l=>!query||[l.label_id,l.name,labelDisplay(l.name)].some(s=>s.toLowerCase().includes(query)))
 const toggle=(label:TriggerLabel)=>onChange({...value,labels:value.labels.some(l=>sameLabel(l,label))?value.labels.filter(l=>!sameLabel(l,label)):[...value.labels,label]})
 const render=(items:TriggerLabel[])=>items.map(l=><button type="button" key={l.label_id} aria-pressed={value.labels.some(s=>sameLabel(s,l))} className="btn-secondary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary" onClick={()=>toggle(l)}>{labelDisplay(l.name)}</button>)
 const suggestions=sources.filter(s=>targetModelMatches(value.target_model,s.target_model))
 return <div className="space-y-4">
  <label className="block text-sm font-medium">识别模型
   <select aria-label="识别模型" className="form-input mt-1.5" value={selected??''} onChange={e=>requestModel(e.target.value as AiModelPresetKey)}>
    {!selected&&<option value="" disabled>{value.target_model?`原模型：${value.target_model.name}`:'保留原有标签（旧触发器）'}</option>}
    {SELECTABLE_AI_MODEL_PRESET_KEYS.map(k=><option key={k} value={k}>{AI_MODEL_PRESETS[k].displayName}</option>)}
   </select>
  </label>
  <p className="text-xs leading-5 text-ink-subtle">{single?`该模型仅识别${labelDisplay(available[0]!.name)}，选择此目标后继续设置判定条件。`:'目标类别来自所选模型。可选择多个类别，任一类别符合行为条件即可触发。'}</p>
  {pending&&<section role="alertdialog" aria-label="更换检测模型" className="space-y-2 rounded-panel border border-warning p-3"><p>切换模型会清除本次草稿的 {value.labels.length} 个已选目标，请重新选择；已有配置在保存前不变。</p><div className="flex gap-2"><button type="button" className="btn-secondary" onClick={()=>setPending(null)}>保留当前模型</button><button type="button" className="btn-primary" onClick={()=>changeModel(pending)}>切换并重新选择</button></div></section>}
  {selected==='locateanything-3b'&&<p className="rounded-base border border-warning bg-amber-50 p-3 text-sm">此模型用于低频检测，不支持可靠跟踪。关联时仅支持持续时间为 0 的出现或接近检出；侵入、穿过及持续停留需要可跟踪的 AI 通道。</p>}
  {open?<>
   {!!suggestions.length&&<section className="space-y-2 rounded-panel border border-line p-3"><h4 className="text-sm font-medium">从已运行的同模型通道选择标签</h4>{suggestions.map(s=><div key={s.channel_id}><p className="text-xs text-ink-subtle">{s.channel_name}</p><div className="mt-1 flex flex-wrap gap-2">{s.labels.map(l=><button type="button" key={l.label_id} className="btn-secondary" disabled={value.labels.some(v=>v.label_id===l.label_id)||value.labels.length>=promptSlotLimit(selected??'yoloe-26x')} onClick={()=>onChange({...value,labels:[...value.labels,{label_id:l.label_id,name:l.name,description:l.description}]})}>＋ {l.name||l.label_id}</button>)}</div></div>)}</section>}
   <PromptLabelEditor context="trigger" limit={promptSlotLimit(selected??'yoloe-26x')} rows={value.labels.map(l=>({label_id:l.label_id,label_name:l.name,description:l.description??''}))} onChange={rows=>onChange({...value,labels:rows.map(r=>({label_id:r.label_id,name:r.label_name,description:r.description}))})}/>
  </>:single?<button type="button" aria-label={labelDisplay(available[0]!.name)} aria-pressed={value.labels.length>0} onClick={()=>toggle(available[0]!)} className="flex min-h-16 w-full items-center justify-between rounded-panel border border-line bg-surface p-4 text-left hover:border-primary aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary"><span className="text-sm font-semibold">{labelDisplay(available[0]!.name)}</span><span className="flex items-center gap-2 text-sm"><span aria-hidden="true" className={`flex h-5 w-5 items-center justify-center rounded-full border ${value.labels.length?'border-primary bg-primary text-white':'border-ink-faint'}`}>{value.labels.length?'✓':''}</span>{value.labels.length?'已选择':'点击选择'}</span></button>:<>
   <section aria-label="已选目标" className="rounded-panel border border-primary-200 bg-primary-50 p-3"><h4 className="text-sm font-medium">已选目标 · {value.labels.length}</h4><div className="mt-2 flex flex-wrap gap-2">{value.labels.length?value.labels.map(l=><button type="button" key={l.label_id} aria-label={`移除目标 ${labelDisplay(l.name)}`} className="btn-secondary border-primary text-primary" onClick={()=>toggle(l)}>{labelDisplay(l.name)} ×</button>):<span className="text-sm text-ink-subtle">点击下方类别选择，可多选</span>}</div></section>
   <>{searchable&&<label className="block text-sm">查找类别<input type="search" className="form-input mt-1.5" placeholder={`例如：${searchExample}`} value={search} onChange={e=>setSearch(e.target.value)}/></label>}</>
   {!!visible.filter(l=>isCommonTarget(l.name)).length&&<div role="group" aria-label="常用目标" className="flex flex-wrap gap-2">{render(visible.filter(l=>isCommonTarget(l.name)))}</div>}
   {!!visible.filter(l=>!isCommonTarget(l.name)).length&&<details open={!!query} className="rounded-panel border border-line"><summary className="cursor-pointer p-3 text-sm">更多类别（{visible.filter(l=>!isCommonTarget(l.name)).length}）</summary><div role="group" aria-label="更多类别" className="flex flex-wrap gap-2 border-t border-line p-3">{render(visible.filter(l=>!isCommonTarget(l.name)))}</div></details>}
   {!visible.length&&<p role="status" className="text-sm text-ink-subtle">该模型中没有匹配的类别</p>}
  </>}
  <p className="rounded-base bg-surface-page p-3 text-xs leading-5 text-ink-subtle">保存后还需在布防中关联相同模型、相同标签的 AI 输出通道。仅选择标签不会启动识别，也不会修改 AI 通道。</p>
 </div>
}
