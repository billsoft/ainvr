import { describe, expect, it } from 'vitest'
import { automaticLayout, fitSlots, LAYOUT_CAPACITY, MONITOR_LAYOUTS } from '@/utils/monitorLayout'
import { createMonitorStore } from '@/store/monitor'

describe('monitor workspace', () => {
  it('keeps first arrangement pending when capacity is chosen during loading', () => {
    const s = createMonitorStore()
    s.getState().setLayout('3x2')
    expect(s.getState().initialized).toBe(false)
    s.getState().initialize(['a', 'b'])
    expect(s.getState().layout).toBe('3x2')
    expect(s.getState().slots).toEqual(['a', 'b', null, null, null, null])
  })
  it('removing a channel clears its saved output choice', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a'])
    s.getState().selectOutput('a', 'old-ai-output')
    s.getState().remove(0)
    s.getState().add('a')
    expect(s.getState().selectedOutputs).toEqual({})
  })
  it('selects the smallest supported layout and caps at 32', () => {
    expect(MONITOR_LAYOUTS.map(l => LAYOUT_CAPACITY[l])).toEqual([4, 6, 8, 10, 16, 32])
    expect([0, 1, 2, 5, 7, 9, 11, 30].map(automaticLayout)).toEqual(['2x2', '2x2', '2x2', '3x2', '4x2', '5x2', '4x4', '8x4'])
  })
  it('initializes once; status or catalogue updates do not move positions', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a', 'b'])
    s.getState().initialize(['c', 'b', 'a'])
    expect(s.getState().slots).toEqual(['a', 'b', null, null])
  })
  it('shrinking paginates without losing selected channels', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a', 'b', 'c', 'd', 'e'])
    s.getState().setLayout('2x2')
    expect(s.getState().slots).toEqual(['a', 'b', 'c', 'd', 'e', null, null, null])
    s.getState().setPage(99)
    expect(s.getState().page).toBe(1)
  })
  it('keeps connection limits separate from saved positions', () => {
    const s = createMonitorStore()
    s.getState().setHardLimit(1)
    s.getState().initialize(['a', 'b', 'c'])
    expect(s.getState().slots.filter(Boolean)).toHaveLength(3)
    expect(s.getState().hardLimit).toBe(1)
  })
  it('swaps occupied and empty positions and preserves holes', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a', 'b'])
    s.getState().swap(0, 3)
    expect(s.getState().slots).toEqual([null, 'b', null, 'a'])
    expect(fitSlots(s.getState().slots, '2x2')).toEqual([null, 'b', null, 'a'])
  })
  it('clear survives reinitialization and focus navigation does not erase slots', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a'])
    s.getState().enterFocus('a')
    s.getState().exitFocus()
    expect(s.getState().slots).toEqual(['a', null, null, null])
    s.getState().clear()
    s.getState().initialize(['a'])
    expect(s.getState().slots).toEqual([null, null, null, null])
  })
})

it('defaults to four panes even with many channels', () => {
  const store = createMonitorStore()
  store.getState().initialize(Array.from({length: 40}, (_, i) => `cam-${i}`))
  expect(store.getState().layout).toBe('2x2')
  expect(store.getState().slots.filter(Boolean)).toHaveLength(40)
})
it('restores layout, order, source, page and focus across reopening, including an intentionally empty view', () => {
  localStorage.removeItem('ainvr-monitor-workspace-v1')
  try {
    const first = createMonitorStore(true)
    first.getState().initialize(Array.from({length: 12}, (_, i) => `cam-${i}`))
    first.getState().setLayout('3x2')
    first.getState().swap(0, 7)
    first.getState().selectOutput('cam-0', 'ai-output')
    first.getState().setPage(1)
    first.getState().enterFocus('cam-0')
    const reopened = createMonitorStore(true)
    reopened.getState().initialize(['new-catalogue'])
    expect(reopened.getState().layout).toBe('3x2')
    expect(reopened.getState().slots).toEqual(first.getState().slots)
    expect(reopened.getState().selectedOutputs).toEqual({'cam-0': 'ai-output'})
    expect(reopened.getState().page).toBe(1)
    expect(reopened.getState().focusedChannelId).toBe('cam-0')
    reopened.getState().clear()
    const cleared = createMonitorStore(true)
    cleared.getState().initialize(['cam-0'])
    expect(cleared.getState().slots.filter(Boolean)).toEqual([])
  } finally { localStorage.removeItem('ainvr-monitor-workspace-v1') }
})
