import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePolling } from '@/hooks/usePolling'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('立即执行一次，之后每隔 intervalMs 执行一次', async () => {
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('enabled=false 时完全不执行', async () => {
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000, false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('页面隐藏时暂停，不再触发新的调用', async () => {
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5000)
    // 隐藏期间不应该再新增调用
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重新可见时立即执行一次，不等下一个 interval', async () => {
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5000) // 隐藏期间不触发

    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(2) // 恢复可见立即补一次，不是等到下个 1000ms
  })

  it('回归：请求飞行途中切后台，隐藏期间快进超过一个 interval 后切回前台仍能恢复（此前会永久卡死）', async () => {
    let resolveFn: () => void = () => {}
    const fn = vi.fn(() => new Promise<void>((r) => { resolveFn = r }))
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    // 请求还在飞行中时切到后台
    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    resolveFn()
    await vi.advanceTimersByTimeAsync(0) // fn() resolve 后重新判断是否要排下一次

    // 隐藏期间快进超过一个 interval——修复前会在这里让一个"本不该存在"的
    // 定时器到点触发，命中 hidden 守卫直接 return 却不复位 timer，此后永久卡死
    await vi.advanceTimersByTimeAsync(2000)
    expect(fn).toHaveBeenCalledTimes(1) // 隐藏期间不应该有新调用

    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(2) // 必须能恢复，不能永久卡死
  })

  it('回归：fn 抛异常不会让轮询永久停摆', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2) // 第一次抛错后，下一轮仍然正常执行
  })

  it('回归：连续失败时自动退避（2^n 封顶），恢复成功后重置为原始频率', async () => {
    let failing = true
    // fn 本身用抛异常表达失败，但退避判断完全由 isFailing() 决定（不看 fn
    // 是否抛错）——更贴近真实调用方写法：fetchChannels 内部吞掉异常，
    // 只把结果落进 store 的 serviceUnreachable 状态位。
    const fn = vi.fn(() => { if (failing) throw new Error('down') })
    renderHook(() => usePolling(fn, 1000, true, { isFailing: () => failing, maxBackoffMultiplier: 4 }))

    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1) // t=0 立即执行一次，失败

    await vi.advanceTimersByTimeAsync(1000) // t=1000，还没到下一次（已退避到 2000ms）
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000) // t=2000
    expect(fn).toHaveBeenCalledTimes(2) // 第二次失败

    await vi.advanceTimersByTimeAsync(3000) // t=5000，还没到下一次（已退避到 4000ms，即 t=6000）
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000) // t=6000
    expect(fn).toHaveBeenCalledTimes(3) // 第三次失败，倍数封顶在 4，不再继续翻倍

    failing = false // 服务恢复
    await vi.advanceTimersByTimeAsync(4000) // t=10000（沿用上一次算出的 4000ms 间隔触发这次）
    expect(fn).toHaveBeenCalledTimes(4) // 这次调用成功

    await vi.advanceTimersByTimeAsync(1000) // t=11000，应已恢复到原始 1000ms 间隔
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('不传 isFailing 时行为不变（恒定频率，向后兼容）', async () => {
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('卸载后清理 timer 和事件监听，不再触发', async () => {
    const fn = vi.fn()
    const { unmount } = renderHook(() => usePolling(fn, 1000))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)

    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
