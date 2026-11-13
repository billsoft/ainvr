/** Business categories are independent of spatial trigger stages. */
export const alarmBusinessKinds = {
  spatial: '空间行为',
  helmet_violation: '未戴安全帽',
  fire_smoke: '烟雾 / 明火',
  region_count: '区域人数异常',
  region_absence: '区域无人',
  vehicle_dwell: '区域车辆停留',
  suspected_down: '疑似倒地',
  face_watchlist: '人脸关注名单',
  vehicle_watchlist: '车辆关注名单',
} as const
export type AlarmBusinessKind = keyof typeof alarmBusinessKinds
export const isAlarmBusinessKind = (value: unknown): value is AlarmBusinessKind =>
  typeof value === 'string' && Object.hasOwn(alarmBusinessKinds, value)
export function alarmBusinessName(value: string): string {
  return isAlarmBusinessKind(value) ? alarmBusinessKinds[value] : value
}
export function alarmBusinessKindOf(value: unknown): string {
  if (!value || typeof value !== 'object') return 'spatial'
  const event = value as { event_kind?: string; analysis_evidence?: { vehicle?: { reason?: string } } }
  return event.event_kind ?? (event.analysis_evidence?.vehicle?.reason === 'watchlist_match' ? 'vehicle_watchlist' : 'spatial')
}
export function alarmBusinessTitle(value: unknown, fallback: string): string {
  const kind = alarmBusinessKindOf(value)
  return kind === 'spatial' ? fallback : alarmBusinessName(kind)
}
