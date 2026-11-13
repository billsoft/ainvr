import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FlaskConical, X } from 'lucide-react'
import { useDiscardConfirmation } from '@/components/modals/useDiscardConfirmation'
import type { AlarmSource } from '@/api/alarmTriggerService'
import type { TriggerDefinitionInput } from '@/features/alarmDefinitions'
import { defaultTriggerReview } from '@/features/triggerDefaults'
import { regionCondition, sceneLabels } from './regionTrigger'
import {
  createPreviewDraft, draftError, initialSimulation, previewSummary,
  sceneTemplates, simulateObservation,
  type ObservationQuality, type PreviewDraft, type PreviewScene,
} from './triggerPreviewModel'

const field = 'form-input mt-1.5 min-h-11 w-full'
const secondary = 'btn-secondary !min-h-11 min-w-11'
const phases = { idle: '尚未模拟', normal: '条件不满足', pending: '等待持续条件', active: '候选事件持续中', recovering: '等待恢复条件', unknown: '未知 · 观测不可用', observation: '仅试验观测' }

/** Which model a scene needs, and what an operator should know before relying on it. */
const sceneNeeds: Partial<Record<PreviewScene, string>> = { helmet: '安全帽检测 · 人脸方案', fire: '烟雾 / 明火检测', fall: '人体姿态', understaffed: '通用目标检测' }
const sceneNotes: Partial<Record<PreviewScene, string>> = {
  helmet: '只在明确识别到“未戴安全帽”时告警；看不清头部时不会告警。请确认摄像机能看清人员面部和头部。',
  fire: '同一区域内持续出现的烟雾或明火只产生一条告警。反光、灯光和水汽可能造成误报，请结合画面确认。',
  understaffed: '人数是画面中当前识别到的人数，被完全遮挡的人不会计入；断流或识别暂停不会当作无人。',
  fall: '根据人体关节点判断是否持续呈倒地姿态，无法区分跌倒和主动躺下；关节点看不清时不会告警。试用功能。',
}
export function CapabilitySceneLauncher({ sources, disabled, onCreate }: { sources: AlarmSource[]; disabled?: boolean; onCreate: (prefill: Partial<TriggerDefinitionInput>) => void }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className={secondary} disabled={disabled} onClick={() => setOpen(true)}><FlaskConical size={16} aria-hidden="true" />新建场景</button>
    {open && <PreviewDialog mode="create" sources={sources} initial={createPreviewDraft('understaffed')} onClose={() => setOpen(false)} onKeep={() => {}} onCreate={prefill => { setOpen(false); onCreate(prefill) }} />}
    {import.meta.env.DEV && <details className="text-xs text-ink-subtle"><summary className="flex min-h-11 cursor-pointer items-center">开发预览</summary><CapabilityTriggerPreview disabled={disabled} /></details>}
  </>
}

/** Lives only for this page mount; intentionally has no API/storage dependency. */
export function CapabilityTriggerPreview({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [retained, setRetained] = useState<PreviewDraft | null>(null)
  const discard = useDiscardConfirmation()
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" className={secondary} disabled={disabled} onClick={() => setOpen(true)}>
      <FlaskConical size={16} aria-hidden="true" />{retained ? '编辑场景草稿' : '新建场景'} · 设计预览
    </button>
    {retained && <>
      <span role="status" className="text-xs text-amber-800">本次内存草稿 · 未启用</span>
      <button type="button" className={secondary} disabled={disabled} onClick={() => discard.requestDiscard(true, '仅清除本次页面内存中的场景草稿，不影响任何真实触发器。', () => setRetained(null))}>清除草稿</button>
    </>}
    {open && <PreviewDialog initial={retained ?? createPreviewDraft()} onClose={() => setOpen(false)} onKeep={draft => { setRetained({ ...draft }); setOpen(false) }} />}
    {discard.dialog}
  </div>
}

function PreviewDialog({ initial, onClose, onKeep, mode = 'design', sources = [], onCreate }: { initial: PreviewDraft; onClose: () => void; onKeep: (draft: PreviewDraft) => void; mode?: 'design' | 'create'; sources?: AlarmSource[]; onCreate?: (prefill: Partial<TriggerDefinitionInput>) => void }) {
  const [draft, setDraft] = useState<PreviewDraft>(() => ({ ...initial }))
  const [simulation, setSimulation] = useState(initialSimulation)
  const [quality, setQuality] = useState<ObservationQuality>('valid')
  const [candidate, setCandidate] = useState(true)
  const [people, setPeople] = useState('0')
  const [interval, setInterval] = useState('1')
  const [sourceId, setSourceId] = useState('')
  const title = useId(), panel = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const baseline = useRef(JSON.stringify(initial))
  const discard = useDiscardConfirmation()
  const close = () => discard.requestDiscard(JSON.stringify(draft) !== baseline.current || sourceId !== '',
    mode === 'create' ? '放弃本次场景设置？尚未保存触发器。' : '放弃本窗口尚未保留的修改？此前保留的内存草稿不受影响；模拟结果随窗口关闭清除。', onClose)
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close })
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    heading.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (!panel.current || stack[stack.length - 1] !== panel.current) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current()
      } else if (event.key === 'Tab') {
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'))
        const first = controls[0], last = controls.at(-1)
        if (!panel.current.contains(document.activeElement) || document.activeElement === heading.current) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const patch = (change: Partial<PreviewDraft>) => {
    setDraft(value => ({ ...value, ...change })); setSimulation(initialSimulation())
  }
  const chooseScene = (scene: PreviewScene) => {
    if (scene === draft.scene) return
    setDraft(createPreviewDraft(scene)); setSimulation(initialSimulation())
    setQuality('valid'); setCandidate(true); setPeople('0'); setInterval('1'); setSourceId('')
  }
  const template = sceneTemplates.find(item => item.id === draft.scene)!
  const problem = draftError(draft)
  const candidates = sources.filter(source => sceneLabels(draft, source).length)
  const selectedSource = candidates.find(source => source.channel_id === sourceId)
  const submit = () => {
    if (mode === 'design') { onKeep(draft); return }
    const policy = regionCondition(draft)
    if (!selectedSource || !policy || problem) return
    onCreate?.({ name: template.help, behavior: 'appearance', duration_ms: 0, region_state: policy,
      target_model: selectedSource.target_model, labels: sceneLabels(draft, selectedSource).map(label => ({ label_id: label.label_id, name: label.name, ...(selectedSource.target_model?.mode === 'open' ? { description: label.description } : {}) })),
      alarm_enabled: true, state: 'draft', review: { ...defaultTriggerReview(), enabled: false } })
  }
  const intervalMs = Math.round(Number(interval) * 1000)
  const observationError = !interval.trim() || !Number.isInteger(intervalMs) || Math.abs(Number(interval) * 1000 - intervalMs) > 1e-7 || intervalMs < 100 || intervalMs > 3600000
    ? '模拟覆盖时间须为 0.1–3600 秒，最多三位小数。'
    : quality === 'valid' && draft.scene === 'understaffed' && (!people.trim() || !Number.isInteger(Number(people)) || Number(people) < 0 || Number(people) > 1000)
      ? '有效人数须为 0–1000 的整数；没有观测请选观测无效。' : ''
  const candidateLabel = draft.scene === 'helmet' ? '模拟明确检出未戴安全帽候选'
    : draft.scene === 'fire' ? `模拟检出${draft.fireTarget === 'smoke' ? '烟雾' : draft.fireTarget === 'fire' ? '明火' : '烟雾或明火'}`
    : '模拟可见度与视角合格、关联明确的疑似倒地状态'
  return createPortal(<>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-5">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={title}
        className="alarm-workspace relative flex max-h-[calc(100dvh-1rem)] w-full max-w-[960px] flex-col rounded-panel bg-surface shadow-modal">
        <button type="button" aria-label="关闭" onClick={close} className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover"><X size={18} aria-hidden="true" /></button>
        <header className="border-b border-line px-4 py-4 pr-16 sm:px-6 sm:pr-16">
          <h2 ref={heading} id={title} tabIndex={-1} className="text-base font-semibold outline-none">{mode === 'create' ? '新建场景' : '新建场景 · 设计预览'}</h2>
          <p className="mt-1 text-sm text-ink-subtle">{mode === 'create' ? '选一个常用场景和识别通道，下一步确认条件后保存。' : '选择业务条件，预演预期行为；区域仍在原实时监看布防中绘制。'}</p>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <section aria-label={mode === 'create' ? '场景启用步骤' : '设计预览边界'} className="rounded-base border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>{mode === 'create' ? '保存后还需两步才会告警' : '设计预览 · 未接入真实规则 · 未启用'}</strong>
            <p className="mt-1">{mode === 'create' ? '① 在实时监看的布防中把它绑定到热区；② 回到告警触发列表启用。建议先观察一段时间再正式使用。' : '仅创建本次页面内存草稿；刷新或离开页面即丢失。不请求真实能力、不调用保存接口、不写入存储、不生成告警。'}</p>
            {mode === 'design' && <p className="mt-1">阈值为起始建议，需现场验证；缺少实际标签或已验证能力时不能继续创建。</p>}
          </section>
          <p className="text-xs text-ink-subtle">{mode === 'create' ? '切换场景会重置下方条件。' : '切换模板会重置示例条件与模拟。'}</p>
          <div role="group" aria-label="场景模板" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sceneTemplates.filter(item => mode === 'design' || item.id !== 'pose').map(item => <button key={item.id} type="button" aria-pressed={draft.scene === item.id} onClick={() => chooseScene(item.id)}
              className={`${secondary} flex-col items-start whitespace-normal p-3 text-left aria-pressed:border-primary aria-pressed:bg-primary-50 aria-pressed:text-primary`}>
              <strong>{mode === 'create' && item.id === 'understaffed' ? '区域人数' : item.name}</strong><span className="text-xs font-normal">{mode === 'create' && item.id === 'understaffed' ? '人数不足或无人值守' : item.help}</span>
            </button>)}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="场景条件" className="space-y-3 rounded-panel border border-line p-4">
              <h3 className="text-sm font-semibold">{mode === 'create' ? '场景条件' : '条件 · 仅供预演'}</h3>
              {mode === 'create' && <>
                <label className="block text-sm">识别通道<select aria-label="识别通道" className={field} value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">请选择可用通道</option>{candidates.map(source => <option key={source.channel_id} value={source.channel_id}>{source.channel_name}</option>)}</select></label>
                {selectedSource ? <p className="text-sm">识别目标：{sceneLabels(draft, selectedSource).map(label => label.name).join('、')}</p> : <p role="status" className="text-sm text-amber-800">{candidates.length ? '请选择由哪一路 AI 通道识别。' : draft.scene === 'pose' ? '姿态试验只观察，不创建告警规则。' : <>还没有 AI 通道能识别这一场景。请先到 <a className="text-primary underline" href="/ai-channels">AI 通道</a> 添加「{sceneNeeds[draft.scene] ?? '对应模型'}」{draft.scene === 'understaffed' ? '并开启目标跟踪。' : '并确认模型已运行。'}</>}</p>}
              </>}
              {draft.scene === 'fire' && <label className="block text-sm">告警对象<select aria-label="告警对象" className={field} value={draft.fireTarget} onChange={event => patch({ fireTarget: event.target.value as PreviewDraft['fireTarget'] })}>
                <option value="either">烟雾或明火</option><option value="smoke">烟雾</option><option value="fire">明火</option>
              </select></label>}
              {draft.scene === 'understaffed' && <label className="block text-sm">人数下限（人）<input className={field} type="number" min="1" max="1000" step="1" value={draft.minimumPeople} onChange={event => patch({ minimumPeople: event.target.value })} /></label>}
              {draft.scene !== 'pose' ? <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">持续多久后告警（秒）<input className={field} type="number" min="0.1" max="3600" step="0.001" value={draft.durationSeconds} onChange={event => patch({ durationSeconds: event.target.value })} /></label>
                <label className="block text-sm">恢复多久后结束（秒）<input className={field} type="number" min="0.1" max="3600" step="0.001" value={draft.recoverySeconds} onChange={event => patch({ recoverySeconds: event.target.value })} /></label>
              </div> : <p className="text-sm text-ink-subtle">本模板不配置告警阈值或持续触发，只核对姿态观测是否可用。</p>}
              {mode === 'design' && <p className="text-sm leading-6 text-ink-subtle">{template.caution}</p>}
              {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
            </section>
            <section aria-label="摘要与依赖" className="space-y-3 rounded-panel border border-line bg-surface-page p-4">
              <h3 className="text-sm font-semibold">{mode === 'create' ? '将会这样告警' : '自然语言摘要'}</h3>
              <p className="text-sm leading-6">{previewSummary(draft)}</p>
              <details open={mode === 'design'}><summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{mode === 'create' ? '适用范围与注意事项' : '依赖能力 · 未查询设备 / 待验证'}</summary>
                {mode === 'design' && <ul className="list-disc space-y-1 pl-5 text-sm text-ink-subtle">{template.dependencies.map(item => <li key={item}>{item}</li>)}</ul>}
                <p className="mt-2 text-xs leading-5 text-ink-subtle">{mode === 'create' ? sceneNotes[draft.scene] ?? template.caution : template.caution}</p>
                <p className="mt-2 text-xs text-ink-subtle">这类告警由人工审核确认；具体区域在实时监看的布防中设置。</p>
              </details>
            </section>
          </div>
          {mode === 'design' && <section aria-label="观测模拟" className="space-y-3 rounded-panel border border-line p-4">
            <div><h3 className="text-sm font-semibold">观测模拟 · 不读取视频</h3><p className="mt-1 text-xs text-ink-subtle">一次操作代表所填秒数的连续覆盖区间；无效区间不计时。更改场景条件会清空模拟。缺测采用保守的重新累计示意，真实宽限策略待后端验收。</p></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-sm">观测质量<select aria-label="观测质量" className={field} value={quality} onChange={event => setQuality(event.target.value as ObservationQuality)}>
                <option value="valid">有效观测（模拟）</option><option value="unavailable">观测无效 / 断流 / 未运行</option><option value="stale">观测过期 / 连续性中断</option><option value="ambiguous">质量不足 / 语义或归属不明</option>
              </select></label>
              <label className="block text-sm">本次模拟覆盖（秒）<input className={field} type="number" min="0.1" max="3600" step="0.001" value={interval} onChange={event => setInterval(event.target.value)} /></label>
              {draft.scene === 'understaffed' && <label className="block text-sm">模拟区域人数（人）<input className={field} type="number" min="0" max="1000" step="1" disabled={quality !== 'valid'} value={quality === 'valid' ? people : ''} placeholder="未知，不按 0 处理" onChange={event => setPeople(event.target.value)} /></label>}
            </div>
            {draft.scene !== 'understaffed' && draft.scene !== 'pose' && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={candidate} disabled={quality !== 'valid'} onChange={event => setCandidate(event.target.checked)} />{candidateLabel}（取消勾选模拟条件不满足）</label>}
            {quality !== 'valid' && <p className="text-sm text-amber-800">本区间状态为未知（unknown），忽略人数与条件值；不等同于正常、无人或风险解除。</p>}
            {observationError && <p role="alert" className="text-sm text-danger">{observationError}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary !min-h-11 min-w-11" disabled={!!problem || !!observationError} onClick={() => setSimulation(previous => simulateObservation(previous, draft, { quality, intervalMs, candidate, people: quality === 'valid' && people.trim() ? Number(people) : null }))}>模拟此段观测</button>
              <button type="button" className={secondary} onClick={() => setSimulation(initialSimulation())}>重置模拟</button>
            </div>
            <div role="status" aria-label="模拟结果" className="space-y-1 rounded-base bg-surface-page p-3 text-sm">
              <strong>预期：{phases[simulation.phase]}</strong><p>{simulation.detail}</p>
              <p className="text-ink-subtle">有效持续 {simulation.pendingMs / 1000} 秒 · 有效恢复 {simulation.recoveryMs / 1000} 秒 · 模拟候选事件 {simulation.episodes} 次</p>
              <p className="text-xs text-ink-subtle">以上仅为模拟结果；真实规则未启用。</p>
            </div>
          </section>}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
          <p className="mr-auto text-xs text-ink-subtle">{mode === 'create' ? '下一步可继续修改，保存前不会生效。' : '内存草稿不进入真实触发器列表。'}</p>
          <button type="button" className={secondary} onClick={close}>取消</button>
          <button type="button" className="btn-primary !min-h-11 min-w-11" disabled={!!problem || (mode === 'create' && !selectedSource)} onClick={submit}>{mode === 'create' ? '下一步' : '保留本次草稿'}</button>
        </footer>
      </div>
    </div>
    {discard.dialog}
  </>, document.fullscreenElement ?? document.body)
}
