/**
 * 录像回放/录像微服务相关类型（2026-09-13 录像回放页）。
 * 与录像微服务 API 对齐；计划状态与实际录制状态分开。
 */

export type RecorderChannelKind = 'source' | 'ai'
export type VideoCodec = 'h264' | 'h265'
export type StorageKind = 'local' | 'smb'
export type QuotaMode = 'percent' | 'gb'
/** 配额满后的策略：滚动覆盖最旧段 / 停止录制并告警 */
export type QuotaOnFull = 'overwrite' | 'stop'
export type SmbVersion = 'auto' | '3.0' | '2.1'

/** 左栏通道行（源流与 AI 流一视同仁，kind 仅用于显示小徽标） */
export type RecorderWriteState = 'ok' | 'degraded' | 'stalled'

/** 存储写入不足时按完整 GOP 丢弃的区间（内容时间，unix ms） */
export interface RecordingDrop {
  startTs: number
  endTs: number
  droppedMs: number
  reason: string
}

export interface RecorderChannel {
  id: string
  name: string
  kind: RecorderChannelKind
  /** SRS 流名；AI 类型由明确的发布目标映射决定，不依赖名称后缀。 */
  streamName?: string | null
  /** 当前录制进程实际运行中，不能用于回填计划勾选状态。 */
  recording: boolean
  /** codec_error：H.265 通道缺少读端组件（FFmpeg 8.1.2），不启动录制，detail 给出补装命令 */
  recordingState?: 'disabled' | 'waiting_source' | 'recording' | 'storage_error' | 'stopped' | 'codec_error'
  recordingDetail?: string
  /** H.265 源的码流问题（录制中）：no_idr=长时间没有 IDR（无法切新文件）；open_gop=开放 GOP */
  codecWarning?: 'no_idr' | 'open_gop' | null
  /** 写入状态：degraded=存储写得慢，按完整画面组丢弃中/近 1 小时丢过；stalled=写入卡死 */
  writeState?: RecorderWriteState
  /** 当前正在积压丢弃或写入停滞；与过去一小时的缺口分开。 */
  writeBacklogActive?: boolean
  droppedMsLastHour?: number
  /** 当前内存缓冲积压秒数 */
  bufferSec?: number
  /** 录像计划：通道勾选状态（false=全天不录，优先于 hours） */
  scheduleEnabled?: boolean
  /** 录像计划：24 小时整点时间表（0-23 子集，默认全选） */
  scheduleHours?: number[]
  /** 源流当前是否在线（离线通道显示灰点，上线后自动续录） */
  sourceOnline: boolean
  codec: VideoCodec | null
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  /** 今日录制时长 ms */
  todayDurationMs?: number
  todayBytes?: number
  /** 最旧一段的起始时间（unix ms），用于"可回溯 N 天" */
  oldestSegmentTs?: number | null
}

/** 单通道录像计划（通道选择对话框 <-> recorder 微服务契约） */
export interface ChannelSchedule {
  /** 是否录像（false 优先于 hours=全天不录） */
  enabled: boolean
  /** 24 小时整点时间表，0-23 子集；默认全选 */
  hours: number[]
}

export const ALL_DAY_HOURS: number[] = Array.from({ length: 24 }, (_, i) => i)

/** 一个录像分段文件（MP4，copy 封装） */
export interface RecordingSegment {
  id: string
  channelId: string
  /** unix ms */
  startTs: number
  /** unix ms（该段最后一帧时间，不含段间断点） */
  endTs: number
  /** Filename wall-clock precision; absent/zero means unknown. */
  startPrecisionMs?: number
  durationMs: number
  sizeBytes: number
  codec: VideoCodec
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  /** 码流内是否带 SEI（copy 录制时原样保留在 MP4 内） */
  seiPresent: boolean
  /** Verified SEI-bearing video frame intervals, relative milliseconds. Missing = not yet indexed. */
  seiRanges?: [number, number][] | null
  storage: StorageKind
  /** 索引在但文件已不可读（悬空/对端存储不可达）时 false */
  playable: boolean
}

export interface SmbConfig {
  host: string
  share: string
  /** 共享内子目录，可为空 */
  path: string
  username: string
  /** 回显只表示"有没有设过"，永不返回明文；请求里带 password 才更新 */
  passwordSet: boolean
  /** 仅保存请求里可能出现，任何响应不得填充 */
  password?: string
  smbVersion: SmbVersion
  domain?: string
}

export interface RecorderStorageConfig {
  kind: StorageKind
  /** kind=local 时的绝对目录，默认 ~/Videos/recordings */
  localPath: string
  smb: SmbConfig | null
}

export interface RecorderQuotaConfig {
  mode: QuotaMode
  /** mode=percent：50~99 */
  percent: number
  /** mode=gb：固定 GB 上限 */
  gb: number | null
  onFull: QuotaOnFull
  /** 最少保留天数（与配额 OR 触发），null=不限 */
  minRetentionDays: number | null
}

export interface RecorderFilesConfig {
  /** 分段目标时长秒，默认 60；实际切点对齐关键帧，允许小幅波动 */
  segmentSeconds: number
}

export interface RecorderConfig {
  storage: RecorderStorageConfig
  quota: RecorderQuotaConfig
  files: RecorderFilesConfig
}

export interface RecorderStats {
  todayDurationMs: number
  todayBytes: number
  poolUsedBytes: number
  poolTotalBytes: number
  poolAvailableBytes: number
  poolKind: StorageKind
  /** 滚动覆盖删除的段数（监控用） */
  overwrittenSegments?: number
  recordingChannels?: number
  storageHealthy?: boolean
  /** 近 1 小时因存储写入速度不足按完整画面组丢弃的总毫秒（全部通道） */
  droppedMsLastHour?: number
  /** 写入降级/卡死的通道数 */
  writeDegradedChannels?: number
}

export interface RecorderHealth {
  ok: boolean
  version: string | null
  /** 存储不健康/停录时给人看的原因（挂载失败、空间不足、恢复重试中…） */
  message?: string
  /** 存储可录可读；缺省视为健康（旧版/模拟服务不带该字段） */
  storageHealthy?: boolean
  storageKind?: StorageKind
  /** 非致命告警（如 NAS 共享开了回收站） */
  warning?: string
}
