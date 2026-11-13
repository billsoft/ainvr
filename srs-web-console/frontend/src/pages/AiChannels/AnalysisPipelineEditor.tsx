import { useRef, useState } from 'react'
import { ArrowUp, ArrowDown, GripVertical, Settings2 } from 'lucide-react'
import { availableModelPresetKeys, isPreviewModelPreset, modelCapabilitySaveBlock, modelPresetGroups, modelPresetKey, modelPresetOptionLabel, MODEL_PREVIEW_NOTICE } from '@/features/modelCapabilities'
import { AI_MODEL_PRESETS, isOpenVocabularyPreset, type AiModelPresetKey, type AiAnalysisNode } from '@/types/aiChannel'
import { buildModelAndPreprocess, wizardModelList, updateWizardModelList, type AiWizardFormValue } from '@/features/aiChannelForm'
import { fixedTargets } from '@/features/triggerTargets'
import { ModelParametersDialog, modelParameterError } from './ModelParametersDialog'

export function AnalysisPipelineEditor({ value, onChange, error }: {
  value: AiWizardFormValue; onChange: (v: AiWizardFormValue) => void | boolean; error?: string
}) {
  const [choice, setChoice] = useState<AiModelPresetKey>('yolo26x-face')
  const [allowSameCapability, setAllowSameCapability] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const dragging = useRef<string | null>(null)
  const nodes = wizardModelList(value)
  const available: AiModelPresetKey[] = availableModelPresetKeys(nodes.map(n => n.model), allowSameCapability).filter(k => k !== 'locateanything-3b')
  const selected = available.includes(choice) ? choice : available[0]
  const used = nodes.reduce((sum, n) => sum + n.postprocess.max_detections, 0)
  const remaining = Number.isFinite(used) ? Math.max(0, 1000 - used) : 0
  const blocked = modelCapabilitySaveBlock(nodes.map(n => n.model))
  const editedNode = nodes.find(n => n.id === editing)
  function update(items: AiAnalysisNode[]) { onChange(updateWizardModelList(value, items)) }
  function move(id: string, to: number) {
    const from = nodes.findIndex(n => n.id === id)
    if (from < 0 || to < 0 || to >= nodes.length || from === to) return
    const reordered = [...nodes]; const [item] = reordered.splice(from, 1); reordered.splice(to, 0, item!)
    update(reordered); setAnnouncement(`已移到第 ${to + 1} 位，仅修改草稿`)
  }
  function applyModel(node: AiAnalysisNode) {
    let next = updateWizardModelList(value, nodes.map(n => n.id === node.id ? node : n))
    // Ordinary per-model changes never reset common FPS. The exclusive slow
    // model alone changes its meaning from FPS to a capture interval.
    if (next.modelPreset !== value.modelPreset && (next.modelPreset === 'locateanything-3b' || value.modelPreset === 'locateanything-3b'))
      next = { ...next, inferenceFps: next.modelPreset === 'locateanything-3b' ? 1 / 120 : 5 }
    const accepted = onChange(next)
    setEditing(null); setAnnouncement(accepted === false ? '请确认通道跟踪设置变更' : '模型参数已应用到通道草稿，保存通道后生效')
  }
  return <section aria-label="识别模型列表" className="space-y-3">
    <div><h3 className="text-sm font-semibold text-ink">识别模型 <span className="ml-1 font-normal text-ink-subtle">{nodes.length} / 4</span></h3>
      <p className="mt-1 text-xs text-ink-subtle">添加后使用默认参数，需要调整时点击“配置”。</p></div>
    <ol className="space-y-2">{nodes.map((node, index) => {
      const key = modelPresetKey(node.model)
      const title = key ? AI_MODEL_PRESETS[key].displayName : node.model.name
      const classCount = node.model.class_names?.length || (key ? fixedTargets(key).length : 0)
      const problem = modelParameterError(node)
      const custom = node.postprocess.conf_threshold !== .25 || node.postprocess.iou_threshold !== .45 || node.postprocess.max_detections !== 300
      return <li key={node.id} data-model-id={node.id}
        onDragOver={e => { if (dragging.current) e.preventDefault() }}
        onDrop={e => { e.preventDefault(); if (dragging.current) move(dragging.current, index); dragging.current = null }}
        className={`rounded-panel border bg-surface p-3 ${problem ? 'border-warning-200' : 'border-line'}`}>
        <div className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 sm:flex">
          <button type="button" draggable={nodes.length > 1} aria-label={`拖动 ${title}`} title="拖动排序，也可使用上移下移"
            className="flex min-h-11 min-w-11 cursor-grab items-center justify-center text-ink-faint"
            onDragStart={e => { dragging.current = node.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id) }} onDragEnd={() => { dragging.current = null }}><GripVertical size={18} /></button>
          <div className="min-w-0 flex-1"><div className="break-words text-sm font-medium text-ink">{index + 1}. {title}</div>
            <div className="mt-1 text-xs text-ink-subtle">{key && isOpenVocabularyPreset(key) ? `${node.model.prompts?.length ?? 0} 个识别目标` : classCount ? `${classCount} 个固定类别` : '固定类别（数量未知）'} · {problem ? '待完善' : custom ? '已调整参数' : '默认参数'}</div></div>
          <button type="button" aria-label={`配置 ${title}`} onClick={() => setEditing(node.id)} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-base border border-line px-3 text-sm text-primary hover:bg-primary-50"><Settings2 size={15} />配置</button>
          <div className="col-span-2 col-start-2 ml-auto flex items-center gap-1">
            <button type="button" disabled={index === 0} aria-label={`上移 ${title}`} className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-page disabled:opacity-25" onClick={() => move(node.id, index - 1)}><ArrowUp size={16} /></button>
            <button type="button" disabled={index === nodes.length - 1} aria-label={`下移 ${title}`} className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-page disabled:opacity-25" onClick={() => move(node.id, index + 1)}><ArrowDown size={16} /></button>
            <button type="button" disabled={nodes.length === 1} title={nodes.length === 1 ? '至少保留一个模型' : '仅从通道草稿中移除'} aria-label={`移除 ${title}`} className="min-h-11 min-w-11 rounded-base px-2 text-sm text-ink-subtle hover:text-danger disabled:opacity-25"
              onClick={() => { update(nodes.filter(n => n.id !== node.id)); setAnnouncement(`已移除 ${title}，仅修改草稿`) }}>移除</button>
          </div>
        </div>
        {problem && <p className="mt-1 pl-1 text-xs text-warning-700 sm:pl-12">{problem}</p>}
        {key && isPreviewModelPreset(key) && <p className="text-xs text-warning-700">暂不可用</p>}
      </li>
    })}</ol>
    {nodes.length < 4 && selected && value.modelPreset !== 'locateanything-3b' && <div className="rounded-panel border border-dashed border-line bg-page p-3">
      <div className="flex flex-wrap gap-2"><select aria-label="待添加模型" value={selected} onChange={e => setChoice(e.target.value as AiModelPresetKey)} className="min-h-11 min-w-0 flex-1 rounded-base border border-line bg-surface px-3 text-sm">
        {modelPresetGroups(available).map(group => <optgroup key={group.id} label={group.label}>{group.keys.map(k => <option key={k} value={k}>{modelPresetOptionLabel(k)}</option>)}</optgroup>)}
      </select><button type="button" disabled={remaining < 1} className="min-h-11 rounded-base bg-primary px-4 text-sm text-white disabled:opacity-40" onClick={() => {
        const built = buildModelAndPreprocess(selected, { ...value, modelPreset: selected, prompts: [{ description: '', label_id: 'target', label_name: '' }] })
        const id = 'model-' + Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(16).padStart(8, '0')).join('')
        update([...nodes, { id, ...built, postprocess: { conf_threshold: .25, iou_threshold: .45, max_detections: Math.min(300, remaining) } }])
        setAnnouncement(isOpenVocabularyPreset(selected) ? '模型已添加，请点击配置填写识别目标' : '模型已添加，使用默认参数')
      }}>添加模型</button></div>
      {remaining < 1 && <p role="status" className="mt-2 text-xs text-warning-700">检测数总额度已用完，请先在已有模型的配置中降低最大检测数。</p>}
    </div>}
    <details className="rounded-base border border-line px-3 text-xs text-ink-subtle">
      <summary className="min-h-11 cursor-pointer py-3">模型组合与高级添加选项</summary>
      <div className="space-y-2 pb-3 leading-5">
        <p>同一用途默认只选一个模型，可在“配置”中更换档位。相同类别采用排在前面的模型结果，不同类别合并显示；拖动或箭头调整优先顺序。</p>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={allowSameCapability} onChange={e => setAllowSameCapability(e.target.checked)} />高级：允许同类多模型</label>
        {allowSameCapability && <p>同类多模型增加算力消耗；关闭此选项不会移除已有模型。</p>}
        <p>最大检测数合计不超过1000；新模型按剩余额度分配，已有模型的参数不变。移除模型或更换类别后，请检查已有计数器和告警触发器。</p>
        <p>{MODEL_PREVIEW_NOTICE}</p>
      </div>
    </details>
    {(blocked || error) && <p role="alert" className="text-sm text-danger">{blocked ?? error}</p>}
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    {editedNode && <ModelParametersDialog key={editedNode.id} node={editedNode} others={nodes.filter(n => n.id !== editing)} allowSameCapability={allowSameCapability} onApply={applyModel} onClose={() => setEditing(null)} />}
  </section>
}
