export const MONITOR_LAYOUTS = ['2x2', '3x2', '4x2', '5x2', '4x4', '8x4'] as const
export type MonitorLayout = typeof MONITOR_LAYOUTS[number]
export const LAYOUT_CAPACITY: Record<MonitorLayout, number> = {
  '2x2': 4, '3x2': 6, '4x2': 8, '5x2': 10, '4x4': 16, '8x4': 32,
}
export const SOFT_LIMIT = 6
export const HARD_LIMIT = 9

export function automaticLayout(count: number): MonitorLayout {
  return MONITOR_LAYOUTS.find(l => LAYOUT_CAPACITY[l] >= count) ?? '8x4'
}

export function gridClassFor(layout: MonitorLayout): string {
  return {
    '2x2': 'grid-cols-2 grid-rows-2',
    '3x2': 'grid-cols-2 grid-rows-3 xl:grid-cols-3 xl:grid-rows-2',
    '4x2': 'grid-cols-2 grid-rows-4 xl:grid-cols-4 xl:grid-rows-2',
    '5x2': 'grid-cols-2 grid-rows-5 xl:grid-cols-5 xl:grid-rows-2',
    '4x4': 'grid-cols-4 grid-rows-4',
    '8x4': 'grid-cols-4 grid-rows-8 xl:grid-cols-8 xl:grid-rows-4',
  }[layout]
}

/** Drop unused trailing pages without collapsing deliberately empty positions. */
export function fitSlots(slots: (string | null)[], layout: MonitorLayout) {
  let last = slots.length - 1
  while (last >= 0 && !slots[last]) last--
  const capacity = LAYOUT_CAPACITY[layout]
  const length = Math.max(capacity, Math.ceil((last + 1) / capacity) * capacity)
  return Array.from({ length }, (_, i) => slots[i] ?? null)
}
