import { expect, it } from 'vitest'
import { initialRange, resolvePlayback, seiMarks, timelineTicks } from '@/pages/Playback/model'
import type { RecordingSegment } from '@/types/recording'
import { DAY_MS, mergeContiguous } from '@/utils/recording'
const segment = (id: string, startTs: number, endTs: number) => ({ id, startTs, endTs, playable: true } as RecordingSegment)

it('defaults to a trailing 24 hours with the day preset selected', () => {
  expect(initialRange(2 * DAY_MS)).toEqual({ from: DAY_MS, to: 2 * DAY_MS, preset: '天' })
})
it('clips boundary files, preserves gaps, and resolves all seeks deterministically', () => {
  const segments = [segment('a', 0, 100), segment('b', 120, 200), segment('c', 400, 500)]
  const range = { from: 50, to: 150, preset: null }
  expect(resolvePlayback(segments, 0, range)?.absolute).toBe(50)
  expect(resolvePlayback(segments, 140, range)?.segment.id).toBe('b')
  expect(resolvePlayback(segments, 190, range)?.absolute).toBe(149)
  expect(resolvePlayback(segments, 115, range)?.absolute).toBe(120)
  expect(mergeContiguous(segments, 0)).toHaveLength(3)
})
it('never substitutes AI channel metadata for embedded SEI coverage', () => {
  expect(seiMarks([{ ...segment('a', 100, 200), seiPresent: true }])).toEqual([])
  expect(seiMarks([{ ...segment('a', 100, 200), seiRanges: [[10, 20]] }])).toEqual([{ start: 110, end: 120 }])
})
it('keeps long ranges bounded and labels calendar dates unambiguously', () => {
  const from = new Date('2024-01-01').getTime(), to = new Date('2027-01-01').getTime()
  const ticks = timelineTicks(from, to, 800)
  expect(ticks.length).toBeLessThanOrEqual(9)
  expect(new Set(ticks.map(t => t.label)).size).toBe(ticks.length)
  expect(ticks.every(t => t.ts >= from && t.ts <= to)).toBe(true)
})
