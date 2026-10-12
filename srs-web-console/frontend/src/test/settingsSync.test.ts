import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { useSettingsStore } from '@/store/settings'
import { systemService } from '@/api/systemService'
vi.mock('@/api/systemService', () => ({ systemService: { getSettings: vi.fn() } }))
describe('settings synchronization across browsers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(systemService.getSettings).mockReset().mockResolvedValue({ pollIntervalMs: 9000 } as any)
    useSettingsStore.setState({ settings: { pollIntervalMs: 5000 } as any, loading: false })
  })
  afterEach(() => vi.useRealTimers())
  it('refreshes cached settings and stops polling when unmounted', async () => {
    const { unmount } = renderHook(useSettingsSync)
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(9000)
    expect(systemService.getSettings).toHaveBeenCalledTimes(1)
    unmount()
    await vi.advanceTimersByTimeAsync(60000)
    expect(systemService.getSettings).toHaveBeenCalledTimes(1)
  })
  it('refreshes on focus, deduplicates pending requests, preserves settings on failure', async () => {
    let reject!: (e: Error) => void
    vi.mocked(systemService.getSettings).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const { unmount } = renderHook(useSettingsSync)
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    expect(systemService.getSettings).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('offline')) })
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(5000)
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(useSettingsStore.getState().settings?.pollIntervalMs).toBe(9000)
    unmount()
  })
})
