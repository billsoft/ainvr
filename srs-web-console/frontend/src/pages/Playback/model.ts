import type { RecordingSegment } from '@/types/recording'
import { DAY_MS, findSegmentAt, segmentsInRange } from '@/utils/recording'

export interface PlaybackRange { from: number; to: number; preset: string | null }
export const initialRange = (now = Date.now()): PlaybackRange => ({ from: now - DAY_MS, to: now, preset: '天' })

/** Half-open range; one deterministic resolver for every playback action. */
export function resolvePlayback(segments: RecordingSegment[], ts: number, range: PlaybackRange) {
  const candidates = segmentsInRange(segments, range.from, range.to).filter(s => s.playable)
  const target = Math.max(range.from, Math.min(range.to - 1, ts))
  let segment = findSegmentAt(candidates, target)
  if (!segment) {
    segment = candidates.reduce<RecordingSegment | null>((best, item) => {
      const distance = (s: RecordingSegment) => Math.abs(Math.max(s.startTs, Math.min(s.endTs - 1, target)) - target)
      return !best || distance(item) < distance(best) ? item : best
    }, null)
  }
  if (!segment) return null
  const absolute = Math.max(range.from, segment.startTs, Math.min(target, range.to - 1, segment.endTs - 1))
  return { segment, absolute, offsetMs: absolute - segment.startTs }
}

export function seiMarks(segments: RecordingSegment[]) {
  return segments.flatMap(segment => (segment.seiRanges ?? []).map(([from, to]) => ({
    start: segment.startTs + from, end: Math.min(segment.endTs, segment.startTs + to),
  })))
}

/** Calendar-aligned ticks: never stretch a long window or label different dates alike. */
export function timelineTicks(from: number, to: number, width: number) {
  const span = to - from
  const max = Math.max(2, Math.floor((width || 720) / 110))
  const minute = 60_000
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(n => n * minute)
  const step = steps.find(s => span / s <= max)
  const ticks: { ts: number; label: string }[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  if (step) {
    const anchor = new Date(from); anchor.setHours(0, 0, 0, 0)
    for (let ts = anchor.getTime() + Math.ceil((from - anchor.getTime()) / step) * step; ts <= to; ts += step) {
      const d = new Date(ts)
      const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
      ticks.push({ ts, label: span <= 6 * 3600_000 ? clock : step < DAY_MS ? `${date} ${clock}` : `${d.getFullYear()}-${date}` })
    }
  } else {
    const months = Math.max(1, Math.ceil(span / (30 * DAY_MS) / max))
    const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0)
    while (d.getTime() < from) d.setMonth(d.getMonth() + 1)
    while (d.getTime() <= to && ticks.length <= max + 2) {
      ticks.push({ ts: d.getTime(), label: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` })
      d.setMonth(d.getMonth() + months)
    }
  }
  return ticks
}
