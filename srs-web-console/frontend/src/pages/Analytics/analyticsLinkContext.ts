import { createContext, useContext } from 'react'
import type { Counter, CounterResult } from '@/api/flowService'

/** What the analysis page lets the counter column drive: which counters feed the numbers. */
export interface CounterSelection {
  ids: string[]
  canSelect: (counterId: string) => boolean
  toggle: (counterId: string) => void
  /** The analysis's own counters (with every location they ever counted at) and ticked locations. */
  counters: Counter[]
  bindings: string[]
  toggleBinding: (bindingId: string) => void
  /** Numbers for the analysis's time range: one range, one query. */
  items: CounterResult[] | null
  range: { from: string; to: string; label: string }
  openRecords: (counterId: string, bindingId: string, output: 'in' | 'out') => void
}
export interface AnalyticsLink {
  /** Counter column changed something (create/edit/pause/delete): the analysis reloads its counters. */
  reload: number
  bump: () => void
  selection: CounterSelection | null
  publish: (selection: CounterSelection | null) => void
  /** The counter column is open beside the analysis. */
  columnOpen: boolean
}
export const AnalyticsLinkContext = createContext<AnalyticsLink>({ reload: 0, bump: () => undefined, selection: null, publish: () => undefined, columnOpen: false })
export const useAnalyticsLink = () => useContext(AnalyticsLinkContext)
