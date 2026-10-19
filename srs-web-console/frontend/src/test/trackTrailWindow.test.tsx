/**
 * 轨迹是滑动窗口：尾部按时间擦除、头部接新位置，不因“当前显示帧没有匹配到识别结果”
 * 或近似对齐的小幅时间回退而整条消失。
 */
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiDetectionOverlay } from '@/components/player/AiDetectionOverlay'
import { TrackTrailBuffer } from '@/components/player/trackTrails'
import type { AiDetection } from '@/types/aiChannel'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const box = (x: number): AiDetection => ({ class_id: 0, class_name: 'person', confidence: 0.9, track_id: 's:1', bbox: { x, y: 10, w: 20, h: 30 } })

describe('trail buffer is a sliding window', () => {
  it('ignores a small backward step (approximate alignment re-estimate) instead of clearing', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0, [box(0)]); cache.update(1e8, [box(10)]); cache.update(2e8, [box(20)])
    // Re-estimated display delay maps to a result 0.15 s older:stale, dropped, trail kept.
    expect(cache.update(0.5e8, [box(5)])[0]!.points.map(p => p.ptsNs)).toEqual([0, 1e8, 2e8])
    expect(cache.update(3e8, [box(30)])[0]!.points).toHaveLength(4)
  })
  it('clears on a large backward jump (seek or restart) and on a long stall', () => {
    const cache = new TrackTrailBuffer()
    cache.update(20e9, [box(0)]); cache.update(20.1e9, [box(1)])
    expect(cache.update(10e9, [box(2)])[0]!.points.map(p => p.ptsNs)).toEqual([10e9])
    expect(cache.update(20e9, [box(3)])[0]!.points.map(p => p.ptsNs)).toEqual([20e9])
  })
  it('scrolls:old points fall off the tail one by one while the trail stays continuous', () => {
    const cache = new TrackTrailBuffer()
    let first: number[] = []
    for (let i = 0; i <= 200; i++) {
      const trail = cache.update(i * 1e8, [box(i % 300)])[0]!
      if (i >= 50) {
        const oldest = trail.points[0]!.ptsNs
        expect(oldest).toBeGreaterThanOrEqual(i * 1e8 - 5e9)     // only the last 5 s per target
        expect(trail.points.length).toBeGreaterThanOrEqual(50)    // never collapses
        first.push(oldest)
      }
    }
    expect(first.every((v, k) => k === 0 || v > first[k - 1]!)).toBe(true)  // tail advances monotonically
  })
})

describe('a trail lives exactly as long as its target', () => {
  const other = (x: number): AiDetection => ({ ...box(x), track_id: 's:2' })
  it('erases the trail of a target as soon as a newer result no longer contains it;others stay', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0, [box(0), other(100)]); cache.update(1e8, [box(10), other(110)])
    const trails = cache.update(2e8, [other(120)])
    expect(trails.map(t => t.id)).toEqual(['s:2'])
    expect(trails[0]!.points).toHaveLength(3)
    expect(cache.update(3e8, [])).toEqual([])
    // A target that comes back starts a fresh trail.
    expect(cache.update(4e8, [box(40)])[0]!.points).toHaveLength(1)
  })
  it('a short-loss predicted box keeps the trail;it ends when the prediction ends', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0, [box(0)]); cache.update(1e8, [box(10)])
    const coasting = cache.update(2e8, [{ ...box(20), confidence: null, predicted: true }])
    expect(coasting[0]!.points.map(p => !!p.predicted)).toEqual([false, false, true])
    expect(cache.update(3e8, [])).toEqual([])
  })
})

describe('live overlay draws trails independently of the current frame match', () => {
  it('keeps drawing the trail through unmatched/expired frames, drops it after the stream goes quiet', () => {
    let now = 1000
    const frames = new Map<number, FrameRequestCallback>()
    let next = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const stroke = vi.fn(), strokeRect = vi.fn()
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), strokeRect, stroke, beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), setLineDash: vi.fn(), measureText: () => ({ width: 10 }), fillRect: vi.fn(), fillText: vi.fn(), globalAlpha: 1 }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const rvfc = new Map<number, VideoFrameRequestCallback>()
    let handle = 1
    const v = document.createElement('video')
    v.requestVideoFrameCallback = (cb) => { const h = handle++; rvfc.set(h, cb); return h }
    v.cancelVideoFrameCallback = (h) => { rvfc.delete(h) }
    Object.defineProperty(v, 'videoWidth', { value: 1000 }); Object.defineProperty(v, 'videoHeight', { value: 1000 })
    vi.spyOn(v, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 400 } as DOMRect)
    const results = new Map<number, { ptsNs: number; detections: AiDetection[] }>()
    for (let i = 1; i <= 3; i++) results.set(i, { ptsNs: i * 1e8, detections: [box(i * 10)] })
    render(<AiDetectionOverlay video={v} enabled showTrails getSeiForFrame={(rtp) => results.get(rtp) ?? null} />)
    const present = (rtp: number) => { for (const [h, cb] of [...rvfc]) { rvfc.delete(h); cb(now, { rtpTimestamp: rtp } as VideoFrameCallbackMetadata) } }
    const draw = () => { const pending = [...frames]; frames.clear(); pending.forEach(([, cb]) => cb(now)) }
    for (let i = 1; i <= 3; i++) { present(i); now += 40 }
    draw()
    const withMatch = stroke.mock.calls.length
    expect(withMatch).toBeGreaterThan(0)
    // Frames without their own result:the box expires, the trail must not vanish.
    present(99); now += 500; draw()
    expect(stroke.mock.calls.length).toBeGreaterThan(withMatch)
    expect(strokeRect).toHaveBeenCalledTimes(1)
    // No result for over a second (stream stalled/stopped):trail is no longer drawn.
    const before = stroke.mock.calls.length
    now += 1100; present(100); draw()
    expect(stroke.mock.calls.length).toBe(before)
  })
})
