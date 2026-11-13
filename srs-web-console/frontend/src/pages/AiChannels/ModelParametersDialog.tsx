import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDiscardConfirmation } from '@/components/modals/useDiscardConfirmation'
import { availableModelPresetKeys, modelPresetGroups, modelPresetKey, modelPresetOptionLabel } from '@/features/modelCapabilities'
import { buildModelAndPreprocess, DEFAULT_WIZARD_VALUE, validateStep2, validateStep3, usesPromptSlots } from '@/features/aiChannelForm'
import { AI_MODEL_PRESETS, isYoloePreset, promptSlotLimit, type AiAnalysisNode, type AiModelPresetKey } from '@/types/aiChannel'
import { PromptLabelEditor } from './PromptLabelEditor'

const input = 'mt-2 min-h-11 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary'

export function modelParameterError(node: AiAnalysisNode): string | undefined {
  const post = node.postprocess
  if (!Number.isInteger(post.max_detections) || post.max_detections < 1 || post.max_detections > (node.model.adapter === 'yoloe_bpu' ? 300 : 1000))
    return '最大检测数超出支持范围，请输入有效整数。'
  if (node.model.adapter !== 'locateanything_bpu' && (!Number.isFinite(post.conf_threshold) || post.conf_threshold < .01 || post.conf_threshold > .95))
    return '置信度阈值必须在 0.01–0.95 之间。'
  const key = modelPresetKey(node.model)
  if (!key) return undefined // Untouched imported profiles are preserved by the existing submission contract.
  const form = { ...DEFAULT_WIZARD_VALUE, modelPreset: key, modelProfile: node,
    inferenceFps: key === 'locateanything-3b' ? 1 / 120 : 5,
    prompts: node.model.prompts ?? undefined, description: node.model.description,
    labelId: node.model.label_id, labelName: node.model.label_name,
    confThreshold: node.postprocess.conf_threshold, iouThreshold: node.postprocess.iou_threshold,
    maxDetections: node.postprocess.max_detections }
  return Object.values({ ...validateStep2(form), ...validateStep3(form) }).find(Boolean)
}

export function ModelParametersDialog({ node, others, allowSameCapability, onApply, onClose }: {
  node: AiAnalysisNode; others: AiAnalysisNode[]; allowSameCapability: boolean
  onApply: (node: AiAnalysisNode) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(node))
  const [error, setError] = useState<string>()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<() => void>(() => {})
  const discard = useDiscardConfirmation()
  const dirty = JSON.stringify(node) !== JSON.stringify(draft)
  const key = modelPresetKey(draft.model)
  const title = key ? AI_MODEL_PRESETS[key].displayName : draft.model.name
  const available = availableModelPresetKeys(others.map(n => n.model), allowSameCapability)
    .filter(k => k !== 'locateanything-3b' || others.length === 0)
  function requestClose() {
    discard.requestDiscard(dirty, '仅放弃这个模型尚未应用的参数，其他通道草稿保持不变。', onClose)
  }
  close.current = requestClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const openedPanel = panel.current
    panel.current?.querySelector<HTMLElement>('button')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (stack[stack.length - 1] !== panel.current) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current() }
      if (event.key === 'Tab') {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? [])
        const first = controls[0], last = controls[controls.length - 1]
        if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      // Nested ConfirmDialog cleanup runs after ours and can focus the parent
      // wizard's first button. Restore the opener after all modal cleanups.
      queueMicrotask(() => {
        if (!openedPanel?.isConnected && previous?.isConnected && !previous.matches(':disabled')) previous.focus()
      })
    }
  }, [])
  const change = (next: AiAnalysisNode) => { setDraft(next); setError(undefined) }
  function choose(preset: AiModelPresetKey) {
    const built = buildModelAndPreprocess(preset, { ...DEFAULT_WIZARD_VALUE, modelPreset: preset,
      prompts: draft.model.prompts ?? [{ description: '', label_id: 'target', label_name: '' }] })
    change({ ...draft, ...built, postprocess: { ...draft.postprocess,
      max_detections: Math.min(draft.postprocess.max_detections, isYoloePreset(preset) ? 300 : 1000) } })
  }
  function apply() {
    if (!dirty) { onClose(); return }
    const problem = modelParameterError(draft)
    if (problem) { setError(problem); return }
    if (draft.postprocess.max_detections + others.reduce((sum, n) => sum + n.postprocess.max_detections, 0) > 1000) {
      setError('所有模型的最大检测数合计不能超过 1000，请降低本模型的最大检测数。'); return
    }
    onApply(draft)
  }
  return createPortal(<>
    <div ref={panel} role="dialog" aria-modal="true" aria-label={`配置模型：${title}`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-2 sm:p-5">
      <div className="flex max-h-[96dvh] w-full max-w-[760px] flex-col rounded-panel bg-surface shadow-modal sm:max-h-[90dvh]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div className="min-w-0"><h3 className="text-base font-semibold text-ink">{title}</h3><p className="mt-1 text-xs text-ink-subtle">模型参数 · 应用后仍需保存整个通道</p></div>
          <button type="button" aria-label="关闭" onClick={requestClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-page"><X size={20} /></button>
        </header>
        <div className="min-h-0 space-y-5 overflow-y-auto p-4 sm:p-6">
          <label className="block text-sm font-medium text-ink">模型方案
            <select aria-label={`${title} 模型`} data-testid="wizard-model-select" value={key ?? ''} onChange={e => choose(e.target.value as AiModelPresetKey)} className={input}>
              {!key && <option value="" disabled>{draft.model.name}（现有配置）</option>}
              {key && !available.includes(key) && <option value={key}>{AI_MODEL_PRESETS[key].displayName}（现有配置）</option>}
              {modelPresetGroups(available).map(group => <optgroup key={group.id} label={group.label}>{group.keys.map(k => <option key={k} value={k}>{modelPresetOptionLabel(k)}</option>)}</optgroup>)}
            </select>
          </label>
          {key && <p className="text-xs leading-5 text-ink-subtle">{AI_MODEL_PRESETS[key].description}</p>}
          {key !== modelPresetKey(node.model) && (key === 'locateanything-3b' || node.model.adapter === 'locateanything_bpu') && <p role="status" className="rounded-base bg-warning-50 p-3 text-xs leading-5 text-warning-700">
            {key === 'locateanything-3b' ? '应用此慢速模型时，通道采集间隔会设为120秒；如已开启目标跟踪，仍需另行确认关闭跟踪。' : '切回帧级模型时，通道采样目标会设为5 FPS，之后可在通道运行设置中调整。'}取消不会改变这些设置。
          </p>}
          {key && usesPromptSlots(key) && <section className="space-y-2 rounded-base border border-line p-3">
            <h4 className="text-sm font-medium">识别目标</h4><p className="text-xs text-ink-subtle">填写要找的目标；标签用于后续检索、计数和告警。</p>
            <PromptLabelEditor rows={draft.model.prompts ?? []} limit={promptSlotLimit(key)} onChange={prompts => change({ ...draft, model: { ...draft.model, prompts } })} />
            {key === 'locateanything-3b' && <p className="text-xs leading-5 text-ink-subtle">请用简洁英文描述。标签越多识别越慢；当前仅允许单独使用，输出画面约延后95秒以匹配原帧，不提供置信度。</p>}
          </section>}
          <section className="grid grid-cols-1 gap-4 rounded-base bg-page p-4 sm:grid-cols-2" aria-label="模型检测参数">
            {key !== 'locateanything-3b' && <label className="text-sm text-ink">置信度阈值
              <input aria-label={`${draft.model.name} 检测置信度`} type="number" min={0.01} max={0.95} step={0.01} value={Number.isFinite(draft.postprocess.conf_threshold) ? draft.postprocess.conf_threshold : ''} className={input}
                onChange={e => change({ ...draft, postprocess: { ...draft.postprocess, conf_threshold: e.currentTarget.valueAsNumber } })} />
              <span className="mt-1 block text-xs text-ink-subtle">越高越严格，不代表准确率。</span>
            </label>}
            {key && AI_MODEL_PRESETS[key].needsIouThreshold && <label className="text-sm text-ink">IoU 阈值
              <input aria-label={`${draft.model.name} IoU 阈值`} type="number" min={0.1} max={0.9} step={0.01} value={Number.isFinite(draft.postprocess.iou_threshold) ? draft.postprocess.iou_threshold : ''} className={input}
                onChange={e => change({ ...draft, postprocess: { ...draft.postprocess, iou_threshold: e.currentTarget.valueAsNumber } })} />
            </label>}
            <label className="text-sm text-ink">最大检测数
              <input aria-label={`${draft.model.name} 最大检测数`} type="number" min={1} max={key && isYoloePreset(key) ? 300 : 1000} value={Number.isFinite(draft.postprocess.max_detections) ? draft.postprocess.max_detections : ''} className={input}
                onChange={e => change({ ...draft, postprocess: { ...draft.postprocess, max_detections: e.currentTarget.valueAsNumber } })} />
            </label>
          </section>
          {draft.model.adapter === 'plate_bpu' && <p className="text-xs leading-5 text-ink-subtle">自动检测、矫正和读牌。支持不超过8388608像素的输入，每帧最多为4个候选读牌；未读到不等于无牌。车辆通行仍由车辆计数器产生。</p>}
          <p className="text-xs leading-5 text-ink-subtle">更换模型或识别目标后，请检查使用这些类别的计数器和告警触发器。采样帧率在通道运行设置中统一调整。</p>
          {error && <p role="alert" className="rounded-base bg-danger/5 p-3 text-sm text-danger">{error}</p>}
        </div>
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-4 py-3 sm:px-6">
          <button type="button" onClick={requestClose} className="min-h-11 rounded-base border border-line px-4 text-sm">取消</button>
          <button type="button" onClick={apply} className="min-h-11 rounded-base bg-primary px-4 text-sm text-white">应用到通道草稿</button>
        </footer>
      </div>
    </div>
    {discard.dialog}
  </>, document.fullscreenElement ?? document.body)
}
