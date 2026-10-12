/**
 * AiDetectionOverlay 的**逐帧精确路径**行为锁定。
 *
 * 锁定的是"框比人先到"的根治改动（2026-09-17）：叠加层不再用墙钟猜当前画面
 * 是哪一帧，而是按 requestVideoFrameCallback 给出的 rtpTimestamp，取**这一帧
 * 自己携带的 SEI** 里的检测结果来画。关键不变量：
 *   1. 取的必须是"正在显示的那一帧"的结果，不是"最近收到的那一帧"的——
 *      两者之间隔着解码+抖动缓冲，用后者等于把超前误差原样保留下来；
 *   2. 拿不到逐帧结果时不画不可信的框：没有 SEI 通道（非 WebRTC、浏览器不支持
 *      Encoded Transform）→ 不画；有 SEI 但 rVFC 不给 rtpTimestamp → 走近似对齐
 *      （按到达时刻 + 实测延迟取帧，设计 §8.2），模式如实上报给播放器显示；
 *   3. 会话重建时旧帧的结果必须失效。
 *
 * canvas 2D context 在 jsdom 下不可用，所以这里不校验像素，而是校验
 * "叠加层向 getSeiForFrame 要的是哪一帧的结果"——这正是本次改动的核心语义。
 */
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiDetectionOverlay } from '@/components/player/AiDetectionOverlay'

afterEach(cleanup)

describe('live overlay expiry', () => {
  it('draws a held result, then clears it after expiry even if video stops presenting', () => {
    let now = 1000
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.set(++next, cb); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    const strokeRect = vi.fn()
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), strokeRect,
      measureText: () => ({ width: 10 }), fillRect: vi.fn(), fillText: vi.fn(), globalAlpha: 1 }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    try {
      const v = makeVideo()
      vi.spyOn(v.el, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 200 } as DOMRect)
      render(<AiDetectionOverlay video={v.el} enabled getSeiForFrame={() => ({
        displayAgeMs: 200,
        detections: [{ class_id: 0, class_name: 'face', confidence: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } }],
      })} />)
      const draw = () => { const pending = [...callbacks]; callbacks.clear(); pending.forEach(([, cb]) => cb(now)) }
      v.present(9000)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      now = 1101
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      expect(context.clearRect).toHaveBeenCalledTimes(2)
    } finally {
      cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
})

/** 造一个能被 rVFC 驱动的假 video：手动 emit 帧，精确控制"正在显示哪一帧"。
 *  cancelVideoFrameCallback 必须真的注销（用 handle 索引），否则组件卸载/
 *  会话重建后残留的旧回调会被当成活跃订阅，测出来的语义跟浏览器对不上。 */
function makeVideo() {
  const cbs = new Map<number, VideoFrameRequestCallback>()
  let nextHandle = 1
  const v = document.createElement('video')
  v.requestVideoFrameCallback = (cb) => {
    const h = nextHandle++
    cbs.set(h, cb)
    return h
  }
  v.cancelVideoFrameCallback = (h) => { cbs.delete(h) }
  Object.defineProperty(v, 'videoWidth', { value: 3840, configurable: true })
  Object.defineProperty(v, 'videoHeight', { value: 1920, configurable: true })
  /** 浏览器给的完整 metadata；本组用例只关心 rtpTimestamp，其余按真实字段填占位 */
  const meta = (rtpTimestamp: number | undefined, expectedDisplayTime = 0): VideoFrameCallbackMetadata => ({
    presentationTime: 0,
    expectedDisplayTime,
    width: 3840,
    height: 1920,
    mediaTime: 0,
    presentedFrames: 0,
    processingDuration: 0,
    rtpTimestamp,
  })
  return {
    el: v,
    /** 模拟"这一帧出画了"：喂给当前所有活跃订阅（浏览器就是这个语义） */
    present(rtpTimestamp: number) {
      for (const [h, cb] of [...cbs]) {
        cbs.delete(h)                       // rVFC 是一次性的，回调后需重新订阅
        cb(performance.now(), meta(rtpTimestamp))
      }
    },
    /** 不给 rtpTimestamp 的浏览器（设计 §8.2 的"近似"前提） */
    presentWithoutRtp(expectedDisplayTime: number) {
      for (const [h, cb] of [...cbs]) {
        cbs.delete(h)
        const m = meta(undefined, expectedDisplayTime) as Partial<VideoFrameCallbackMetadata>
        delete m.rtpTimestamp
        cb(performance.now(), m as VideoFrameCallbackMetadata)
      }
    },
    pending: () => cbs.size,
  }
}

describe('AiDetectionOverlay 逐帧精确路径（读当前显示帧自带的 SEI）', () => {
  it('按"正在显示的那一帧"的 rtpTimestamp 取结果，而不是最近收到的那一帧', () => {
    const asked: number[] = []
    const getSeiForFrame = vi.fn((rtp: number) => {
      asked.push(rtp)
      return { detections: [] }
    })
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={getSeiForFrame}
      />,
    )
    // 解码侧可能已经收到 9000/12000 了，但出画的是 3000 → 必须问 3000
    v.present(3000)
    v.present(6000)
    expect(asked).toEqual([3000, 6000])
  })

  it('每出一帧就重新问一次，rVFC 回调持续续订（不是只跑一帧就停）', () => {
    const getSeiForFrame = vi.fn(() => ({ detections: [] }))
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={getSeiForFrame}
      />,
    )
    for (let i = 1; i <= 5; i++) v.present(i * 3000)
    expect(getSeiForFrame).toHaveBeenCalledTimes(5)
    expect(v.pending()).toBe(1) // 永远挂着下一帧的订阅
  })

  it('不传 getSeiForFrame（非 WebRTC / 浏览器不支持）时不订阅 rVFC，也不画不可信的框', () => {
    const v = makeVideo()
    render(<AiDetectionOverlay video={v.el} enabled />)
    expect(v.pending()).toBe(0)
  })

  it('浏览器没有 requestVideoFrameCallback 时不崩，静默走回退路径', () => {
    const plain = document.createElement('video')
    const getSeiForFrame = vi.fn(() => ({ detections: [] }))
    expect(() =>
      render(
        <AiDetectionOverlay
          video={plain} enabled getSeiForFrame={getSeiForFrame}
        />,
      ),
    ).not.toThrow()
    expect(getSeiForFrame).not.toHaveBeenCalled()
  })

  it('某一帧查不到 SEI 时不抛错，下一帧照常继续问', () => {
    const getSeiForFrame = vi.fn((rtp: number) => (rtp === 6000 ? null : { detections: [] }))
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={getSeiForFrame}
      />,
    )
    expect(() => { v.present(3000); v.present(6000); v.present(9000) }).not.toThrow()
    expect(getSeiForFrame).toHaveBeenCalledTimes(3)
  })

  it('enabled=false 时不订阅 rVFC（关掉识别框就不该有任何每帧开销）', () => {
    const getSeiForFrame = vi.fn(() => ({ detections: [] }))
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled={false} getSeiForFrame={getSeiForFrame}
      />,
    )
    expect(v.pending()).toBe(0)
  })

  it('会话重建（resetKey 变化）后重新订阅，旧订阅不再累加调用', () => {
    const getSeiForFrame = vi.fn(() => ({ detections: [] }))
    const v = makeVideo()
    const { rerender } = render(
      <AiDetectionOverlay
        video={v.el} enabled
        getSeiForFrame={getSeiForFrame} resetKey={1}
      />,
    )
    v.present(3000)
    expect(getSeiForFrame).toHaveBeenCalledTimes(1)
    rerender(
      <AiDetectionOverlay
        video={v.el} enabled
        getSeiForFrame={getSeiForFrame} resetKey={2}
      />,
    )
    // 重建后仍然只有一个活跃订阅在问，不会一帧问两次
    const before = getSeiForFrame.mock.calls.length
    v.present(6000)
    expect(getSeiForFrame.mock.calls.length).toBe(before + 1)
  })
})

describe('AiDetectionOverlay 叠框模式（设计 §8.2：逐帧 / 近似 / 不可用）', () => {
  it('rVFC 给 rtpTimestamp → 逐帧，上报 exact，不碰近似路径', () => {
    const getSeiApprox = vi.fn(() => ({ detections: [] }))
    const onMode = vi.fn()
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={() => ({ detections: [] })}
        getSeiApprox={getSeiApprox} onMode={onMode}
      />,
    )
    v.present(3000)
    v.present(6000)
    expect(onMode).toHaveBeenCalledTimes(1)
    expect(onMode).toHaveBeenCalledWith('exact')
    expect(getSeiApprox).not.toHaveBeenCalled()
  })

  it('rVFC 不给 rtpTimestamp → 近似：按该帧的预计显示时刻取，上报 approx', () => {
    const asked: number[] = []
    const getSeiApprox = vi.fn((displayMs: number) => {
      asked.push(displayMs)
      return { detections: [] }
    })
    const getSeiForFrame = vi.fn(() => ({ detections: [] }))
    const onMode = vi.fn()
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={getSeiForFrame}
        getSeiApprox={getSeiApprox} onMode={onMode}
      />,
    )
    v.presentWithoutRtp(1040)
    v.presentWithoutRtp(1080)
    expect(asked).toEqual([1040, 1080])
    expect(getSeiForFrame).not.toHaveBeenCalled()
    expect(onMode).toHaveBeenCalledTimes(1)
    expect(onMode).toHaveBeenCalledWith('approx')
  })

  it('没有 rVFC 但有近似取数 → 每个动画帧按当前时刻取（设计 §8.2 第 3 步）', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    try {
      const getSeiApprox = vi.fn(() => ({ detections: [] }))
      const onMode = vi.fn()
      render(
        <AiDetectionOverlay
          video={document.createElement('video')} enabled
          getSeiApprox={getSeiApprox} onMode={onMode}
        />,
      )
      const run = () => frames.splice(0).forEach((cb) => cb(500))
      run()
      run()
      expect(getSeiApprox).toHaveBeenCalledWith(500)
      expect(onMode).toHaveBeenCalledWith('approx')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('近似还没得到延迟估计（返回 null）时不画、也不上报模式', () => {
    const onMode = vi.fn()
    const v = makeVideo()
    render(
      <AiDetectionOverlay
        video={v.el} enabled getSeiForFrame={() => null}
        getSeiApprox={() => null} onMode={onMode}
      />,
    )
    v.presentWithoutRtp(1000)
    expect(onMode).not.toHaveBeenCalled()
  })
})
