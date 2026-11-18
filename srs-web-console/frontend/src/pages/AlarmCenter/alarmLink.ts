import { createContext, useContext } from 'react'
import type { AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
import type { AlarmLocation } from '@/api/alarmEventService'
import { rangeOf, validateCustomRange, type CustomRange, type Preset } from '@/pages/Flow/flowRange'

export const alarmPresets = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const

/**
 * The alarm page's period: preset `range`, or a custom `afrom`/`ato` (end exclusive). The custom keys are not `from`/`to`
 * on purpose: bare `from`/`to` on /alarms mean a fixed list scope from a statistics link.
 */
export function alarmPeriod(params: URLSearchParams, now: Date) {
  const preset = (alarmPresets.find(([key]) => key === params.get('range'))?.[0] ?? 'today') as Preset
  const rawFrom = params.get('afrom'), rawTo = params.get('ato')
  const custom: CustomRange | null = rawFrom && rawTo ? { from: new Date(rawFrom), to: new Date(Date.parse(rawTo) - 1000) } : null
  const rangeError = rawFrom || rawTo ? !custom || validateCustomRange(custom.from, custom.to) ? '链接中的时间范围无效，请重新选择时间。' : '' : ''
  const range = rangeOf(custom && !rangeError ? 'custom' : preset, now, custom)
  return { preset, custom: rangeError ? null : custom, rangeError, range }
}

/** What the rules column and the alarm views share: which rule is in focus, and every rule's numbers for the period. */
export interface AlarmRuleLink {
  /** The chosen rule; null means every rule. */
  rule: string | null
  choose: (rule: string | null) => void
  /** The period the rule cards count, e.g. 今天. */
  periodLabel: string
  /** One query over the period without a rule filter, so every card has numbers. */
  counts: AlarmAnalyticsResult | null
  countsError: string
  /** The column is open beside the alarm views. */
  columnOpen: boolean
  /** A rule was created, edited, paused or archived, or alarms were reviewed: views reload their names and numbers. */
  reload: number
  bump: () => void
  /** The end of a preset period: one moment for the rules column and the analysis, so their numbers agree. */
  now: Date
  /** Count again up to this moment, everywhere on the page. */
  refresh: () => void
  /** The zones in focus (`alarm_locations`); null is every zone. Both halves and the rules column read and set this one choice. */
  locations: AlarmLocation[] | null
  setLocations: (locations: AlarmLocation[] | null) => void
}

/** Read `alarm_locations`; anything malformed is every zone. */
export function readAlarmLocations(raw: string | null): AlarmLocation[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100) return null
    const ok = parsed.every(z => z && typeof z === 'object' && typeof (z as AlarmLocation).channel_id === 'string' && typeof (z as AlarmLocation).zone_id === 'string')
    return ok ? parsed.map(z => ({ channel_id: (z as AlarmLocation).channel_id, zone_id: (z as AlarmLocation).zone_id })) : null
  } catch { return null }
}

/** Choosing a rule leaves the zones and any fixed list scope of the one before. */
export function chooseRuleSearch(old: URLSearchParams, rule: string | null): URLSearchParams {
  const p = new URLSearchParams(old)
  if (rule) p.set('rule', rule); else p.delete('rule')
  for (const key of ['analytics_scope', 'from', 'to', 'locations', 'alarm_locations', 'alarm_scope_origin']) p.delete(key)
  return p
}

/** The keys that make the alarm list's fixed scope; a drill-down replaces only these. */
const listScopeKeys = ['from', 'to', 'locations', 'status', 'analytics_scope']

/**
 * A drill-down link from the analysis (`/alarms?status=all&analytics_scope=…`) applied to the page in place. A zone (the
 * same question narrowed only to places) becomes the page's zone choice, so both halves follow it and the period keeps
 * moving; anything else (a time slot, a review state) scopes the list beside the analysis. The rule, the period and the
 * analysis filters stay. Null for any other link.
 */
export function drillSearch(old: URLSearchParams, href: string): URLSearchParams | null {
  const url = new URL(href, 'http://local')
  if (url.pathname !== '/alarms' || !url.searchParams.has('analytics_scope')) return null
  const next = new URLSearchParams(old)
  for (const key of [...listScopeKeys, 'view']) next.delete(key)
  let scope: Record<string, unknown> | null = null
  try { scope = JSON.parse(url.searchParams.get('analytics_scope')!) as Record<string, unknown> } catch { scope = null }
  const zoneOnly = scope && Array.isArray(scope.locations) && scope.locations.length > 0 &&
    Object.keys(scope).every(key => ['from', 'to', 'timezone', 'bucket', 'locations', 'trigger_id', 'event_kind', 'primary_type'].includes(key))
  if (zoneOnly) { next.set('alarm_locations', JSON.stringify(scope!.locations)); next.delete('alarm_scope_origin'); return next }
  for (const key of listScopeKeys) { const value = url.searchParams.get(key); if (value !== null) next.set(key, value) }
  return next
}
export const AlarmLinkContext = createContext<AlarmRuleLink | null>(null)
export const useAlarmLink = () => useContext(AlarmLinkContext)
