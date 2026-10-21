import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import flvjs from 'flv.js'
import Hls from 'hls.js'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import { attachWebRTC } from '@/components/player/webrtc'
import { aiChannelService } from '@/api/aiChannelService'
import { useServerRtcHevc } from '@/hooks/useServerRtcHevc'
import { getCodecSupport, type CodecSupport } from '@/utils/codec'

// attachWebRTC 用 mock 接管（不建真实 RTCPeerConnection），其余导出保持真实——
// 看门狗判定类、stats 解析都要跑真实现。
vi.mock('@/components/player/webrtc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/player/webrtc')>()
  return { ...actual, attachWebRTC: vi.fn() }
})

// H.265 判定的两个输入：服务端能力（/summary）与本机能力（浏览器探测）都由用例控制
vi.mock('@/hooks/useServerRtcHevc', () => ({ useServerRtcHevc: vi.fn(() => null) }))
vi.mock('@/utils/codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/codec')>()
  return { ...actual, getCodecSupport: vi.fn(actual.getCodecSupport) }
})

vi.mock('@/api/aiChannelService', () => ({
  aiChannelService: { resultHistory: vi.fn(async () => []) },
}))

vi.mock('flv.js', () => {
  class FakePlayer {
    on = vi.fn()
    off = vi.fn()
    attachMediaElement = vi.fn()
    load = vi.fn()
    pause = vi.fn()
    destroy = vi.fn()
  }
  return {
    default: {
      isSupported: () => true,
      createPlayer: vi.fn(() => new FakePlayer()),
      Events: { ERROR: 'error' },
    },
  }
})

vi.mock('hls.js', () => {
  const instances: unknown[] = []
  class FakeHls {
    static Events = { ERROR: 'error' }
    static instances = instances
    static isSupported = () => true
    on = vi.fn()
    off = vi.fn()
    loadSource = vi.fn()
    attachMedia = vi.fn()
    destroy = vi.fn()
    constructor() {
      instances.push(this)
    }
  }
  return { default: FakeHls, Events: { ERROR: 'error' } }
})

const FakeHlsCls = Hls as unknown as {
  instances: Array<Record<string, ReturnType<typeof vi.fn>>>
}

interface FakeFlvPlayer {
  on: ReturnType<typeof vi.fn>
  attachMediaElement: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}
function flvInstances(): FakeFlvPlayer[] {
  return vi.mocked(flvjs.createPlayer).mock.results.map((r) => r.value as never)
}

const baseProps = {
  title: '测试通道',
  protocols: ['flv', 'hls'] as Array<'flv' | 'hls' | 'webrtc'>,
  primary: 'flv' as const,
  stream: { host: '192.168.100.183', app: 'live', stream: 'test' },
}

beforeEach(() => {
  // 清空所有 mock 调用记录（含 createPlayer 的 mock.results，避免跨用例拿到旧组件树实例）
  vi.clearAllMocks()
  FakeHlsCls.instances.length = 0
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VideoPlayer', () => {
  it('初始显示连接中覆盖层（flv 协议），创建 flv 实例', () => {
    render(<VideoPlayer {...baseProps} />)
    expect(screen.getByText(/正在连接 HTTP-FLV/)).toBeInTheDocument()
    const inst = flvInstances()[0]
    expect(inst?.attachMediaElement).toHaveBeenCalled()
    expect(inst?.load).toHaveBeenCalled()
  })

  it('flv 失败自动降级到 hls.js', async () => {
    render(<VideoPlayer {...baseProps} />)
    const inst = flvInstances()[0]!
    const errHandler = inst.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      type: string,
      detail: string,
      info: any,
    ) => void
    // flv.js ERROR 真实签名：(type, detail, info)。type ∈ ErrorTypes
    // {NetworkError|MediaError|OtherError}，detail 是细粒度原因（ErrorDetails，
    // 如 ConnectingTimeout/Exception/MediaMSEError 等，从不等于 'NetworkError'）。
    errHandler('NetworkError', 'ConnectingTimeout', { code: 404 })
    await waitFor(() => {
      expect(FakeHlsCls.instances.length).toBe(1)
    })
    expect(FakeHlsCls.instances[0]!.loadSource).toHaveBeenCalledWith(
      '/media/live/test.m3u8',
    )
  })

  it('回归：OtherError 类型不视为致命，不触发降级', () => {
    render(<VideoPlayer {...baseProps} />)
    const inst = flvInstances()[0]!
    const errHandler = inst.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      type: string,
      detail: string,
      info: any,
    ) => void
    errHandler('OtherError', 'Exception', { code: -1 })
    expect(FakeHlsCls.instances.length).toBe(0)
    expect(screen.getByText(/正在连接 HTTP-FLV/)).toBeInTheDocument()
  })

  it('链尽显示失败覆盖层与重试按钮', async () => {
    render(<VideoPlayer {...baseProps} />)
    const inst = flvInstances()[0]!
    const errHandler = inst.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      type: string,
      detail: string,
      info: any,
    ) => void
    errHandler('NetworkError', 'ConnectingTimeout', { code: 404 })
    await waitFor(() => expect(FakeHlsCls.instances.length).toBe(1))
    const hls = FakeHlsCls.instances[0]!
    const hlsOn = hls.on as ReturnType<typeof vi.fn>
    const hlsErr = hlsOn.mock.calls.find((c) => c[0] === 'error')?.[1] as (
      e: string,
      d: { fatal: boolean; details?: string },
    ) => void
    hlsErr('error', { fatal: true, details: 'networkError' })
    expect(await screen.findByText('无视频信号')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('Safari 原生 HLS：canPlayType 命中时不创建 hls.js 实例', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably')
    render(<VideoPlayer {...baseProps} primary="hls" protocols={['hls', 'flv']} />)
    expect(screen.getByText(/正在连接 HLS/)).toBeInTheDocument()
    expect(FakeHlsCls.instances.length).toBe(0)
    expect(flvInstances().length).toBe(0)
  })

  it('控制栏：协议切换下拉可用', async () => {
    const user = userEvent.setup()
    render(<VideoPlayer {...baseProps} />)
    const select = await screen.findByTestId('proto-select')
    await user.selectOptions(select, 'hls')
    await waitFor(() => expect(FakeHlsCls.instances.length).toBe(1))
  })

  it('20 次快速换源：全部实例 destroy 且 pause 先于 destroy，无 React 卸载警告', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender, unmount } = render(<VideoPlayer {...baseProps} />)
    for (let i = 1; i <= 20; i++) {
      rerender(
        <VideoPlayer
          {...baseProps}
          stream={{ host: '192.168.100.183', app: 'live', stream: `test${i}` }}
        />,
      )
    }
    unmount()
    const insts = flvInstances()
    expect(insts.length).toBe(21) // 初始 1 + 20 次换源
    for (const inst of insts) {
      expect(inst.destroy).toHaveBeenCalled()
      expect(inst.pause).toHaveBeenCalled()
      const pausePos = inst.pause.mock.invocationCallOrder[0]!
      const destroyPos = inst.destroy.mock.invocationCallOrder[0]!
      expect(pausePos).toBeLessThan(destroyPos)
    }
    const reactWarnings = consoleError.mock.calls
      .flat()
      .filter(
        (s) =>
          typeof s === 'string' &&
          (s.includes('after unmount') || s.includes('not wrapped in act')),
      )
    expect(reactWarnings).toEqual([])
    consoleError.mockRestore()
  })

  it('回归：video 触发 playing 事件（连接成功）后不应销毁重建播放器（闪一下就黑屏）', async () => {
    render(<VideoPlayer {...baseProps} />)
    const inst = flvInstances()[0]!
    expect(screen.getByText(/正在连接 HTTP-FLV/)).toBeInTheDocument()

    const video = screen.getByTestId('video-player').querySelector('video')!
    video.dispatchEvent(new Event('playing'))

    // 播放成功后：连接中覆盖层消失，且不应有第二个 flv 实例被创建，
    // 也不应该销毁刚建立好的这一个（success 不该触发 effect 重新执行）。
    await waitFor(() => {
      expect(screen.queryByText(/正在连接/)).not.toBeInTheDocument()
    })
    expect(flvInstances().length).toBe(1)
    expect(inst.destroy).not.toHaveBeenCalled()
  })

  it('卸载不抛异常', () => {
    const { unmount } = render(<VideoPlayer {...baseProps} />)
    expect(() => unmount()).not.toThrow()
  })
})

describe('VideoPlayer · AI 识别框叠加（aiChannelId）', () => {
  it('不传 aiChannelId 时，控制栏不出现"识别框"开关，也不创建叠加层 canvas', async () => {
    render(<VideoPlayer {...baseProps} />)
    expect(screen.queryByTestId('btn-toggle-ai-overlay')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ai-detection-overlay')).not.toBeInTheDocument()
    // 给 effect 一轮 microtask 机会，确认没有发起历史结果轮询
    await Promise.resolve()
    expect(aiChannelService.resultHistory).not.toHaveBeenCalled()
  })

  it('传了 aiChannelId 且协议列表含 webrtc：强制 WebRTC 优先，默认开启叠加层，隐藏识别框仍保留常显轨迹', async () => {
    const user = userEvent.setup()
    render(
      <VideoPlayer
        {...baseProps}
        protocols={['flv', 'webrtc']}
        primary="flv"
        aiChannelId="cam01"
      />,
    )

    // 强制 WebRTC 优先（即使 primary 是 flv）
    expect(screen.getByText(/正在连接 WebRTC/)).toBeInTheDocument()
    expect(screen.getByTestId('btn-toggle-ai-overlay')).toBeInTheDocument()
    // 默认开启叠加层 canvas
    expect(screen.getByTestId('ai-detection-overlay')).toBeInTheDocument()
    // 不再拉历史结果轮询（识别框只走逐帧 SEI 路径）
    await Promise.resolve()
    expect(aiChannelService.resultHistory).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('btn-toggle-ai-overlay'))
    expect(screen.getByTestId('btn-toggle-ai-overlay')).toHaveAttribute('title','显示识别框')
    expect(screen.getByTestId('ai-detection-overlay')).toBeInTheDocument()
    expect(screen.queryByTestId('btn-toggle-trails')).not.toBeInTheDocument()
  })

  it('传了 aiChannelId 但协议不含 webrtc（FLV-only）：显示"不支持逐帧识别框"提示', async () => {
    render(<VideoPlayer {...baseProps} aiChannelId="cam01" />)
    const video = screen.getByTestId('video-player').querySelector('video')!
    // 触发 playing 让状态切到播放态，非 webrtc 协议的 overlaySync 会变 unsupported
    await act(() => { video.dispatchEvent(new Event('playing')) })
    await waitFor(() => {
      expect(screen.getByText(/不支持逐帧识别框/)).toBeInTheDocument()
    })
  })

  it('识别框开关点击不冒泡——宫格瓦片外层的"点击进聚焦"容器不应被连带触发', async () => {
    const user = userEvent.setup()
    const onTileClick = vi.fn()
    render(
      <div onClick={onTileClick}>
        <VideoPlayer
          {...baseProps}
          protocols={['flv', 'webrtc']}
          primary="flv"
          aiChannelId="cam01"
        />
      </div>,
    )
    await user.click(screen.getByTestId('btn-toggle-ai-overlay'))
    expect(onTileClick).not.toHaveBeenCalled()
  })
})

describe('VideoPlayer · WebRTC 延迟/冻屏看门狗自动重连', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(attachWebRTC).mockReset()
  })

  function mockAttachWithHighLatency() {
    // 每次轮询窗口平均延迟 6s（delay 每 60 帧 +360s），帧持续推进排除冻屏
    let emitted = 0
    let delay = 0
    vi.mocked(attachWebRTC).mockImplementation(async () => ({
      close: vi.fn(),
      // 这组用例测的是看门狗，不涉及逐帧 SEI；置 false 表示"本次连接没挂
      // 编码帧回调"，叠加层会长期停在同步中状态（不画不可信的框）
      encodedFramesSupported: false,
      getStats: vi.fn(async () => {
        delay += 360
        emitted += 60
        return {
          values: () => [{
            type: 'inbound-rtp', kind: 'video',
            jitterBufferDelay: delay,
            jitterBufferEmittedCount: emitted,
            framesDecoded: emitted,
          }].values(),
        } as unknown as RTCStatsReport
      }),
    }))
  }

  /** 解码计数恒定：连接建立后一直不出新画面（后台/卡住的新连接） */
  function mockAttachStalled() {
    vi.mocked(attachWebRTC).mockImplementation(async () => ({
      close: vi.fn(),
      encodedFramesSupported: false,
      getStats: vi.fn(async () => ({
        values: () => [{ type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0, jitterBufferEmittedCount: 0, framesDecoded: 0 }].values(),
      } as unknown as RTCStatsReport)),
    }))
  }

  /** 健康连接：画面持续推进、延迟很低，看门狗不会触发 */
  function mockAttachHealthy() {
    let emitted = 0
    vi.mocked(attachWebRTC).mockImplementation(async () => ({
      close: vi.fn(),
      encodedFramesSupported: false,
      getStats: vi.fn(async () => {
        emitted += 60
        return {
          values: () => [{ type: 'inbound-rtp', kind: 'video', jitterBufferDelay: emitted * 0.05, jitterBufferEmittedCount: emitted, framesDecoded: emitted }].values(),
        } as unknown as RTCStatsReport
      }),
    }))
  }

  const playingEvent = async () => {
    await act(async () => {
      screen.getByTestId('video-player').querySelector('video')!.dispatchEvent(new Event('playing'))
    })
  }

  it('重复失联和连接中的事件不消耗后续重连额度', async () => {
    mockAttachHealthy()
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await Promise.resolve() })
    await playingEvent()
    const first = vi.mocked(attachWebRTC).mock.calls[0]![1].onConnectionLost!
    await act(async () => { first('failed'); first('failed'); first('failed') })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    const second = vi.mocked(attachWebRTC).mock.calls[1]![1].onConnectionLost!
    await act(async () => { second('failed'); second('failed') })
    await playingEvent()
    await act(async () => { second('failed') })
    expect(attachWebRTC).toHaveBeenCalledTimes(3)
    unmount()
  })

  it('首帧在超时之后恢复时取消失败重试，不拆掉已恢复的连接', async () => {
    vi.useFakeTimers()
    mockAttachHealthy()
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(screen.getByTestId('player-recovery-status')).toBeInTheDocument()
    await playingEvent()
    expect(screen.queryByTestId('player-recovery-status')).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(attachWebRTC).toHaveBeenCalledTimes(1)
    unmount()
  })

  /** 切走或切回前台：先改 document.hidden，再派发 visibilitychange */
  function visibility(hidden: { mockReturnValue: (v: boolean) => unknown }, value: boolean) {
    hidden.mockReturnValue(value)
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('截图场景：重连后新连接迟迟不出画面，不会掉进全屏失败遮罩，角落提示可看原因并持续自动恢复', async () => {
    vi.useFakeTimers()
    mockAttachStalled()
    // 按 1 秒步进推进：单次大跨度推进时 React 要到 act 结束才提交渲染、登记新定时器，与真实时间线不符
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 1_000) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    }
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await playingEvent()
    // 开播宽限 20s + 停滞 8s → 判停滞 → 同协议重连
    await advance(30_000)
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    // 新连接一直不出画面：看门狗在"连接中"再判停滞，不得把状态推进到失败（修复前就是这里掉进遮罩）
    await advance(20_000)
    expect(screen.queryByTestId('player-recovery-status')).not.toBeInTheDocument()
    // 重连后在连接中满 30s（约第 52 秒）才算一次失败：只在角落提示，悬停可看具体原因，不出现全屏"播放失败"
    await advance(4_000)
    const badge = screen.getByTestId('player-recovery-status')
    expect(badge.className).not.toContain('inset-0')
    expect(badge).toHaveAttribute('title', '等待视频画面超时')
    expect(screen.queryByText('播放失败')).not.toBeInTheDocument()
    // 失败后自动重试
    await advance(5_000)
    expect(attachWebRTC).toHaveBeenCalledTimes(3)
    unmount()
  })

  it('普通通道：短暂切走（<10 秒）回来不重连，长时间切走回来重连一次', async () => {
    vi.useFakeTimers()
    mockAttachHealthy()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await playingEvent()
    await act(async () => { visibility(hidden, true); await vi.advanceTimersByTimeAsync(5_000) })
    await act(async () => { visibility(hidden, false) })
    expect(attachWebRTC).toHaveBeenCalledTimes(1)
    await act(async () => { visibility(hidden, true); await vi.advanceTimersByTimeAsync(15_000) })
    await act(async () => { visibility(hidden, false) })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    unmount()
    hidden.mockRestore()
  })

  it('AI 通道：切回前台总是重连，以恢复识别框逐帧同步', async () => {
    vi.useFakeTimers()
    mockAttachHealthy()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} aiChannelId="cam01" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await playingEvent()
    await act(async () => { visibility(hidden, true); await vi.advanceTimersByTimeAsync(2_000) })
    await act(async () => { visibility(hidden, false) })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    unmount()
    hidden.mockRestore()
  })

  it('失败状态不再挂"识别框同步中"', async () => {
    vi.useFakeTimers()
    vi.mocked(attachWebRTC).mockRejectedValue(new Error('temporary failure'))
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} aiChannelId="cam01" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('player-recovery-status')).toBeInTheDocument()
    expect(screen.queryByText('识别框同步中…')).not.toBeInTheDocument()
    unmount()
  })

  it('隐藏时不按冻屏重连，恢复前台只重建一次', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mockAttachWithHighLatency()
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => {
      screen.getByTestId('video-player').querySelector('video')!.dispatchEvent(new Event('playing'))
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(attachWebRTC).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('同一连接重复失联事件不把重连变成最终失败，旧回调不能干扰新连接', async () => {
    mockAttachWithHighLatency()
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { screen.getByTestId('video-player').querySelector('video')!.dispatchEvent(new Event('playing')) })
    const lost = vi.mocked(attachWebRTC).mock.calls[0]![1].onConnectionLost!
    await act(async () => { lost('failed'); lost('failed') })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('播放失败')).not.toBeInTheDocument()
    await act(async () => { lost('failed') })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('连接失败后自动重试，提示不覆盖整个画面', async () => {
    vi.useFakeTimers()
    vi.mocked(attachWebRTC).mockRejectedValue(new Error('temporary failure'))
    const { unmount } = render(<VideoPlayer {...baseProps} protocols={['webrtc']} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('player-recovery-status').className).not.toContain('inset-0')
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('高延迟持续 3 个轮询（出开播宽限后）→ 自动销毁并重新建连', async () => {
    vi.useFakeTimers()
    mockAttachWithHighLatency()
    const props = {
      title: 'w',
      protocols: ['webrtc', 'flv'] as Array<'flv' | 'hls' | 'webrtc'>,
      primary: 'webrtc' as const,
      stream: { host: '192.168.100.183', app: 'live', stream: 'test' },
    }
    const { unmount } = render(<VideoPlayer {...props} />)

    // 等 attach 的 Promise 链跑完
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(attachWebRTC).toHaveBeenCalledTimes(1)
    screen.getByTestId('video-player').querySelector('video')!
      .dispatchEvent(new Event('playing'))
    await act(async () => { await Promise.resolve() })

    // 2s 轮询，20s 宽限，之后连续 3 点（22/24/26s）→ 触发同协议重连
    await act(async () => { await vi.advanceTimersByTimeAsync(28_000) })
    // 重连后新 effect 的 attach Promise 再放一个微任务
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(attachWebRTC).toHaveBeenCalledTimes(2)
    expect(vi.mocked(attachWebRTC).mock.calls[1]![1]?.streamurl)
      .toBe('webrtc://192.168.100.183/live/test')
    unmount()
  })

  it('宽限期内（前 20s）延迟再高也不重连', async () => {
    vi.useFakeTimers()
    mockAttachWithHighLatency()
    const props = {
      title: 'w',
      protocols: ['webrtc'] as Array<'flv' | 'hls' | 'webrtc'>,
      primary: 'webrtc' as const,
      stream: { host: '192.168.100.183', app: 'live', stream: 'test' },
    }
    const { unmount } = render(<VideoPlayer {...props} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(19_000) })
    expect(attachWebRTC).toHaveBeenCalledTimes(1)
    unmount()
  }, 15000)
})

describe('VideoPlayer · H.265 播放方式选择（设计 §8.3）', () => {
  const noSupport: CodecSupport = {
    webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0,
    encodedTransform: null, videoFrameCallback: false,
  }
  const props265 = {
    title: 'cam',
    protocols: ['webrtc', 'hls'] as Array<'flv' | 'hls' | 'webrtc'>,
    primary: 'webrtc' as const,
    stream: { host: '192.168.100.183', app: 'live', stream: 'cam' },
    videoInfo: { codec: 'HEVC', level: '4', width: 1920, height: 1080 },
  }
  const handle = () => ({ close: vi.fn(), encodedFramesSupported: false, getStats: vi.fn(async () => new Map() as never) })

  beforeEach(() => {
    vi.mocked(attachWebRTC).mockReset()
    vi.mocked(attachWebRTC).mockImplementation(async () => handle())
  })
  afterEach(() => {
    vi.mocked(useServerRtcHevc).mockReturnValue(null)
  })

  it('服务端能力还没拿到：显示检测中，不建任何连接', () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(null)
    vi.mocked(getCodecSupport).mockReturnValue({ ...noSupport, webrtcH265: true })
    render(<VideoPlayer {...props265} />)
    expect(screen.getByText(/正在检测 H\.265 播放能力/)).toBeInTheDocument()
    expect(attachWebRTC).not.toHaveBeenCalled()
    expect(FakeHlsCls.instances).toHaveLength(0)
  })

  it('服务端 + 本机都支持 → WebRTC，并显示编码角标', async () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(true)
    vi.mocked(getCodecSupport).mockReturnValue({ ...noSupport, webrtcH265: true })
    render(<VideoPlayer {...props265} />)
    await waitFor(() => expect(attachWebRTC).toHaveBeenCalledTimes(1))
    expect(screen.getByText('H.265')).toBeInTheDocument()
  })

  it('本机 WebRTC 不支持、只有原生 HLS 能播（无 MSE 的设备）→ video.src 直接指向 m3u8，不用 hls.js', async () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(true)
    vi.mocked(getCodecSupport).mockReturnValue({ ...noSupport, nativeHlsHevcMaxLevel: 153, fileHevcMaxLevel: 153 })
    render(<VideoPlayer {...props265} />)
    const video = screen.getByTestId('video-player').querySelector('video')!
    await waitFor(() => expect(video.getAttribute('src')).toBe('/media/live/cam.m3u8'))
    expect(attachWebRTC).not.toHaveBeenCalled()
    expect(FakeHlsCls.instances).toHaveLength(0)
    expect(screen.getByText(/改用 HLS/)).toBeInTheDocument()
  })

  it('只有 MSE 能播 → hls.js', async () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(false)
    vi.mocked(getCodecSupport).mockReturnValue({ ...noSupport, webrtcH265: true, mseHevcMaxLevel: 153 })
    render(<VideoPlayer {...props265} />)
    await waitFor(() => expect(FakeHlsCls.instances).toHaveLength(1))
    expect(FakeHlsCls.instances[0]!.loadSource).toHaveBeenCalledWith('/media/live/cam.m3u8')
    expect(screen.getByText(/版本过低/)).toBeInTheDocument()
  })

  it('本机都不能播 → 明确说明原因，不连接、不黑屏转圈', () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(true)
    vi.mocked(getCodecSupport).mockReturnValue(noSupport)
    render(<VideoPlayer {...props265} />)
    expect(screen.getByText('无法播放 H.265')).toBeInTheDocument()
    expect(screen.getByText(/此设备不支持 H\.265 的 WebRTC 播放/)).toBeInTheDocument()
    expect(screen.queryByText(/正在连接/)).not.toBeInTheDocument()
    expect(attachWebRTC).not.toHaveBeenCalled()
    expect(FakeHlsCls.instances).toHaveLength(0)
  })

  it('H.264 不受影响：不查服务端能力、照旧走 WebRTC', async () => {
    vi.mocked(getCodecSupport).mockReturnValue(noSupport)
    render(<VideoPlayer {...props265} videoInfo={{ codec: 'H264' }} />)
    await waitFor(() => expect(attachWebRTC).toHaveBeenCalledTimes(1))
    expect(vi.mocked(useServerRtcHevc)).toHaveBeenLastCalledWith(false)
    expect(screen.queryByText('H.265')).not.toBeInTheDocument()
  })

  it('源编码变化（264 → 265）→ 重建连接（设计 §5.2 E2）', async () => {
    vi.mocked(useServerRtcHevc).mockReturnValue(true)
    vi.mocked(getCodecSupport).mockReturnValue({ ...noSupport, webrtcH265: true })
    const { rerender } = render(<VideoPlayer {...props265} videoInfo={{ codec: 'H264' }} />)
    await waitFor(() => expect(attachWebRTC).toHaveBeenCalledTimes(1))
    const first = await vi.mocked(attachWebRTC).mock.results[0]!.value
    rerender(<VideoPlayer {...props265} videoInfo={{ codec: 'HEVC', level: '4' }} />)
    await waitFor(() => expect(attachWebRTC).toHaveBeenCalledTimes(2))
    expect(first.close).toHaveBeenCalled()
  })
})
