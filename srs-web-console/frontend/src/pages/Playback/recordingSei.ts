import { overlayHoldMs } from '@/components/player/overlayPresentation'
import { parseSeiJson, type SeiFrameDetections } from '@/components/player/seiDetections'

export interface RecordingSeiFrame {
  timeMs: number
  result: SeiFrameDetections
}

export function parseRecordingSei(raw: unknown): RecordingSeiFrame[] {
  if (!raw || typeof raw !== 'object' || !('frames' in raw) || !Array.isArray(raw.frames)) {
    throw new Error('无效的录像识别数据')
  }
  return raw.frames.flatMap((f: { timeMs?: unknown; payload?: unknown }) => {
    if (!f || typeof f.timeMs !== 'number' || !Number.isFinite(f.timeMs)) return []
    const result = parseSeiJson(JSON.stringify(f.payload) ?? '')
    return result ? [{ timeMs: f.timeMs, result }] : []
  }).sort((a, b) => a.timeMs - b.timeMs)
}

/** Same bounded cadence-adaptive past-only hold as live preview, on the media timeline. */
export function pickRecordingSei(frames: RecordingSeiFrame[], mediaMs: number): SeiFrameDetections | null {
  let lo = 0
  let hi = frames.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (frames[mid]!.timeMs <= mediaMs) lo = mid + 1
    else hi = mid
  }
  let index = lo - 1
  while (index >= 0 && frames[index]!.result.inferred === false) index--
  const f = frames[index]
  if (!f) return null
  const intervals: number[] = []
  let previous = f.timeMs
  for (let i = index - 1; i >= 0 && intervals.length < 8; i--) {
    if (frames[i]!.result.inferred === false) continue
    const delta = previous - frames[i]!.timeMs
    if (delta > 0) intervals.push(delta)
    previous = frames[i]!.timeMs
  }
  const hold = overlayHoldMs(intervals)
  if (mediaMs - f.timeMs > hold) return null
  return { ...f.result, displayAgeMs: mediaMs - f.timeMs, displayHoldMs: hold }

}
