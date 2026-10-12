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

/** Same 300 ms past-only hold as live preview, on the media timeline. */
export function pickRecordingSei(frames: RecordingSeiFrame[], mediaMs: number): SeiFrameDetections | null {
  let lo = 0
  let hi = frames.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (frames[mid]!.timeMs <= mediaMs) lo = mid + 1
    else hi = mid
  }
  const f = frames[lo - 1]
  if (!f || mediaMs - f.timeMs > 300) return null
  return { ...f.result, displayAgeMs: mediaMs - f.timeMs }
}
