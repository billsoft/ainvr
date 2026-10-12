import { describe, expect, it } from 'vitest'
import {
  adjacentSegment,
  buildSegmentFilename,
  buildSnapshotFilename,
  formatClock,
  formatDurationClock,
  mergeContiguous,
  retentionLabel,
  sanitizeFilePart,
  segmentsInRange,
  findSegmentAt,
} from '@/utils/recording'
import type { RecordingSegment } from '@/types/recording'

const DAY = 86_400_000
const T0 = new Date('2026-09-13T00:00:00').getTime()

function seg(id: string, startMin: number, durMin = 2, playable = true): RecordingSegment {
  return {
    id,
    channelId: 'c1',
    startTs: T0 + startMin * 60_000,
    endTs: T0 + (startMin + durMin) * 60_000,
    durationMs: durMin * 60_000,
    sizeBytes: 1_000_000,
    codec: 'h264',
    hasAudio: true,
    seiPresent: false,
    storage: 'local',
    playable,
  }
}

const SAMPLE = [seg('a', 480, 2), seg('b', 482, 2), seg('c', 600, 2), seg('d', 602, 2)]
/** 分钟偏移 → 毫秒（T0 当天） */
const m = (min: number) => T0 + min * 60_000

describe('recording 纯函数', () => {
  it('sanitizeFilePart：非法字符/空白/非 ASCII 替成下划线', () => {
    // 非 ASCII 一律替成下划线，避免 SMB/CIFS 中文乱码与"毒文件"
    // "大门口/01 测试" → 非法字符替成下划线 → "大门口_01_测试"
    // → 两段非 ASCII（大门口、测试）各替成 1 个 _，加上原有的两个分隔下划线 → "__01__"
    expect(sanitizeFilePart('大门口/01 测试')).toBe('__01__')
    expect(sanitizeFilePart('a:b*c?d')).toBe('a_b_c_d')
    expect(sanitizeFilePart('   ')).toBe('channel')
    // 纯 ASCII 正常保留
    expect(sanitizeFilePart('front_door_01')).toBe('front_door_01')
    expect(sanitizeFilePart('cam-1/live test')).toBe('cam-1_live_test')
  })

  it('buildSegmentFilename：id_时间.mp4（通道名不落磁盘，防中文乱码）', () => {
    const name = buildSegmentFilename('demo-detect', '大门口', m(8 * 60))
    expect(name).toBe('demo-detect_20260913_080000.mp4')
  })

  it('抓拍文件名是 jpg（纯 ASCII 名保留，中文名替成下划线）', () => {
    // 中文通道名 → 全是非 ASCII → 替成一个 _，前面再加 _ 分隔时间
    expect(buildSnapshotFilename('大门口', m(8 * 60))).toBe('__20260913_080000.jpg')
    expect(buildSnapshotFilename('cam-front', m(8 * 60))).toBe('cam-front_20260913_080000.jpg')
  })

  it('findSegmentAt：命中段内/边界/缺口返回 null', () => {
    expect(findSegmentAt(SAMPLE, m(481))?.id).toBe('a')
    // 边界：段起始属于本段，段末属于下一段
    expect(findSegmentAt(SAMPLE, m(480))?.id).toBe('a')
    expect(findSegmentAt(SAMPLE, m(482))?.id).toBe('b')
    // 缺口 08:04~10:00
    expect(findSegmentAt(SAMPLE, m(500))).toBeNull()
    expect(findSegmentAt(SAMPLE, T0 - 1)).toBeNull()
    expect(findSegmentAt([], T0)).toBeNull()
  })

  it('adjacentSegment：前后相邻段，跳过不可播段', () => {
    const withDead = [seg('a', 480), { ...seg('b', 482, 2, false) }, seg('c', 600)]
    expect(adjacentSegment(SAMPLE, m(480), 1)?.id).toBe('b')
    expect(adjacentSegment(SAMPLE, m(604), 1)).toBeNull()
    expect(adjacentSegment(SAMPLE, m(600), -1)?.id).toBe('b')
    expect(adjacentSegment(SAMPLE, m(480), -1)).toBeNull()
    expect(adjacentSegment(withDead, m(480), 1)?.id).toBe('c')
  })

  it('segmentsInRange：只保留有交集的段', () => {
    expect(segmentsInRange(SAMPLE, m(500), m(700)).map((s) => s.id)).toEqual(['c', 'd'])
    expect(segmentsInRange(SAMPLE, null, null)).toHaveLength(4)
    expect(segmentsInRange(SAMPLE, m(482), null).map((s) => s.id)).toEqual(['b', 'c', 'd'])
  })

  it('mergeContiguous：小缝隙合并成块，大缺口保留', () => {
    const blocks = mergeContiguous(SAMPLE)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ startTs: m(480), endTs: m(484) })
    expect(blocks[1]).toMatchObject({ startTs: m(600), endTs: m(604) })
    // 块内含不可播段时整块标记不可播
    const mixed = mergeContiguous([seg('a', 0), { ...seg('b', 2, 2, false) }])
    expect(mixed[0]!.playable).toBe(false)
  })

  it('retentionLabel：今日/N天/null', () => {
    expect(retentionLabel(Date.now() - 1000)).toBe('今日')
    expect(retentionLabel(Date.now() - 5 * DAY)).toBe('5天')
    expect(retentionLabel(null)).toBeNull()
  })

  it('时钟格式化', () => {
    expect(formatClock(m(8 * 60 + 5) - T0)).toBe('08:05')
    expect(formatClock(m(60 + 1) + 1000 - T0, true)).toBe('01:01:01')
    expect(formatDurationClock(65_000)).toBe('01:05')
    expect(formatDurationClock(3_725_000)).toBe('1:02:05')
  })
})
