import { useState } from 'react'
import type { AlarmSource } from '@/api/alarmTriggerService'
import type { RegionStateCondition, TriggerDefinitionInput } from '@/features/alarmDefinitions'
import { triggerTargetsMatch } from '@/features/triggerTargets'
import { createPreviewDraft } from './triggerPreviewModel'
import { regionConditionError, regionScene, regionSourceError, regionSummary, sceneLabels } from './regionTrigger'

const field = 'form-input mt-1.5 min-h-11 w-full'
export function RegionTargetPicker({ value, sources, onChange }: { value: TriggerDefinitionInput; sources: AlarmSource[]; onChange: (patch: Partial<TriggerDefinitionInput>) => void }) {
  const [sourceId, setSourceId] = useState(() => sources.find(source => triggerTargetsMatch(value, source))?.channel_id ?? '')
  const draft = createPreviewDraft(regionScene(value.region_state!))
  const candidates = sources.filter(source => sceneLabels(draft, source).length)
  return <section className="space-y-3">
    <p className="text-sm text-ink-subtle">选择由哪一路 AI 通道识别；具体区域稍后在实时监看的布防中绑定。</p>
    <label className="block text-sm">识别通道<select aria-label="识别通道" className={field} value={sourceId} onChange={event => {
      setSourceId(event.target.value)
      const source = candidates.find(item => item.channel_id === event.target.value)
      if (source) onChange({ target_model: source.target_model, labels: sceneLabels(draft, source).map(label => ({ label_id: label.label_id, name: label.name, ...(source.target_model?.mode === 'open' ? { description: label.description } : {}) })) })
    }}><option value="">请选择可用通道</option>{candidates.map(source => <option key={source.channel_id} value={source.channel_id}>{source.channel_name}</option>)}</select></label>
    <p className="text-sm">识别目标：{value.labels.map(label => label.name).join('、') || '未选择'}</p>
    {regionSourceError(value, sources) && <p role="alert" className="text-sm text-warning-700">{regionSourceError(value, sources)}</p>}
  </section>
}
export function RegionConditionFields({ value, onChange }: { value: RegionStateCondition; onChange: (value: RegionStateCondition) => void }) {
  const count = value.operator !== 'presence'
  const patch = (change: Partial<RegionStateCondition>) => {
    const next = { ...value, ...change }
    if (next.operator !== 'presence') next.event_kind = next.operator === 'count_below' && next.threshold === 1 ? 'region_absence' : 'region_count'
    onChange(next)
  }
  return <section aria-label="区域状态条件" className="space-y-3 rounded-panel border border-line p-4">
    <h3 className="text-sm font-semibold">告警条件</h3>
    {count && <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">人数条件<select aria-label="人数条件" className={field} value={value.operator} onChange={event => patch({ operator: event.target.value as RegionStateCondition['operator'] })}><option value="count_below">少于</option><option value="count_at_least">不少于</option></select></label>
      <label className="block text-sm">人数阈值（人）<input className={field} type="number" min={1} max={4096} step={1} value={value.threshold} onChange={event => patch({ threshold: Number(event.target.value) })} /></label>
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">持续多久后告警（秒）<input className={field} type="number" min="0.1" max="3600" step="0.001" value={value.duration_ms / 1000} onChange={event => patch({ duration_ms: Math.round(Number(event.target.value) * 1000) })} /></label>
      <label className="block text-sm">恢复多久后结束（秒）<input className={field} type="number" min="0.1" max="3600" step="0.001" value={value.recovery_ms / 1000} onChange={event => patch({ recovery_ms: Math.round(Number(event.target.value) * 1000) })} /></label>
    </div>
    <p className="rounded-base bg-primary-50 p-3 text-sm">{regionSummary(value)}。</p>
    <p className="text-xs text-ink-subtle">这类告警由人工审核确认；画面中断或看不清的时段不计时。</p>
    <details><summary className="flex min-h-11 cursor-pointer items-center text-sm">计时与人数怎么算</summary><p className="text-xs leading-5 text-ink-subtle">相邻两次识别间隔超过 {(value.max_gap_ms ?? 1500) / 1000} 秒时重新计时。断流、识别暂停或目标看不清时不会当作无人。人数是画面中当前识别到的人数，被完全遮挡的人不会计入，请先确认摄像机能看全布防区域。</p></details>
    {regionConditionError(value) && <p role="alert" className="text-sm text-danger">{regionConditionError(value)}</p>}
  </section>
}
