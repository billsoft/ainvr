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
  it('selects the smallest supported layout and caps at 16', () => {
    expect(MONITOR_LAYOUTS.map(l => LAYOUT_CAPACITY[l])).toEqual([1, 4, 6, 8, 10, 16])
    expect([0, 1, 2, 5, 7, 9, 11, 30].map(automaticLayout)).toEqual(['1x1', '1x1', '2x2', '3x2', '4x2', '5x2', '4x4', '4x4'])
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
    expect(fitSlots(s.getState().slots, '1x1')).toEqual([null, 'b', null, 'a'])
  })
  it('clear survives reinitialization and focus navigation does not erase slots', () => {
    const s = createMonitorStore()
    s.getState().initialize(['a'])
    s.getState().enterFocus('a')
    s.getState().exitFocus()
    expect(s.getState().slots).toEqual(['a'])
    s.getState().clear()
    s.getState().initialize(['a'])
    expect(s.getState().slots).toEqual([null])
  })
})
