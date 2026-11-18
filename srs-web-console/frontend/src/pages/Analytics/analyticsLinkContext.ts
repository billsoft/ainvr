import { createContext, useContext } from 'react'
import type { Counter, CounterResult } from '@/api/flowService'

/** One statistic, or the total of every statistic sharing one measure (see scopeKey). */
export type StatChoice = { kind: 'counter'; id: string } | { kind: 'total'; key: string }

export interface ChoiceSummary {
  /** Peak slot label (e.g. 08:00–09:00) and its count; `complete` false means only a recorded peak. */
  peak: { label: string; value: number; complete: boolean } | null
  /** In minus out, both directions only. */
  net: number | null
  perHour: number | null
  unit: string
  /** Comparison sentences per direction, only when both periods are fully covered. */
  change: { in: string | null; out: string | null }
  /** The period trend, drawn small on the chosen card. */
  trend?: { bucket: 'hour' | 'day'; slots: { from: string; to: string }[]; label: string; complete: boolean[]; reference: TrendSeries | null; series: TrendSeries[] }
}
type TrendSeries = { name: string; color: string; values: (number | null)[] }
/** What the analysis page lets the statistics column drive: which statistic feeds the numbers. */
export interface CounterSelection {
  ids: string[]
  choice: StatChoice | null
  choose: (choice: StatChoice) => void
  /** The analysis's own statistics (with every location they ever counted at) and ticked locations. */
  counters: Counter[]
  bindings: string[]
  toggleBinding: (bindingId: string) => void
  /** Replace the ticked locations at once (only one, or all again). */
  setBindings: (bindingIds: string[]) => void
  /** Numbers for the chosen statistic over the analysis's time range. */
  items: CounterResult[] | null
  /** Period totals for every statistic, so each card shows its numbers before it is chosen. */
  totals: CounterResult[] | null
  /** The comparison period's totals for every statistic (null when comparison is off or unavailable). */
  previousTotals: CounterResult[] | null
  /** Comparison period name, e.g. 昨天同时段. */
  compareLabel: string | null
  /** Overview figures of the current choice, shown on its card. */
  summary: ChoiceSummary | null
  /** Open the passage records of one trend slot (one statistic) or show its reading (a total). */
  openSlot?: (index: number) => void
  range: { from: string; to: string; label: string }
  openRecords: (counterId: string, bindingId: string, output: 'in' | 'out') => void
}
export interface AnalyticsLink {
  /** The column changed something (create/edit/pause/delete): the analysis reloads its statistics. */
  reload: number
  bump: () => void
  selection: CounterSelection | null
  publish: (selection: CounterSelection | null) => void
  /** The statistics column is open beside the analysis. */
  columnOpen: boolean
}
export const AnalyticsLinkContext = createContext<AnalyticsLink>({ reload: 0, bump: () => undefined, selection: null, publish: () => undefined, columnOpen: false })
export const useAnalyticsLink = () => useContext(AnalyticsLinkContext)
