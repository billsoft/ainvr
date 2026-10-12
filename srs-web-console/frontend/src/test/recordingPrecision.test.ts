import { expect, it } from 'vitest'
import { recordingDisplayBlocks } from '@/utils/recording'
import type { RecordingSegment } from '@/types/recording'
const segment = (start: number, end: number, precision = 1000) => ({
  channelId: 'a', startTs: start, endTs: end, playable: true,
  startPrecisionMs: precision,
} as RecordingSegment)
it('joins legacy subsecond uncertainty but preserves precise and large gaps', () => {
  expect(recordingDisplayBlocks([segment(0, 66666), segment(67000, 133666)], [])).toHaveLength(1)
  expect(recordingDisplayBlocks([segment(0, 66666, 1), segment(67000, 133666, 1)], [])).toHaveLength(2)
  expect(recordingDisplayBlocks([segment(0, 66666), segment(68000, 134666)], [])).toHaveLength(2)
})
it('does not bridge a known drop or a different channel', () => {
  const rows = [segment(0, 66666), segment(67000, 133666)]
  expect(recordingDisplayBlocks(rows, [{startTs:66666, endTs:67000, droppedMs:334, reason:'backlog'}])).toHaveLength(2)
  expect(recordingDisplayBlocks([rows[0]!, {...rows[1]!, channelId:'b'}], [])).toHaveLength(2)
})
