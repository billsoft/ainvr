/**
 * 录像微服务前端接口（2026-09-13，ainvr-recorder 端口 8100）。
 * - HTTP 实现：经 BFF 同源 /api 代理（与 ai-service 同模式）
 * - mock 实现：测试/开发态使用；生产态用真实 HTTP 接口
 */
import { request } from './httpClient'
import type {
  RecorderChannel,
  RecorderConfig,
  RecorderHealth,
  RecorderStats,
  RecordingDrop,
  RecordingSegment,
} from '@/types/recording'
import { ALL_DAY_HOURS } from '@/types/recording'

export interface RecordingService {
  health(): Promise<RecorderHealth>
  stats(): Promise<RecorderStats>
  listChannels(): Promise<RecorderChannel[]>
  getConfig(): Promise<RecorderConfig>
  preparePlayback(segmentId: string): Promise<void>
  listSegments(channelId: string, fromTs: number, toTs: number, signal?: AbortSignal): Promise<RecordingSegment[]>
  /** 存储写入不足时按完整画面组丢弃的区间（时间轴琥珀色块） */
  listDrops(channelId: string, fromTs: number, toTs: number, signal?: AbortSignal): Promise<RecordingDrop[]>
  playUrl(segmentId: string): string
  downloadUrl(segmentId: string): string
}

// ---------------- HTTP 实现 ----------------

export function createHttpRecordingService(): RecordingService {
  return {
    async preparePlayback(segmentId) {
      await request(`/v1/recordings/${encodeURIComponent(segmentId)}/availability`, {
        cache: 'no-store', signal: AbortSignal.timeout(12000),
      })
    },
    async health() {
      return request<RecorderHealth>('/v1/recorder/health')
    },
    async stats() {
      return request<RecorderStats>('/v1/recorder/stats')
    },
    async listChannels() {
      return request<RecorderChannel[]>('/v1/recorder/channels')
    },
    async getConfig() {
      return request<RecorderConfig>('/v1/recorder/config')
    },
    async listSegments(channelId, fromTs, toTs, signal) {
      const q = new URLSearchParams({
        channel: channelId,
        from: String(fromTs),
        to: String(toTs),
      })
      return request<RecordingSegment[]>(`/v1/recordings/segments?${q.toString()}`, {
        cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      })
    },
    async listDrops(channelId, fromTs, toTs, signal) {
      const q = new URLSearchParams({ channel: channelId, from: String(fromTs), to: String(toTs) })
      return request<RecordingDrop[]>(`/v1/recordings/drops?${q.toString()}`, {
        cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      })
    },
    playUrl(segmentId) {
      // Same-origin playback-only HttpOnly cookie; no administrator token in URLs.
      // AuthImage 的 blob 方案不同——回放要支持 Range seek，不能整段拉 blob。
      return `/api/v1/recordings/${segmentId}/play`
    },
    downloadUrl(segmentId) {
      return `/api/v1/recordings/${segmentId}/download`
    },
  }
}

// ---------------- mock 实现 ----------------

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000

interface MockSeed {
  id: string
  name: string
  kind: RecorderChannel['kind']
  recording: boolean
  sourceOnline: boolean
  codec: 'h264' | 'h265'
  mbps: number
  /** 历史最早录像距今天数 */
  historyDays: number
  /** 最近 N 天无录像（离线通道） */
  silentDays?: number
}

const SEED: MockSeed[] = [
  { id: 'demo-detect', name: '大门口', kind: 'source', recording: true, sourceOnline: true, codec: 'h264', mbps: 20, historyDays: 28 },
  { id: 'demo-detect-ai', name: '大门口_AI输出', kind: 'ai', recording: true, sourceOnline: true, codec: 'h264', mbps: 20, historyDays: 28 },
  { id: 'parking', name: '停车场', kind: 'source', recording: true, sourceOnline: false, codec: 'h265', mbps: 8, historyDays: 21, silentDays: 3 },
  { id: 'backdoor', name: '后门', kind: 'source', recording: false, sourceOnline: true, codec: 'h264', mbps: 12, historyDays: 0 },
]

/** 每天三段录像窗口（分钟），视觉上覆盖上午/中午/下午且有真实缺口 */
const RUNS: [number, number][] = [
  [8 * 60, 8 * 60 + 40],
  [10 * 60, 10 * 60 + 40],
  [14 * 60, 14 * 60 + 40],
]
const SEG_STEP_MS = 2 * MIN // mock 用 2 分钟一段，控制列表体量（真实默认 60s）

function dayStartAt(offsetDays: number): number {
  const d = new Date(Date.now() - offsetDays * DAY)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function createMockRecordingService(): RecordingService {
  const channels: RecorderChannel[] = SEED.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    recording: s.recording,
    scheduleEnabled: s.recording,
    scheduleHours: ALL_DAY_HOURS,
    sourceOnline: s.sourceOnline,
    codec: s.codec,
    width: 3840,
    height: 1920,
    fps: 30,
    hasAudio: true,
    oldestSegmentTs: s.historyDays > 0 ? dayStartAt(s.historyDays) + 8 * 60 * MIN : null,
  }))

  const config: RecorderConfig = {
    storage: {
      kind: 'local',
      localPath: '/home/sunrise/ainvr/data/recordings',
      smb: null,
    },
    quota: { mode: 'percent', percent: 90, gb: null, onFull: 'overwrite', minRetentionDays: null },
    files: { segmentSeconds: 60 },
  }

  function genSegments(seed: MockSeed, from: number, to: number): RecordingSegment[] {
    if (!seed.recording || seed.historyDays === 0) return []
    const out: RecordingSegment[] = []
    const todayStart = dayStartAt(0)
    for (let dayStart = dayStartAt(Math.floor((Date.now() - from) / DAY) + 1); dayStart <= to; dayStart += DAY) {
      const offsetDays = Math.round((todayStart - dayStart) / DAY)
      if (offsetDays > seed.historyDays) continue
      if (seed.silentDays != null && offsetDays < seed.silentDays) continue
      for (const [fromMin, toMin] of RUNS) {
        let segStart = dayStart + fromMin * MIN + (seed.kind === 'ai' ? MIN : 0)
        const runEnd = dayStart + toMin * MIN
        while (segStart + SEG_STEP_MS <= runEnd) {
          // 今天的录像不能超过"现在"（最后一段正在写，不出现在列表）
          if (dayStart === todayStart && segStart + SEG_STEP_MS > Date.now() - MIN) break
          const segEnd = segStart + SEG_STEP_MS
          if (segEnd > from && segStart < to) {
            out.push({
              id: `${seed.id}-${segStart}`,
              channelId: seed.id,
              startTs: segStart,
              endTs: segEnd,
              durationMs: SEG_STEP_MS,
              sizeBytes: Math.round((seed.mbps * 1_000_000 / 8) * (SEG_STEP_MS / 1000)),
              codec: seed.codec,
              width: 3840,
              height: 1920,
              fps: 30,
              hasAudio: true,
              seiPresent: seed.kind === 'ai',
              storage: config.storage.kind,
              playable: true,
            })
          }
          segStart += SEG_STEP_MS
        }
      }
    }
    return out.sort((a, b) => a.startTs - b.startTs)
  }

  function refreshTodayStats() {
    for (const ch of channels) {
      const seed = SEED.find((s) => s.id === ch.id)!
      const todays = genSegments(seed, dayStartAt(0), Date.now())
      ch.todayDurationMs = todays.reduce((sum, s) => sum + s.durationMs, 0)
      ch.todayBytes = todays.reduce((sum, s) => sum + s.sizeBytes, 0)
    }
  }
  refreshTodayStats()

  return {
    async health() {
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, version: '0.1.0-mock' }
    },
    async stats() {
      refreshTodayStats()
      const todayBytes = channels.reduce((s, c) => s + (c.todayBytes ?? 0), 0)
      const todayDuration = channels.reduce((s, c) => s + (c.todayDurationMs ?? 0), 0)
      return {
        todayDurationMs: todayDuration,
        todayBytes,
        poolUsedBytes: 110.7 * 1024 ** 3,
        poolTotalBytes: 232.2 * 1024 ** 3,
        poolAvailableBytes: (232.2 - 110.7) * 1024 ** 3,
        poolKind: config.storage.kind,
        overwrittenSegments: 0,
      }
    },
    async listChannels() {
      refreshTodayStats()
      return channels.map((c) => ({ ...c }))
    },
    async getConfig() {
      return JSON.parse(JSON.stringify(config)) as RecorderConfig
    },
    async preparePlayback() {},
    async listSegments(channelId, fromTs, toTs) {
      const seed = SEED.find((s) => s.id === channelId)
      if (!seed) return []
      return genSegments(seed, fromTs, toTs)
    },
    async listDrops() {
      return []
    },
    playUrl(id) {
      return `/mock-recordings/${id}.mp4`
    },
    downloadUrl(id) {
      return `/mock-recordings/${id}.mp4?download=1`
    },
  }
}

// ---------------- 单例 ----------------

const isTestOrDev =
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  (import.meta.env.MODE === 'test' || import.meta.env.MODE === 'development' ||
    import.meta.env.VITEST === 'true')

/** 测试/开发态直接用 mock；生产态用 HTTP（页面另有"预览演示界面"入口挂 mock） */
export const recordingService: RecordingService = isTestOrDev
  ? createMockRecordingService()
  : createHttpRecordingService()
