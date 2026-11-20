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
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiDetectionOverlay } from '@/components/player/AiDetectionOverlay'

afterEach(cleanup)

describe('点选已绘制的 SEI 识别框', () => {
  it.each([
    { w: 3840, h: 1920, nested: [140, 170], outer: [220, 210], bar: [140, 90] },
    { w: 1920, h: 3840, nested: [170, 140], outer: [210, 220], bar: [90, 140] },
  ])('按 $w × $h 原图命中、消歧并校验当前帧', async ({ w, h, nested, outer, bar }) => {
    const user = userEvent.setup()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.set(++next, cb); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    const draw = () => {
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach(cb => cb(now))
    }
    const colors: string[] = []
    const ctx = { strokeStyle: '', setTransform: vi.fn(), clearRect: vi.fn(),
      strokeRect() { colors.push(this.strokeStyle) }, measureText: () => ({ width: 20 }),
      fillRect: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      const v = makeVideo()
      Object.defineProperties(v.el, { videoWidth: { value: w }, videoHeight: { value: h }, paused: { value: false } })
      const rect = { left: -50, top: 70, width: 400, height: 400 } as DOMRect
      vi.spyOn(v.el, 'getBoundingClientRect').mockReturnValue(rect)
      const box = (at: number, size: number) => ({ x: w * at, y: h * at, w: w * size, h: h * size })
      const base = { class_id: 1, class_name: 'object', confidence: 1 }
      const selected = 'cam:model:4:1'
      const detections = [
        { ...base, track_id: 'cam:outer', bbox: box(-1, 2) },
        { ...base, track_id: selected, bbox: box(0.3, 0.1) },
        { ...base, track_id: 'pred', predicted: true, bbox: box(0.34, 0.02) },
        { ...base, track_id: 'low', lowConfidence: true, bbox: box(0.34, 0.02) },
        { ...base, bbox: box(0.34, 0.02) },
      ]
      const innerDetection = detections[1]!
      const frames = [[], detections, [], [{ ...innerDetection, track_id: 'cam:model:5:1' }],
        [innerDetection, innerDetection], [{ ...innerDetection, predicted: true }],
        [{ ...innerDetection, lowConfidence: true }]]
      const getSeiForFrame = (rtp: number) => ({ detections: frames[rtp] ?? [] })
      const onPick = vi.fn()
      const overlay = (selectedId?: string | null, pickEnabled?: boolean) => <AiDetectionOverlay video={v.el} enabled
        getSeiForFrame={getSeiForFrame} trackPicking={selectedId === undefined ? null : { selectedId, pickEnabled, onPick }} />
      const playerClick = vi.fn()
      const player = (id?: string | null, pickEnabled?: boolean) => <div onClick={playerClick}>{overlay(id, pickEnabled)}</div>
      const view = render(player(null))
      const canvas = screen.getByTestId('ai-detection-overlay')
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect)
      const click = ([x = 0, y = 0]: number[]) => fireEvent.click(canvas, { clientX: rect.left + x, clientY: rect.top + y })
      v.present(1)
      click(nested)
      expect(onPick).not.toHaveBeenCalled()
      draw()
      click(bar)
      expect(onPick).not.toHaveBeenCalled()
      click(nested)
      const popup = () => screen.getByRole('menu', { name: '选择跟踪目标' })
      const inner = () => screen.getByRole('menuitem', { name: 'object #1' })
      expect(screen.getAllByRole('menuitem')).toHaveLength(2)
      expect(onPick).not.toHaveBeenCalled()
      expect(popup().parentElement).toHaveStyle(w > h
        ? { left: '0%', top: '25%', width: '100%', height: '50%' }
        : { left: '25%', top: '0%', width: '50%', height: '100%' })
      expect(screen.getByRole('menuitem', { name: 'object #outer' })).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(inner()).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(onPick).toHaveBeenLastCalledWith(selected)
      expect(screen.queryByRole('menu')).toBeNull()
      view.rerender(player(selected))
      draw()
      expect(colors.slice(-5)).toEqual(['#22c55e', '#7dd3fc', '#22c55e', '#22c55e', '#22c55e'])
      click(nested)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).toBeNull()
      click(nested)
      fireEvent.click(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
      click(nested)
      click(outer) // Dismiss only, even when the outside click hits a single box.
      expect(screen.queryByRole('menu')).toBeNull()
      expect(onPick).toHaveBeenCalledTimes(1)
      click(nested)
      await user.pointer([{ keys: '[TouchA>]', target: inner() }, { keys: '[/TouchA]' }])
      expect(onPick).toHaveBeenCalledTimes(2)
      expect(onPick).toHaveBeenLastCalledWith(selected)
      onPick.mockClear()
      for (const nextFrame of [2, 3, 4, 5, 6]) {
        v.present(1)
        draw()
        click(nested)
        v.present(nextFrame) // New metadata before the next canvas paint.
        fireEvent.click(inner())
        expect(screen.queryByRole('menu')).toBeNull()
        expect(onPick).not.toHaveBeenCalled()
      }
      v.present(2)
      click(outer)
      expect(onPick).not.toHaveBeenCalled()
      v.present(1)
      draw()
      click(outer)
      expect(onPick).toHaveBeenLastCalledWith('cam:outer')
      v.present(2)
      draw()
      click(outer)
      expect(onPick).toHaveBeenCalledTimes(1)
      view.rerender(player('cam:outer'))
      v.present(1)
      draw()
      expect(colors.slice(-5, -3)).toEqual(['#7dd3fc', '#22c55e'])
      click(nested)
      v.el.currentTime += 2
      fireEvent.click(inner())
      expect(onPick).toHaveBeenCalledTimes(1)
      v.present(1)
      draw()
      click(nested)
      now += 1001
      fireEvent.click(inner())
      click(outer)
      expect(onPick).toHaveBeenCalledTimes(1)
      view.rerender(player(selected))
      v.present(1)
      draw()
      click(nested)
      expect(popup()).toBeVisible()
      const staleItem = inner()
      view.rerender(player(selected, false))
      draw()
      expect(colors.slice(-5)[1]).toBe('#7dd3fc')
      expect(screen.queryByRole('menu')).toBeNull()
      expect(canvas).toHaveClass('pointer-events-none')
      fireEvent.click(staleItem)
      click(nested)
      click(outer)
      expect(screen.queryByRole('menu')).toBeNull()
      expect(playerClick).toHaveBeenCalledTimes(2)
      expect(onPick).toHaveBeenCalledTimes(1)
      expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true)
      playerClick.mockClear()

      // Missing, reused short ID, duplicate ID, prediction, low confidence, then reacquisition.
      for (const frame of [2, 3, 4, 5, 6, 1]) {
        colors.length = 0
        v.present(frame)
        draw()
        expect(colors).toHaveLength(frames[frame]!.length)
        expect(colors.filter(color => color === '#7dd3fc')).toHaveLength(frame === 1 ? 1 : 0)
      }
      now += 1001
      colors.length = 0
      draw()
      expect(colors).toEqual([])
      view.rerender(player(selected, true))
      expect(screen.queryByRole('menu')).toBeNull()
      view.rerender(player())
      expect(screen.queryByRole('menu')).toBeNull()
      v.present(1)
      draw()
      expect(colors.slice(-5)).toEqual(Array(5).fill('#22c55e'))
      expect(canvas).toHaveClass('pointer-events-none')
      expect(playerClick).not.toHaveBeenCalled()
      click(nested)
      expect(playerClick).toHaveBeenCalledTimes(1)
      expect(onPick).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
})

describe('live overlay expiry', () => {
  it('distinguishes a stalled video from missing overlays and ignores user pause', () => {
    vi.useFakeTimers()
    try {
      const v = makeVideo()
      Object.defineProperty(v.el, 'paused', { value: false, configurable: true })
      render(<AiDetectionOverlay video={v.el} enabled getSeiForFrame={() => null} />)
      act(() => { vi.advanceTimersByTime(3500) })
      expect(screen.getByRole('status')).toHaveTextContent('播放画面暂时停滞')
      act(() => { v.el.currentTime = 4; v.present(90000); vi.advanceTimersByTime(500) })
      expect(screen.getByRole('status')).toHaveTextContent('未与画面对齐')
      Object.defineProperty(v.el, 'paused', { value: true, configurable: true })
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.queryByRole('status')).toBeNull()
    } finally { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() }
  })
  it('hides every box consistently while preserving the independent trail path', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.set(++next, cb); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    const strokeRect = vi.fn()
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), strokeRect,
      measureText: () => ({ width: 10 }), fillRect: vi.fn(), fillText: vi.fn(), setLineDash: vi.fn(), globalAlpha: 1 }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    try {
      const v = makeVideo()
      vi.spyOn(v.el, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 200 } as DOMRect)
      const base = { class_id: 0, class_name: 'person', confidence: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } }
      const detections = [base, { ...base, predicted: true }, { ...base, lowConfidence: true }]
      const projected = vi.fn()
      const view = render(<AiDetectionOverlay video={v.el} enabled showDetections={false}
        getSeiForFrame={() => ({ detections })} />)
      v.present(9000)
      const draw = () => { const pending = [...callbacks]; callbacks.clear(); pending.forEach(([, cb]) => cb(performance.now())) }
      draw()
      expect(strokeRect).not.toHaveBeenCalled()
      view.rerender(<AiDetectionOverlay video={v.el} enabled showDetections={false}
        getSeiForFrame={() => ({ detections })} drawFrame={projected} />)
      draw()
      expect(projected).toHaveBeenLastCalledWith(context, [], 400, 200, 3840, 1920, undefined, [])
    } finally {
      cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
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
      let missing = false
      let empty = false
      let displayAge = 200
      let pts = 1
      render(<AiDetectionOverlay video={v.el} enabled getSeiForFrame={() => missing ? null : ({
        ptsNs: pts, displayAgeMs: displayAge,
        detections: empty ? [] : [{ class_id: 0, class_name: 'face', confidence: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } }],
      })} />)
      const draw = () => { const pending = [...callbacks]; callbacks.clear(); pending.forEach(([, cb]) => cb(now)) }
      v.present(9000)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      missing = true
      now = 1020
      v.present(10800)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(2)
      now = 1101
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(2)
      expect(context.clearRect).toHaveBeenCalledTimes(3)
      missing = false; displayAge = 0; pts = 500000001; now = 1200
      v.present(18000); draw()
      expect(strokeRect).toHaveBeenCalledTimes(3)
      expect(context.globalAlpha).toBe(1)
      now = 1233; displayAge = 33
      v.present(21000); draw()
      expect(context.globalAlpha).toBe(1)
      expect(strokeRect).toHaveBeenCalledTimes(4)
      missing = true; now = 1600
      v.present(60000); draw()
      expect(strokeRect).toHaveBeenCalledTimes(5)
      missing = false; empty = true; pts = 600000001; displayAge = 0; now = 1640
      v.present(24000); draw()
      expect(strokeRect).toHaveBeenCalledTimes(5)
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

describe("metadata freshness", () => {
  it('repeated timestamp cannot renew expiry; a newer result resumes drawing', () => {
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
      let stamp = 1000000000
      render(<AiDetectionOverlay video={v.el} enabled getSeiForFrame={() => ({
        ptsNs: stamp, displayAgeMs: 200,
        detections: [{ class_id: 0, class_name: 'face', confidence: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } }],
      })} />)
      const draw = () => { const pending = [...callbacks]; callbacks.clear(); pending.forEach(([, cb]) => cb(now)) }
      v.present(9000)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      now = 1050
      v.present(9001)
      now = 1101
      v.present(9002)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      expect(context.clearRect).toHaveBeenCalledTimes(2)
      now = 1200
      v.present(9003)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(1)
      stamp += 1000000000
      v.present(9004)
      draw()
      expect(strokeRect).toHaveBeenCalledTimes(2)
    } finally {
      cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
})
