import type { TriggerDefinition } from './alarmDefinitions'
import type { AlarmSource } from '@/api/alarmTriggerService'
export function triggerAvailability(trigger: TriggerDefinition, sources: AlarmSource[]) {
 return (trigger.usages ?? []).map(usage => {
  const source = sources.find(item => item.channel_id === usage.processor_id)
  if (!source) return { ...usage, state: 'unknown' as const }
  const missing = trigger.labels.some(label => !source.labels.some(current =>
   current.label_id === label.label_id && (current.name || current.description || current.label_id) === label.name &&
   (label.description === undefined || label.description === current.description)))
  const unsupported = trigger.region_state?.operator === 'presence' && !source.region_capabilities?.some(cap =>
   cap.ready && cap.event_kind === trigger.region_state!.event_kind && trigger.labels.every(label => cap.label_ids.includes(label.label_id)))
  const changed = (usage.label_map_version && usage.label_map_version !== source.label_map_version) ||
   (usage.geometry_revision && usage.geometry_revision !== source.geometry_revision)
  return { ...usage, state: missing ? 'missing' as const : unsupported ? 'unsupported' as const : changed ? 'changed' as const : 'available' as const }
 })
}
