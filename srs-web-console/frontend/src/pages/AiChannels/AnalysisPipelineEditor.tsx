import {useEffect, useRef, useState, type ReactNode} from 'react'
import {ArrowUp, ArrowDown, GripVertical} from 'lucide-react'
import {AI_MODEL_PRESETS, SELECTABLE_AI_MODEL_PRESET_KEYS, isYoloePreset, promptSlotLimit, type AiModelPresetKey, type AiAnalysisNode} from '@/types/aiChannel'
import {buildModelAndPreprocess, wizardModelList, updateWizardModelList, type AiWizardFormValue} from '@/features/aiChannelForm'
import {PromptLabelEditor} from './PromptLabelEditor'

export function AnalysisPipelineEditor({value,onChange,error,rootConfiguration,rootError}:{value:AiWizardFormValue;onChange:(v:AiWizardFormValue)=>void;error?:string;rootConfiguration?:ReactNode;rootError?:boolean}) {
  const rootId=value.analysisPipeline?.root_id??'primary'
  const [choice,setChoice]=useState<AiModelPresetKey>('yolo26x-face')
  const [expanded,setExpanded]=useState<string|null>(rootId)
  useEffect(()=>{if(rootError)setExpanded(rootId)},[rootError,rootId,error])
  const [announcement,setAnnouncement]=useState('')
  const dragging=useRef<string|null>(null)
  const graph=value.analysisPipeline??{execution:'serial' as const,nodes:[]}
  const nodes=wizardModelList(value)
  const available=SELECTABLE_AI_MODEL_PRESET_KEYS.filter(k=>k!=='locateanything-3b'&&!nodes.some(n=>n.model.name===AI_MODEL_PRESETS[k].model.name))
  const selected=available.includes(choice)?choice:available[0]
  const update=(items:AiAnalysisNode[])=>onChange(updateWizardModelList(value,items))
  function move(id:string,to:number){
    const from=nodes.findIndex(n=>n.id===id)
    if(from<0||to<0||to>=nodes.length||from===to)return
    const reordered=[...nodes];const [item]=reordered.splice(from,1);reordered.splice(to,0,item!)
    update(reordered);setAnnouncement(`已移到第 ${to+1} 位，保存后生效`)
  }
  function changeNode(id:string,patch:Partial<AiAnalysisNode>){update(nodes.map(n=>n.id===id?{...n,...patch}:n))}
  return <section className="rounded-panel border border-line bg-page p-4" aria-label="识别模型列表">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">识别模型 <span className="font-normal text-ink-subtle">{nodes.length} / 4</span></h3>
      {nodes.length>1&&<label className="flex items-center gap-2 text-xs text-ink-subtle">执行方式<select aria-label="模型执行方式" className="min-h-11 rounded-base border border-line bg-surface px-2" value={graph.execution} onChange={e=>onChange({...value,analysisPipeline:{...graph,execution:e.target.value as 'serial'|'parallel'}})}><option value="serial">顺序执行</option><option value="parallel">并发执行（最多 2 个）</option></select></label>}
    </div>
    <p className="mt-2 text-xs leading-5 text-ink-subtle">同一标签采用靠前模型的结果，不同标签合并。拖动或使用箭头调整优先顺序，保存后生效。</p>
    <ol className="mt-3 space-y-2">{nodes.map((node,index)=>{
      const key=Object.keys(AI_MODEL_PRESETS).find(k=>AI_MODEL_PRESETS[k as AiModelPresetKey].model.name===node.model.name) as AiModelPresetKey|undefined
      const title=key?AI_MODEL_PRESETS[key].displayName:node.model.name
      return <li key={node.id} data-model-id={node.id} onDragOver={e=>{if(dragging.current)e.preventDefault()}} onDrop={e=>{e.preventDefault();if(dragging.current)move(dragging.current,index);dragging.current=null}} className="rounded-base border border-line bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" draggable={nodes.length>1} aria-label={`拖动 ${title}`} title="拖动排序，也可用上移下移按钮" className="flex min-h-11 min-w-11 cursor-grab items-center justify-center text-ink-faint" onDragStart={e=>{dragging.current=node.id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',node.id)}} onDragEnd={()=>{dragging.current=null}}><GripVertical size={18}/></button>
          <div className="min-w-0 flex-1"><div className="text-sm font-medium">{index+1}. {title}</div><div className="mt-1 text-xs text-ink-faint">{key&&isYoloePreset(key)?`${node.model.prompts?.length??0} 个自定义标签`:'固定类别'} · 阈值 {node.postprocess.conf_threshold}</div></div>
          <div className="flex shrink-0 items-center">
            <button type="button" disabled={index===0} aria-label={`上移 ${title}`} className="flex min-h-11 min-w-11 items-center justify-center text-ink-subtle disabled:opacity-25" onClick={()=>move(node.id,index-1)}><ArrowUp size={16}/></button>
            <button type="button" disabled={index===nodes.length-1} aria-label={`下移 ${title}`} className="flex min-h-11 min-w-11 items-center justify-center text-ink-subtle disabled:opacity-25" onClick={()=>move(node.id,index+1)}><ArrowDown size={16}/></button>
            <button type="button" className="min-h-11 min-w-11 px-2 text-sm text-primary" aria-label={`配置 ${title}`} aria-expanded={expanded===node.id} onClick={()=>setExpanded(expanded===node.id?null:node.id)}>{expanded===node.id?'收起':'配置'}</button>
            <button type="button" disabled={nodes.length===1} title={nodes.length===1?'通道至少保留一个识别模型':undefined} className="min-h-11 min-w-11 px-2 text-sm text-danger disabled:opacity-30" aria-label={`移除 ${title}`} onClick={()=>{update(nodes.filter(n=>n.id!==node.id));setExpanded(null);setAnnouncement(`已移除 ${title}，保存后生效`)}}>移除</button>
          </div>
        </div>
        {expanded===node.id&&<div className="mt-2 space-y-3 border-t border-line pt-3">
          {node.id===rootId&&rootConfiguration?rootConfiguration:<>
            <label className="block text-sm">识别模型<select aria-label={`${title} 模型`} value={key??''} className="mt-1.5 min-h-11 w-full rounded-base border border-line bg-surface px-2" onChange={e=>{
              const preset=e.target.value as AiModelPresetKey
              const built=buildModelAndPreprocess(preset,{...value,modelPreset:preset,prompts:node.model.prompts??[{description:'',label_id:'target',label_name:''}]})
              changeNode(node.id,{...built,postprocess:{...node.postprocess,max_detections:Math.min(node.postprocess.max_detections,isYoloePreset(preset)?300:1000)}})
            }}>{!key&&<option value="" disabled>{node.model.name}（现有配置）</option>}{SELECTABLE_AI_MODEL_PRESET_KEYS.filter(k=>k!=='locateanything-3b'&&!nodes.some(n=>n.id!==node.id&&n.model.name===AI_MODEL_PRESETS[k].model.name)).map(k=><option key={k} value={k}>{AI_MODEL_PRESETS[k].displayName}</option>)}</select></label>
            {key&&isYoloePreset(key)&&<PromptLabelEditor rows={node.model.prompts??[]} limit={promptSlotLimit(key)} onChange={prompts=>changeNode(node.id,{model:{...node.model,prompts}})}/>}
            <label className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">置信度阈值<input aria-label={`${node.model.name} 检测置信度`} className="min-h-11 w-24 rounded-base border border-line px-2" type="number" step="0.05" min="0.01" max="0.95" value={node.postprocess.conf_threshold} onChange={e=>changeNode(node.id,{postprocess:{...node.postprocess,conf_threshold:e.currentTarget.valueAsNumber}})}/><span>越高越严格，不代表准确率。</span></label>
            {key&&AI_MODEL_PRESETS[key].needsIouThreshold&&<label className="flex items-center gap-3 text-xs text-ink-subtle">IoU 阈值<input aria-label={`${node.model.name} IoU 阈值`} type="number" min={0.1} max={0.9} step={0.05} value={node.postprocess.iou_threshold} className="min-h-11 w-24 rounded-base border border-line px-2" onChange={e=>changeNode(node.id,{postprocess:{...node.postprocess,iou_threshold:e.currentTarget.valueAsNumber}})}/></label>}
            <label className="flex items-center gap-3 text-xs text-ink-subtle">最大检测数<input aria-label={`${node.model.name} 最大检测数`} type="number" min={1} max={node.model.adapter==='yoloe_bpu'?300:1000} value={node.postprocess.max_detections} className="min-h-11 w-24 rounded-base border border-line px-2" onChange={e=>changeNode(node.id,{postprocess:{...node.postprocess,max_detections:e.currentTarget.valueAsNumber}})}/></label>
          </>}
          {node.model.adapter==='plate_bpu'&&<p className="text-xs leading-5 text-ink-faint">自动检测、矫正和读牌。支持不超过 8388608 像素的输入；符合阈值的检测框全部保留，每帧最多为 4 个候选读牌；未读到不等于无牌。车辆通行仍由车辆计数器产生。</p>}
        </div>}
      </li>
    })}</ol>
    {nodes.length<4&&selected&&value.modelPreset!=='locateanything-3b'&&<div className="mt-3 flex gap-2"><select aria-label="待添加模型" value={selected} onChange={e=>setChoice(e.target.value as AiModelPresetKey)} className="min-h-11 min-w-0 flex-1 rounded-base border border-line bg-surface px-2 text-sm">{available.map(k=><option key={k} value={k}>{AI_MODEL_PRESETS[k].displayName}</option>)}</select><button type="button" className="min-h-11 rounded-base border border-primary px-3 text-sm text-primary" onClick={()=>{
      const built=buildModelAndPreprocess(selected,{...value,modelPreset:selected,prompts:[{description:'',label_id:'target',label_name:''}]})
      const id='model-'+Array.from(crypto.getRandomValues(new Uint32Array(2)),n=>n.toString(16).padStart(8,'0')).join('')
      update([...nodes,{id,...built,postprocess:{conf_threshold:0.25,iou_threshold:0.45,max_detections:300}}]);setExpanded(isYoloePreset(selected)?id:null)
    }}>添加模型</button></div>}
    <p className="mt-3 text-xs leading-5 text-ink-faint">模型共用同一视频帧并分摊算力；最大检测数合计不超过 1000。调整模型后通道会重新载入；删除或改变标签时，请检查已有计数器、触发器的绑定。</p>
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    {error&&<p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
  </section>
}
