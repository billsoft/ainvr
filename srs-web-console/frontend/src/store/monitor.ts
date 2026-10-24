import { create } from 'zustand'
import { fitSlots, HARD_LIMIT, LAYOUT_CAPACITY, MONITOR_LAYOUTS, type MonitorLayout } from '@/utils/monitorLayout'

const STORAGE_KEY = 'ainvr-monitor-workspace-v1'
interface MonitorState {
  layout: MonitorLayout
  mode: 'auto' | 'manual'
  slots: (string | null)[]
  page: number
  initialized: boolean
  persistenceUnavailable: boolean
  hardLimit: number
  focusedChannelId: string | null
  selectedOutputs: Record<string, string>
  selectOutput: (id: string, output: string) => void
  initialize: (ids: string[]) => void
  arrange: (ids: string[]) => void
  setLayout: (layout: MonitorLayout) => void
  setPage: (page: number) => void
  setHardLimit: (n: number) => void
  add: (id: string) => boolean
  remove: (index: number) => void
  swap: (from: number, to: number) => void
  clear: () => void
  enterFocus: (id: string) => void
  exitFocus: () => void
  closeFocus: () => void
}

export function createMonitorStore(persist = false) {
  let saved: Partial<MonitorState> = {}
  let unavailable = false
  if (persist) {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (value?.layout === '1x1') value.layout = '2x2'
      if (value && MONITOR_LAYOUTS.includes(value.layout) && Array.isArray(value.slots) && value.slots.length <= 4096) {
        const seen = new Set<string>()
        const slots = value.slots.map((id: unknown) => {
          if (typeof id !== 'string' || !id || id.length > 512 || seen.has(id)) return null
          seen.add(id)
          return id
        })
        const selectedOutputs = Object.fromEntries(Object.entries(value.selectedOutputs ?? {}).filter(([id, output]) => seen.has(id) && typeof output === 'string' && output.length <= 512)) as Record<string, string>
        const fitted = fitSlots(slots, value.layout)
        const page = Number.isInteger(value.page) ? Math.max(0, Math.min(value.page, fitted.length / LAYOUT_CAPACITY[value.layout as MonitorLayout] - 1)) : 0
        const focusedChannelId = typeof value.focusedChannelId === 'string' && value.focusedChannelId.length <= 512 ? value.focusedChannelId : null
        saved = { layout: value.layout, mode: 'manual', slots: fitted, selectedOutputs, page, focusedChannelId, initialized: true }
      }
    } catch { unavailable = true }
  }
  const store = create<MonitorState>((set, get) => ({
    layout: '2x2', mode: 'manual', slots: fitSlots([], '2x2'), page: 0,
    initialized: false, persistenceUnavailable: unavailable, hardLimit: HARD_LIMIT,
    focusedChannelId: null, selectedOutputs: {}, ...saved,
    selectOutput(id, output) { set(s => ({ selectedOutputs: { ...s.selectedOutputs, [id]: output } })) },
    initialize(ids) { if (!get().initialized) get().arrange(ids) },
    arrange(ids) {
      const unique = [...new Set(ids)].slice(0, 4096)
      const layout = get().layout
      set({ layout, slots: fitSlots(unique, layout), selectedOutputs: {}, initialized: true, page: 0, focusedChannelId: null })
    },
    setLayout(layout) {
      if (!MONITOR_LAYOUTS.includes(layout)) return
      // Choosing capacity while loading must not suppress the first arrangement.
      set(s => ({ layout, mode: 'manual', slots: fitSlots(s.slots, layout), page: 0 }))
    },
    setPage(page) {
      const max = Math.ceil(get().slots.length / LAYOUT_CAPACITY[get().layout]) - 1
      set({ page: Math.max(0, Math.min(max, Math.floor(page))), focusedChannelId: null })
    },
    setHardLimit(n) { if (Number.isFinite(n)) set({ hardLimit: Math.max(1, Math.min(16, Math.floor(n))) }) },
    add(id) {
      if (!id) return false
      const { slots, layout, page } = get()
      const existing = slots.indexOf(id)
      if (existing >= 0) { get().setPage(Math.floor(existing / LAYOUT_CAPACITY[layout])); return true }
      const next = [...slots]
      const start = page * LAYOUT_CAPACITY[layout]
      let index = next.findIndex((item, i) => i >= start && i < start + LAYOUT_CAPACITY[layout] && item === null)
      if (index < 0) index = next.indexOf(null)
      if (index < 0) index = next.length
      if (index >= 4096) return false
      next[index] = id
      set({ slots: fitSlots(next, layout), initialized: true, page: Math.floor(index / LAYOUT_CAPACITY[layout]) })
      return true
    },
    remove(index) {
      const { slots, selectedOutputs } = get()
      if (!Number.isInteger(index) || index < 0 || index >= slots.length) return
      const next = [...slots]
      const selections = { ...selectedOutputs }
      const id = next[index]
      if (id) delete selections[id]
      next[index] = null
      set({ slots: next, selectedOutputs: selections, initialized: true })
    },
    swap(from, to) {
      const next = [...get().slots]
      if (![from, to].every(i => Number.isInteger(i) && i >= 0 && i < next.length)) return
      const previous = next[from] ?? null
      next[from] = next[to] ?? null
      next[to] = previous
      set({ slots: next, initialized: true })
    },
    clear() { set({ slots: fitSlots([], get().layout), selectedOutputs: {}, initialized: true, page: 0, focusedChannelId: null }) },
    enterFocus(id) { set({ focusedChannelId: id }) },
    exitFocus() { set({ focusedChannelId: null }) },
    closeFocus() {
      const id = get().focusedChannelId
      if (id) get().remove(get().slots.indexOf(id))
      set({ focusedChannelId: null })
    },
  }))
  if (persist) store.subscribe((state, previous) => {
    if (!state.initialized || (state.slots === previous.slots && state.layout === previous.layout && state.mode === previous.mode && state.selectedOutputs === previous.selectedOutputs && state.page === previous.page && state.focusedChannelId === previous.focusedChannelId)) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout: state.layout, mode: state.mode, slots: state.slots, selectedOutputs: state.selectedOutputs, page: state.page, focusedChannelId: state.focusedChannelId })) }
    catch { if (!state.persistenceUnavailable) store.setState({ persistenceUnavailable: true }) }
  })
  return store
}

export const useMonitorStore = createMonitorStore(true)
