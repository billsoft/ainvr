import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerRtcHevcLoader, useServerRtcHevcWith } from '@/hooks/useServerRtcHevc'

// 服务端能否 WebRTC 播 H.265（SRS ≥ 7.0.33，由 /summary 的 srsRtcHevc 下发）：
// 同页多路 265 共用一次请求；有缓存期；"查询失败"和"确认不支持"必须区分——
// 失败时要自动重试，不能把一次偶发失败（如 SRS 重启）当成永久结论。
describe('createServerRtcHevcLoader', () => {
  it('BFF 正常但 SRS 版本不可达 → unknown，不缓存；恢复后读取真实能力', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ srsRtcHevc: false, srsVersionLive: false })
      .mockResolvedValueOnce({ srsRtcHevc: true, srsVersionLive: true })
    const load = createServerRtcHevcLoader(fetcher)
    expect(await load()).toBe('unknown')
    expect(await load()).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('实时确认旧 SRS 不支持 → false，保留缓存', async () => {
    const fetcher = vi.fn(async () => ({ srsRtcHevc: false, srsVersionLive: true }))
    const load = createServerRtcHevcLoader(fetcher)
    expect(await load()).toBe(false)
    expect(await load()).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('并发调用只发一次请求，结果缓存', async () => {
    const fetcher = vi.fn(async () => ({ srsRtcHevc: true }))
    let now = 0
    const load = createServerRtcHevcLoader(fetcher, () => now)
    const [a, b] = await Promise.all([load(), load()])
    expect([a, b]).toEqual([true, true])
    now = 30_000
    expect(await load()).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('缓存 60s 后重新取（SRS 升级/回滚后能跟上）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ srsRtcHevc: true })
      .mockResolvedValueOnce({ srsRtcHevc: false })
    let now = 0
    const load = createServerRtcHevcLoader(fetcher, () => now)
    expect(await load()).toBe(true)
    now = 61_000
    expect(await load()).toBe(false)
  })
  it('旧后端没有该字段 → false（确认不支持）；请求失败 → unknown，不缓存', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ srsRtcHevc: true })
    let now = 0
    const load = createServerRtcHevcLoader(fetcher, () => now)
    expect(await load()).toBe(false)
    now = 61_000
    expect(await load()).toBe('unknown')
    expect(await load()).toBe(true) // 失败那次没缓存，立刻重试
  })
})

describe('useServerRtcHevcWith（播放器用的 hook）', () => {
  afterEach(() => vi.useRealTimers())

  it('SRS 不可达的真实响应走快速退避，恢复后切回支持', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ srsRtcHevc: false, srsVersionLive: false })
      .mockResolvedValueOnce({ srsRtcHevc: true, srsVersionLive: true })
    const load = createServerRtcHevcLoader(fetcher)
    const { result } = renderHook(() => useServerRtcHevcWith(load, true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current).toBe('unknown')
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(result.current).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('查询失败 → unknown，并按退避自动重试，恢复后给出真实结果', async () => {
    vi.useFakeTimers()
    const loader = vi.fn()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce(true)
    const { result } = renderHook(() => useServerRtcHevcWith(loader, true))
    expect(result.current).toBeNull() // 取数中
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current).toBe('unknown')
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(result.current).toBe(true)
  })

  it('拿到结果后定期复查（服务端升级/回滚能跟上），结果不变不触发重渲染变化', async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { result } = renderHook(() => useServerRtcHevcWith(loader, true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(result.current).toBe(false)
  })

  it('非 H.265（enabled=false）不请求，返回 null', async () => {
    const loader = vi.fn()
    const { result } = renderHook(() => useServerRtcHevcWith(loader, false))
    expect(result.current).toBeNull()
    expect(loader).not.toHaveBeenCalled()
  })

  it('卸载后不再重试', async () => {
    vi.useFakeTimers()
    const loader = vi.fn().mockResolvedValue('unknown')
    const { unmount } = renderHook(() => useServerRtcHevcWith(loader, true))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
