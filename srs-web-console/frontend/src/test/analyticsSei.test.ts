import { describe, expect, it } from 'vitest'
import { parseSeiJson } from '@/components/player/seiDetections'
describe('tracking SEI compatibility', () => {
  const detection = { c: 0, n: 'person', p: null, b: [10,20,30,40], l: 'person' }
  it('preserves session-qualified identity and unknown confidence', () => {
    const frame = parseSeiJson(JSON.stringify({ det: [{...detection, t: 'channel:session:17'}] }))
    expect(frame?.detections[0]!.track_id).toBe('channel:session:17')
    expect(frame?.detections[0]!.confidence).toBeNull()
  })
  it('accepts legacy detections without a track', () => {
    expect(parseSeiJson(JSON.stringify({ det: [detection] }))?.detections[0]!.track_id).toBeUndefined()
  })
  it('ignores oversized identity without dropping the real detection', () => {
    const frame = parseSeiJson(JSON.stringify({ det: [{...detection, t: 'x'.repeat(257)}] }))
    expect(frame?.detections).toHaveLength(1)
    expect(frame?.detections[0]!.track_id).toBeUndefined()
  })
})
