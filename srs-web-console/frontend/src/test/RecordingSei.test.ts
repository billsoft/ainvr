import { describe, expect, it } from 'vitest'
import { parseRecordingSei, pickRecordingSei } from '@/pages/Playback/recordingSei'

const frames = parseRecordingSei({ frames: [
  { timeMs: 1000, payload: { v: 1, pts: 999999999999, det: [{ c: 1, n: 'face', p: .9, b: [10, 20, 30, 40], k: [[11, 22]] }] } },
  { timeMs: 1200, payload: { v: 1, det: [] } },
  { timeMs: 1500, payload: { v: 1, det: [{ n: 'face', b: [1, 2, 3, 4] }] } },
] })

describe('recording SEI follows media time', () => {
  it('shares compact detection and landmark parsing with live', () => {
    expect(frames[0]!.result.detections[0]!.bbox).toEqual({ x: 10, y: 20, w: 30, h: 40 })
    expect(frames[0]!.result.detections[0]!.landmarks).toEqual([{ x: 11, y: 22 }])
  })
  it('never uses future results or embedded live PTS', () => {
    expect(pickRecordingSei(frames, 999)).toBeNull()
    expect(pickRecordingSei(frames, 1100)?.detections).toHaveLength(1)
  })
  it('explicit empty clears immediately; skipped frames hold at most 300ms', () => {
    expect(pickRecordingSei(frames, 1200)?.detections).toHaveLength(0)
    expect(pickRecordingSei(frames, 1800)?.detections).toHaveLength(1)
    expect(pickRecordingSei(frames, 1801)).toBeNull()
  })
  it('supports backward seek and pause without a wall-clock expiry', () => {
    expect(pickRecordingSei(frames, 1500)?.detections[0]!.bbox.x).toBe(1)
    expect(pickRecordingSei(frames, 1000)?.detections[0]!.bbox.x).toBe(10)
    expect(pickRecordingSei(frames, 1000)).toEqual(pickRecordingSei(frames, 1000))
    expect(pickRecordingSei([], 1000)).toBeNull()
  })
})
