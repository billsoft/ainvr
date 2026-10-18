import { describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/locateanythingPointSei.json'
import { extractSeiDetections, parseSeiJson, SeiFrameCache } from '@/components/player/seiDetections'
import { drawGroundingPoints, parseGroundingOverlay } from '@/components/player/groundingPoints'
import { computeContainLayout } from '@/components/player/overlayGeometry'
import { drawPanoramaDetections } from '@/components/player/panoramaDetection'
import { parseRecordingSei, pickRecordingSei } from '@/pages/Playback/recordingSei'

const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map(pair => Number.parseInt(pair, 16)))
const point = fixtures.fixtures.find(f => f.codec === 'h264' && f.kind === 'point')!
const clear = fixtures.fixtures.find(f => f.codec === 'h264' && f.kind === 'clear')!

describe('Original C++ point SEI -> browser and recorded playback', () => {
  it.each(fixtures.fixtures)('reads $codec/$kind actual producer bytes without fake detections', fixture => {
    const parsed = extractSeiDetections(bytes(fixture.annexb_hex))!
    expect(parsed).not.toBeNull()
    expect(parsed.ptsNs).toBe(123000000)
    expect(fixture.uuid_and_payload_bytes).toBeLessThanOrEqual(1024)
    if (fixture.kind === 'legacy') {
      expect(parsed.modelExtra).toBeUndefined()
      expect(parsed.grounding).toBeUndefined()
      expect(parsed.detections).toHaveLength(1)
    } else {
      expect(parsed.modelExtra).toEqual(fixture.payload.model_extra)
      expect(parsed.detections).toHaveLength(fixture.kind === 'mixed' ? 1 : 0)
      expect(parsed.grounding).toBeDefined()
      if (fixture.kind === 'clear') expect(parsed.grounding!.points).toEqual([])
      else {
        expect(parsed.grounding!.points[0]).toEqual({ x: .5, y: .25, class_name: '定位 } "点',
          label_id: 'stable-point', query_description: 'Point to: person.', confidence: null })
        if (fixture.kind === 'budget') {
          expect(parsed.grounding!.omitted).toBeGreaterThan(0)
          expect(parsed.grounding!.points.length + parsed.grounding!.omitted).toBe(40)
        }
      }
    }
  })

  it('binds point-only metadata to the displayed frame;empty inference clears it', () => {
    const cache = new SeiFrameCache()
    const parsed = extractSeiDetections(bytes(point.annexb_hex))!
    cache.put(90000, parsed)
    cache.put(180000, { ...parsed, grounding: { points: [{ ...parsed.grounding!.points[0]!, x: .75 }], omitted: 0 } })
    expect(cache.getForDisplay(90000)!.grounding!.points[0]!.x).toBe(.5)
    expect(cache.getForDisplay(117000)!.displayAgeMs).toBe(300)
    expect(cache.getForDisplay(117001)).toBeNull()
    cache.put(100000, extractSeiDetections(bytes(clear.annexb_hex))!)
    expect(cache.getForDisplay(101000)!.grounding!.points).toEqual([])
  })

  it('preserves the same point and explicit clear on the MP4 media timeline', () => {
    const frames = parseRecordingSei({ frames: [
      { timeMs: 1000, payload: point.payload }, { timeMs: 2000, payload: clear.payload },
    ] })
    expect(pickRecordingSei(frames, 999)).toBeNull()
    expect(pickRecordingSei(frames, 1000)!.grounding!.points[0]!.x).toBe(.5)
    expect(pickRecordingSei(frames, 1301)).toBeNull()
    expect(pickRecordingSei(frames, 2000)!.grounding!.points).toEqual([])
  })
})

describe('Normalized point contract and drawing', () => {
  it('rejects incomplete/unrecognized coordinate spaces and invalid points', () => {
    const valid = { complete: true, coordinate_space: 'normalized_full_frame', points: [
      { x: .5, y: .25, class_name: 'person', confidence: null },
      { x: -1, y: .5 }, { x: 2, y: .5 }, { x: .5, y: NaN }, { x: '0.5', y: .5 },
      { x: .5, y: .5, confidence: Infinity },
    ] }
    expect(parseGroundingOverlay({ grounding: valid })!.points).toHaveLength(1)
    expect(parseGroundingOverlay({ grounding: { ...valid, complete: false } })).toBeUndefined()
    expect(parseGroundingOverlay({ grounding: { ...valid, coordinate_space: 'pixels' } })).toBeUndefined()
    expect(parseSeiJson('{"det":[],"model_extra":[]}')!.modelExtra).toBeUndefined()
  })

  const context = () => ({
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    arc: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 20 })),
  })

  it('places a point in the video content rectangle without drawing a box', () => {
    const ctx = context()
    const grounding = extractSeiDetections(bytes(point.annexb_hex))!.grounding!
    drawGroundingPoints(ctx as unknown as CanvasRenderingContext2D, grounding, computeContainLayout(3840, 2160, 640, 480))
    expect(ctx.arc).toHaveBeenCalledWith(320, 150, 5, 0, 2 * Math.PI)
    expect(ctx.strokeRect).not.toHaveBeenCalled()
    expect(ctx.restore).toHaveBeenCalled()
  })

  it('renders explicit point-budget loss instead of silently hiding it', () => {
    const ctx = context()
    drawGroundingPoints(ctx as unknown as CanvasRenderingContext2D, { points: [], omitted: 5 },
      { offsetX: 0, offsetY: 0, dispW: 640, dispH: 360 })
    expect(ctx.fillText).toHaveBeenCalledWith('另有 5 个定位点未显示', 11, 21)
  })

  it('projects an ERP point with the same camera and rejects the back hemisphere', () => {
    const ctx = context()
    const camera = {
      view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002, -1, 0, 0, -.2, 0],
    }
    drawPanoramaDetections(ctx as unknown as CanvasRenderingContext2D, [], camera, 640, 360, 3840, 1920,
      { points: [{ x: .75, y: .5, class_name: '', confidence: null }, { x: .25, y: .5, class_name: '', confidence: null }], omitted: 0 })
    expect(ctx.arc).toHaveBeenCalledTimes(1)
    const args = ctx.arc.mock.calls[0]!
    expect(args[0]).toBeCloseTo(320); expect(args[1]).toBeCloseTo(180)
    expect(ctx.strokeRect).not.toHaveBeenCalled()
  })
})
