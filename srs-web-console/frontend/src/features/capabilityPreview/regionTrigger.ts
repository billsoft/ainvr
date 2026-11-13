import type { AlarmSource } from '@/api/alarmTriggerService'
import type { RegionStateCondition, TriggerDefinitionInput } from '@/features/alarmDefinitions'
import { triggerTargetsMatch } from '@/features/triggerTargets'
import type { PreviewDraft, PreviewScene } from './triggerPreviewModel'

export function regionCondition(draft: PreviewDraft): RegionStateCondition | null {
  if (draft.scene === 'pose') return null
  const threshold = draft.scene === 'understaffed' ? Number(draft.minimumPeople) : 1
  return { operator: draft.scene === 'understaffed' ? 'count_below' : 'presence', threshold,
    duration_ms: Math.round(Number(draft.durationSeconds) * 1000), recovery_ms: Math.round(Number(draft.recoverySeconds) * 1000),
    event_kind: draft.scene === 'understaffed' ? threshold === 1 ? 'region_absence' : 'region_count'
      : draft.scene === 'helmet' ? 'helmet_violation' : draft.scene === 'fire' ? 'fire_smoke' : 'suspected_down' }
}
export function regionScene(condition: RegionStateCondition): PreviewScene {
  return condition.event_kind === 'helmet_violation' ? 'helmet' : condition.event_kind === 'fire_smoke' ? 'fire' : condition.event_kind === 'suspected_down' ? 'fall' : 'understaffed'
}
export function sceneLabels(draft: PreviewDraft, source: AlarmSource) {
  const condition = regionCondition(draft)
  if (!condition) return []
  if (condition.operator !== 'presence') return source.tracking_available
    ? source.labels.filter(label => ['person', '人', '人员'].includes(label.name.toLowerCase())) : []
  const capability = source.region_capabilities?.find(item => item.ready && item.event_kind === condition.event_kind)
  if (!capability || (!source.tracking_available && !source.detection_available)) return []
  return source.labels.filter(label => capability.label_ids.includes(label.label_id) &&
    (draft.scene !== 'fire' || draft.fireTarget === 'either' ||
      (draft.fireTarget === 'smoke' ? ['smoke', '烟雾'] : ['fire', '明火']).includes(label.name.toLowerCase())))
}
export function regionSourceError(value: Pick<TriggerDefinitionInput, 'labels' | 'target_model' | 'region_state'>, sources: AlarmSource[]): string {
  const policy = value.region_state
  if (!policy) return ''
  const available = sources.some(source => triggerTargetsMatch(value, source) && value.labels.length > 0 &&
    (policy.operator === 'presence'
      ? (source.tracking_available || source.detection_available) && source.region_capabilities?.some(cap => cap.ready && cap.event_kind === policy.event_kind && value.labels.every(label => cap.label_ids.includes(label.label_id)))
      : source.tracking_available))
  return available ? '' : `还没有 AI 通道能识别这一场景所需的目标，请先到“AI 通道”添加对应模型${policy.operator === 'presence' ? '并确认模型已运行' : '并开启目标跟踪'}。`
}
export function regionConditionError(policy: RegionStateCondition): string {
  if (!Number.isInteger(policy.threshold) || policy.threshold < 1 || policy.threshold > 4096 ||
    !Number.isInteger(policy.duration_ms) || policy.duration_ms < 100 || policy.duration_ms > 3600000 ||
    !Number.isInteger(policy.recovery_ms) || policy.recovery_ms < 100 || policy.recovery_ms > 3600000) return '人数须为 1–4096 整数；持续和恢复须为 0.1–3600 秒，最多三位小数。'
  return ''
}
export function regionSummary(policy: RegionStateCondition): string {
  const claim = policy.operator === 'count_below' ? `区域内人数少于 ${policy.threshold} 人${policy.threshold === 1 ? '（无人）' : ''}`
    : policy.operator === 'count_at_least' ? `区域内人数不少于 ${policy.threshold} 人`
      : policy.event_kind === 'fire_smoke' ? '区域内出现烟雾或明火' : policy.event_kind === 'helmet_violation' ? '区域内有人未戴安全帽' : '区域内有人疑似倒地'
  return `${claim}，持续 ${policy.duration_ms / 1000} 秒后告警；恢复正常 ${policy.recovery_ms / 1000} 秒后结束`
}
