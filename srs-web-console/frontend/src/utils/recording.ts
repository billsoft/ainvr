/**
 * 录像回放纯函数（2026-09-13）：时间轴几何、选段二分、文件名规则等。
 * 全部无副作用，单测见 src/test/recordingUtils.test.ts。
 */
import type { RecordingDrop, RecordingSegment } from '@/types/recording'
import { subtractRangeUnit, toDatetimeLocalValue, type RangeUnit } from './timeRange'

// RangeUnit/subtractRangeUnit/toDatetimeLocalValue 原来在这里各写一份，
// 2026-09-17 识别历史页的时间范围弹窗搬进 utils/timeRange.ts 共用后，这里
// 改成直接引用同一份——不再有两套"月按日历月算"的实现互相走漂。
export type { RangeUnit }
export { subtractRangeUnit, toDatetimeLocalValue }

export const DAY_MS = 24 * 60 * 60 * 1000
export const MIN_MS = 60 * 1000

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 'YYYY-MM-DD'（本地时区，<input type=date> 的 value 同格式） */
export function dateKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 当天 0 点起经过的毫秒数 → 'HH:MM:SS'（秒位可关） */
export function formatClock(msOfDay: number, withSeconds = false): string {
  const clamped = Math.max(0, Math.min(DAY_MS - 1, Math.floor(msOfDay)))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor((clamped % 3_600_000) / 60_000)
  const s = Math.floor((clamped % 60_000) / 1000)
  return withSeconds ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(h)}:${pad2(m)}`
}

/** 回放页时间范围快捷（识别历史页那套的录像子集——本机录像循环覆盖
 * 实际只存 1~2 天，周/月级窗口没有录像数据，不放进回放页） */
export const PLAYBACK_RANGE_PRESETS: { label: string; unit: RangeUnit; n: number }[] = [
  { label: '10分', unit: 'minute', n: 10 },
  { label: '时', unit: 'hour', n: 1 },
  { label: '2时', unit: 'hour', n: 2 },
  { label: '3时', unit: 'hour', n: 3 },
  { label: '8时', unit: 'hour', n: 8 },
  { label: '天', unit: 'day', n: 1 },
  { label: '2天', unit: 'day', n: 2 },
  { label: '3天', unit: 'day', n: 3 },
]

/**
 * AI 识别红条 × 可播放录像块求交集：识别快照时间与录像段可能有钟差/
 * 跨段间隔，直接画红条会标到无录像的空白处——只保留落在绿条内的部分。
 */
export function intersectMarksWithBlocks(
  marks: readonly { start: number; end: number }[],
  blocks: readonly TimelineBlock[],
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const m of marks) {
    for (const b of blocks) {
      const start = Math.max(m.start, b.startTs)
      const end = Math.min(m.end, b.endTs)
      if (end > start && b.playable) out.push({ start, end })
    }
  }
  return out
}

/** 绝对时间戳 → 'HH:MM:SS' */
export function formatClockAt(ts: number, withSeconds = true): string {
  const d = new Date(ts)
  const core = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ''}`
  return core
}

/** 时长毫秒 → 'mm:ss' / 'h:mm:ss'（分段列表/播放器用，区别于 formatDuration 的中文） */
export function formatDurationClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${pad2(m)}:${pad2(s)}`
    : `${pad2(m)}:${pad2(s)}`
}

/**
 * 通道名清洗为合法文件片段：
 * - Windows 非法字符 / \ : * ? " < > | 与空白统一替成下划线
 * - 非 ASCII 字符一律替成下划线（避免 SMB/CIFS 跨平台编码乱码与"毒文件"）
 *
 * 与后端 `naming.sanitize_file_part` 完全同语义（不 strip 首尾下划线），
 * 存 SMB 也安全。
 */
export function sanitizeFilePart(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/[^\x21-\x7E]+/g, '_')
  return cleaned || 'channel'
}

/** 'YYYYMMDD_HHMMSS'（服务器本地时间，文件名用） */
export function fileTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/**
 * 磁盘文件名规则（展示名是中文通道名，磁盘名只用 channelId 防乱码/毒文件）：
 * `<channelId>_<起始时间>.mp4`
 *
 * 历史版本曾把通道名拼进文件名（`<channelId>_<通道名>_<时间>.mp4`），
 * 但中文通道名在 SMB NAS 上会触发编码乱码与 D 状态挂死的"毒文件"问题，
 * 故移除。channelId 本身全局唯一且为 ASCII，足以区分不同通道。
 */
export function buildSegmentFilename(channelId: string, _channelName: string, startTs: number): string {
  return `${sanitizeFilePart(channelId)}_${fileTimestamp(startTs)}.mp4`
}

/** 抓拍图文件名（秒级即可） */
export function buildSnapshotFilename(channelName: string, ts: number): string {
  return `${sanitizeFilePart(channelName)}_${fileTimestamp(ts)}.jpg`
}

/** 二分查找覆盖某时刻的段（segments 按 startTs 升序；缺口处返回 null） */
export function findSegmentAt(
  segments: readonly RecordingSegment[],
  ts: number,
): RecordingSegment | null {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const seg = segments[mid]!
    if (ts < seg.startTs) hi = mid - 1
    else lo = mid + 1
  }
  // Keyframe-aligned segments can overlap. Find the latest playable covering
  // interval, not an arbitrary binary-search hit or an expired short interval.
  let unavailable: RecordingSegment | null = null
  for (let i = hi; i >= 0; i--) {
    const segment = segments[i]!
    if (ts < segment.endTs) {
      if (segment.playable) return segment
      unavailable ??= segment
    }
  }
  return unavailable
}

/** ts 之后（之前）最近的一段；ts 正落在某段内时 dir=next 取下一段、prev 取本段之前 */
export function adjacentSegment(
  segments: readonly RecordingSegment[],
  ts: number,
  dir: 1 | -1,
): RecordingSegment | null {
  if (segments.length === 0) return null
  if (dir === 1) {
    return segments.find((s) => s.startTs > ts && s.playable) ?? null
  }
  return [...segments].reverse().find((s) => s.endTs <= ts && s.playable) ?? null
}

/** 与 [from,to] 有交集的段（列表过滤用；边界相接 1ms 误差容差） */
export function segmentsInRange(
  segments: readonly RecordingSegment[],
  fromTs: number | null,
  toTs: number | null,
): RecordingSegment[] {
  const filtered = fromTs == null && toTs == null
    ? [...segments]
    : segments.filter((s) => {
        if (fromTs != null && s.endTs <= fromTs) return false
        if (toTs != null && s.startTs >= toTs) return false
        return true
      })
  // 二分查找（findSegmentAt / adjacentSegment）依赖有序，必须保证按 startTs 升序
  filtered.sort((a, b) => a.startTs - b.startTs)
  return filtered
}

export interface TimelineBlock {
  startTs: number
  endTs: number
  playable: boolean
}

/**
 * 把 60s 的小段合并成时间轴上的连续色块：相邻段间隔 ≤ maxGapMs 即视为一块
 * （默认 2 分钟，吞掉切段对齐关键帧造成的小缝隙；源流中断的大缺口如实保留）。
 */
export function mergeContiguous(
  segments: readonly RecordingSegment[],
  maxGapMs = 2 * MIN_MS,
): TimelineBlock[] {
  const blocks: TimelineBlock[] = []
  for (const seg of segments) {
    const last = blocks[blocks.length - 1]
    if (last && seg.startTs - last.endTs <= maxGapMs) {
      last.endTs = Math.max(last.endTs, seg.endTs)
      last.playable = last.playable && seg.playable
    } else {
      blocks.push({ startTs: seg.startTs, endTs: seg.endTs, playable: seg.playable })
    }
  }
  return blocks
}

/** "可回溯 N 天" 文案（无历史返回 null） */
export function retentionLabel(oldestTs: number | null | undefined, now = Date.now()): string | null {
  if (oldestTs == null) return null
  const days = Math.max(0, Math.floor((now - oldestTs) / DAY_MS))
  return days <= 0 ? '今日' : `${days}天`
}

/** Display only: bridge uncertainty of legacy second-resolution filenames.
 * Never alters seek data or invents SEI coverage. Known drops always win.
 */
export function recordingDisplayBlocks(
  segments: readonly RecordingSegment[], drops: readonly RecordingDrop[],
): TimelineBlock[] {
  const rows = [...segments].filter(s => s.playable).sort((a, b) => a.startTs - b.startTs)
  const blocks: TimelineBlock[] = []
  let previous: RecordingSegment | undefined
  for (const seg of rows) {
    const last = blocks[blocks.length - 1]
    const gap = last ? seg.startTs - last.endTs : Infinity
    const tolerance = previous?.startPrecisionMs === 1000 && seg.startPrecisionMs === 1000 ? 1000 : 2
    const knownDrop = last && drops.some(d => d.startTs < seg.startTs && d.endTs > last.endTs)
    if (last && previous?.channelId === seg.channelId && (gap <= 0 || (gap < tolerance && !knownDrop))) {
      last.endTs = Math.max(last.endTs, seg.endTs)
    } else {
      blocks.push({ startTs: seg.startTs, endTs: seg.endTs, playable: true })
    }
    previous = seg
  }
  return blocks
}
