import { describe, expect, it } from 'vitest'
import { SeiFrameCache, type SeiFrameDetections } from '@/components/player/seiDetections'
import { ArrivalTimeline } from '@/components/player/approxAlign'

const result: SeiFrameDetections = {
  ptsNs: 1, ageMs: 0,
  detections: [{ class_id: 0, class_name: 'face', confidence: 0.9, bbox: { x: 1, y: 2, w: 3, h: 4 } }],
}
const skipped = { ptsNs: null, ageMs: null, detections: [], inferred: false }

describe('bounded live SEI continuity', () => {
  it('keeps a past result over uninferred frames, never borrows a future result', () => {
    const cache = new SeiFrameCache()
    cache.put(9000, result)
    cache.put(12000, skipped)
    cache.put(18000, { ...result, ptsNs: 2 })
    expect(cache.getForDisplay(12000)?.ptsNs).toBe(1)
    expect(cache.getForDisplay(12000)?.displayAgeMs).toBeCloseTo(33.333)
    expect(cache.getForDisplay(6000)).toBeNull()
  })
  it('handles skipped presentation callbacks and expires after 300 ms', () => {
    const cache = new SeiFrameCache()
    cache.put(9000, result)
    expect(cache.getForDisplay(27000)?.detections).toHaveLength(1)
    expect(cache.getForDisplay(36001)).toBeNull()
  })
  it('clears on explicit empty inference and on transport reset', () => {
    const cache = new SeiFrameCache()
    cache.put(9000, result)
    cache.put(12000, { ...result, detections: [] })
    expect(cache.getForDisplay(15000)?.detections).toEqual([])
    cache.clear()
    expect(cache.getForDisplay(15000)).toBeNull()
  })
  it('handles 32-bit RTP wrap without accepting a future frame', () => {
    const cache = new SeiFrameCache()
    cache.put(0xfffff000, result)
    expect(cache.getForDisplay(0x1000)?.displayAgeMs).toBeCloseTo(8192 / 90)
    expect(cache.getForDisplay(0xffffe000)).toBeNull()
  })
  it('bounds approximate holds on the original arrival timestamp', () => {
    const timeline = new ArrivalTimeline<SeiFrameDetections>()
    timeline.push(1000, result)
    timeline.push(1033, skipped)
    timeline.push(1400, { ...result, ptsNs: 2 })
    expect(timeline.pickPast(1200, 300, v => v.inferred !== false)?.value.ptsNs).toBe(1)
    expect(timeline.pickPast(1301, 300, v => v.inferred !== false)).toBeNull()
  })
})
