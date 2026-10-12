import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import Dashboard from '@/pages/Dashboard'
import { useSettingsStore } from '@/store/settings'
import { observabilityService } from '@/api/observabilityService'
vi.mock('@/api/observabilityService', () => ({ observabilityService: {
  summary: vi.fn(async () => ({})), history: vi.fn(async () => ({ items: [] })),
} }))
describe('dashboard configuration', () => {
  it('applies a changed summary polling interval without remounting', async () => {
    vi.useFakeTimers()
    useSettingsStore.setState({ settings: { pollIntervalMs: 6000 } as any })
    const { unmount } = render(<MemoryRouter><Dashboard /></MemoryRouter>)
    try {
      await act(async () => {})
      expect(observabilityService.summary).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(observabilityService.summary).toHaveBeenCalledTimes(2)
      await act(async () => { useSettingsStore.setState({ settings: { pollIntervalMs: 2000 } as any }) })
      expect(observabilityService.summary).toHaveBeenCalledTimes(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(observabilityService.summary).toHaveBeenCalledTimes(4)
    } finally { unmount(); vi.useRealTimers() }
  })
})
