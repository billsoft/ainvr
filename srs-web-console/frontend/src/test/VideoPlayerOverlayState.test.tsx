import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import { attachWebRTC } from '@/components/player/webrtc'

// 叠框状态提示必须稳定（设计 §8.2）：近似 / 设备不支持 / 未收到识别数据 这些已判定的
// 状态，不能被"aiChannelId 到位时切到同步中"的初始化反复冲回"同步中"。
// 回归：那段初始化以 overlaySync 为依赖，任何非 synced/syncing 的状态一设置就被改回
// syncing——近似模式只上报一次，于是永远显示"同步中"；no_sei 的 3 次重试上限也失效。

const overlayProps: Array<{ onMode?: (m: 'exact' | 'approx') => void }> = []
vi.mock('@/components/player/AiDetectionOverlay', () => ({
  AiDetectionOverlay: (p: { onMode?: (m: 'exact' | 'approx') => void }) => {
    overlayProps.push(p)
    return null
  },
}))
vi.mock('@/components/player/webrtc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/player/webrtc')>()
  return { ...actual, attachWebRTC: vi.fn() }
})
vi.mock('@/hooks/useServerRtcHevc', () => ({ useServerRtcHevc: () => null }))

const props = {
  title: '',
  protocols: ['webrtc'] as Array<'flv' | 'hls' | 'webrtc'>,
  primary: 'webrtc' as const,
  stream: { host: 'h', app: 'live', stream: 's' },
  aiChannelId: 'ai-1',
}

function handle(encodedFramesSupported: boolean) {
  return { close: vi.fn(), encodedFramesSupported, getStats: vi.fn(async () => new Map() as never) }
}

async function startPlaying() {
  render(<VideoPlayer {...props} />)
  await waitFor(() => expect(attachWebRTC).toHaveBeenCalled())
  const video = screen.getByTestId('video-player').querySelector('video')!
  await act(async () => { video.dispatchEvent(new Event('playing')) })
}

beforeEach(() => {
  overlayProps.length = 0
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(attachWebRTC).mockReset()
})

describe('VideoPlayer 叠框状态不被初始化覆盖', () => {
  it('无 SEI 时真正重建连接且最多三次；晚到的识别数据仍能恢复', async () => {
    vi.mocked(attachWebRTC).mockImplementation(async () => handle(true))
    vi.useFakeTimers()
    render(<VideoPlayer {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const video = screen.getByTestId('video-player').querySelector('video')!
    await act(async () => { video.dispatchEvent(new Event('playing')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(screen.getByRole('status')).toHaveTextContent('未收到编码帧')
    for (let retry = 0; retry < 3; retry += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(attachWebRTC).toHaveBeenCalledTimes(retry + 2)
      await act(async () => { video.dispatchEvent(new Event('playing')) })
      expect(screen.getByRole('status')).toHaveTextContent('识别框同步中')
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
      expect(screen.getByRole('status')).toHaveTextContent('未收到编码帧')
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(attachWebRTC).toHaveBeenCalledTimes(4)
    expect(screen.getByRole('status')).toHaveTextContent('未收到编码帧')
    await act(async () => { overlayProps.at(-1)!.onMode!('approx') })
    expect(screen.getByRole('status')).toHaveTextContent('识别框近似对齐')
  })
  it.each(['exact', 'approx'] as const)('建连晚返回不能覆盖已成功的 %s 模式', async (mode) => {
    let resolve!: (value: ReturnType<typeof handle>) => void
    vi.mocked(attachWebRTC).mockImplementation(() => new Promise(r => { resolve = r }))
    await startPlaying()
    await act(async () => { overlayProps.at(-1)!.onMode!(mode) })
    await act(async () => { resolve(handle(true)) })
    if (mode === 'exact') expect(screen.queryByRole('status')).toBeNull()
    else expect(screen.getByRole('status')).toHaveTextContent('识别框近似对齐')
  })
  it('近似模式上报后一直显示"近似对齐"，不回到"同步中"', async () => {
    vi.mocked(attachWebRTC).mockImplementation(async () => handle(true))
    await startPlaying()
    await act(async () => { overlayProps[overlayProps.length - 1]!.onMode!('approx') })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('status')).toHaveTextContent('识别框近似对齐')
  })

  it('浏览器取不到编码帧 → 稳定显示"当前设备不支持识别框叠加"', async () => {
    vi.mocked(attachWebRTC).mockImplementation(async () => handle(false))
    await startPlaying()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('status')).toHaveTextContent('当前设备不支持识别框叠加')
  })

  it('逐帧上报后不显示任何提示', async () => {
    vi.mocked(attachWebRTC).mockImplementation(async () => handle(true))
    await startPlaying()
    await act(async () => { overlayProps[overlayProps.length - 1]!.onMode!('exact') })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
