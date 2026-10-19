import { describe, expect, it } from 'vitest'
import { parseSeiJson } from '@/components/player/seiDetections'
import { drawDetections } from '@/components/player/detectionDrawing'
import { computeContainLayout } from '@/components/player/overlayGeometry'
import { TrackTrailBuffer, trailSegments } from '@/components/player/trackTrails'
import { DEFAULT_WIZARD_VALUE, applyModelPreset, toCreatePatch, validateVisibleAnalytics } from '@/features/aiChannelForm'
import type { AiDetection } from '@/types/aiChannel'

const real = (x = 10): AiDetection => ({ class_id: 0, class_name: 'person', confidence: 0.9, track_id: 's:1', bbox: { x, y: 10, w: 20, h: 30 } })
const predicted = (x = 30): AiDetection => ({ ...real(x), confidence: null, predicted: true })

function recordingContext() {
  const calls: { op: string; args: unknown[] }[] = []
  const ctx = new Proxy({}, {
    get: (_t, op: string) => op === 'measureText' ? () => ({ width: 40 }) :
      (...args: unknown[]) => { calls.push({ op, args }) },
    set: (_t, op: string, value) => { calls.push({ op: `=${op}`, args: [value] }); return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

describe('short-loss coasting (display only)', () => {
  it('parses the SEI prediction flag;observed boxes stay unflagged', () => {
    const frame = parseSeiJson(JSON.stringify({ det: [
      { c: 0, n: 'person', p: 0.9, t: 's:1', b: [1, 2, 3, 4] },
      { c: 0, n: 'person', p: null, t: 's:2', b: [5, 6, 7, 8], pr: 1 },
    ] }))
    expect(frame?.detections[0]!.predicted).toBeUndefined()
    expect(frame?.detections[1]!.predicted).toBe(true)
    expect(frame?.detections[1]!.confidence).toBeNull()
  })

  it('parses low-confidence display boxes and labels them as such', () => {
    const frame = parseSeiJson(JSON.stringify({ det: [{ c: 0, n: 'person', p: null, t: 's:3', b: [1, 2, 3, 4], lc: 1 }] }))
    expect(frame?.detections[0]!.lowConfidence).toBe(true)
    expect(frame?.detections[0]!.predicted).toBeUndefined()
    const { ctx, calls } = recordingContext()
    drawDetections(ctx, frame!.detections, computeContainLayout(100, 100, 100, 100), 100, 100)
    expect(calls.filter(c => c.op === 'setLineDash').map(c => c.args[0])).toContainEqual([6, 4])
    expect(calls.filter(c => c.op === 'fillText').map(c => String(c.args[0]))[0]).toBe('person #3 低置信')
  })

  it('draws predicted boxes dashed and labelled as estimated, observed boxes solid', () => {
    const { ctx, calls } = recordingContext()
    const layout = computeContainLayout(100, 100, 100, 100)
    drawDetections(ctx, [real(), predicted()], layout, 100, 100)
    const dashes = calls.filter(c => c.op === 'setLineDash').map(c => c.args[0])
    expect(dashes).toContainEqual([6, 4])
    expect(dashes.at(-1)).toEqual([])                     // context restored for later drawing
    const labels = calls.filter(c => c.op === 'fillText').map(c => String(c.args[0]))
    expect(labels[0]).toBe('person 90% #1')
    expect(labels[1]).toBe('person #1 推算')               // no confidence for a prediction
  })

  it('keeps prediction flags on trail points and splits dashed segments', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0, [real(10)])
    cache.update(1e8, [predicted(20)])
    const trail = cache.update(2e8, [real(30)])[0]!
    expect(trail.points.map(p => !!p.predicted)).toEqual([false, true, false])
    expect(trailSegments(trail.points).map(s => s.predicted)).toEqual([true, true])
    const solid = cache.update(3e8, [real(40)])[0]!
    expect(trailSegments(solid.points).map(s => s.predicted)).toEqual([true, true, false])
  })

  it('tracking settings accept 0-2 s coasting (default 1 s) and save it', () => {
    const value = { ...applyModelPreset(DEFAULT_WIZARD_VALUE, 'yolo26x'), id: 'gate', name: 'gate',
      streamUrl: 'rtmp://127.0.0.1/live/gate', analytics: { enabled: true } }
    expect(validateVisibleAnalytics(value)).not.toHaveProperty('coastSeconds')
    for (const bad of [-0.1, 2.5, Number.NaN])
      expect(validateVisibleAnalytics({ ...value, analytics: { enabled: true, coast_seconds: bad } })).toHaveProperty('coastSeconds')
    expect(validateVisibleAnalytics({ ...value, analytics: { enabled: true, coast_seconds: 0 } })).not.toHaveProperty('coastSeconds')
    expect(toCreatePatch({ ...value, analytics: { enabled: true, coast_seconds: 1.5 } }).analytics).toMatchObject({ coast_seconds: 1.5 })
  })
})
