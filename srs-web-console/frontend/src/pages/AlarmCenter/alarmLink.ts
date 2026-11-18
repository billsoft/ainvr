import { createContext, useContext } from 'react'
import type { AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'
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
  /** A rule was created, edited, paused or archived: views reload their names and numbers. */
  reload: number
  bump: () => void
}
export const AlarmLinkContext = createContext<AlarmRuleLink | null>(null)
export const useAlarmLink = () => useContext(AlarmLinkContext)
