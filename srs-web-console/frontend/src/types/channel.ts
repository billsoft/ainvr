/**
 * 通道核心类型定义（Phase 1 定版，后续 Phase 沿用）
 */

/** 上行（推流到 SRS）协议 */
export type UpstreamProtocol = 'rtmp' | 'srt' | 'webrtc' | 'rtsp'

/** 下行（从 SRS 拉流播放）协议 */
export type DownstreamProtocol = 'flv' | 'hls' | 'webrtc' | 'rtmp' | 'srt'

/** 通道上行配置 */
export interface ChannelUpstream {
  protocol: UpstreamProtocol
  /** RTMP/SRT/WebRTC 推流应用名，默认 live */
  app: string
  /** 流名（SRT/RTSP 来源时由 BFF 生成或用户指定） */
  stream: string
  /** 上行为 RTSP 时的源地址（摄像头地址，BFF 负责 ffmpeg 拉流转推） */
  rtspUrl?: string
  rtspTransport?: 'tcp' | 'udp'
  inputUsername?: string
  /** Write-only. Never populated by list/detail responses. */
  inputPassword?: string
  inputCredentialSet?: boolean
  inputEnabled?: boolean
}

/** 通道下行配置（1 对多：一个上行流可按多种协议拉流） */
export interface ChannelDownstream {
  /** 启用的输出协议（可多选） */
  protocols: DownstreamProtocol[]
  /** 网页播放器默认使用的协议（必须包含于 protocols） */
  primary: DownstreamProtocol
}

/** 通道（元数据，持久化于 BFF） */
export interface Channel {
  id: string
  name: string
  description?: string
  upstream: ChannelUpstream
  downstream: ChannelDownstream
  createdAt: string
  updatedAt: string
}

/** 通道实时状态（从 SRS API 聚合，mock 先模拟） */
export interface ChannelStatus {
  channelId: string
  online: boolean
  inputState?: string
  viewerCount: number
  bitrateKbps?: number
  /** SRS video.codec：H.264 为 "H264"、H.265 为 "HEVC"（判定一律用 utils/codec 的 isH265） */
  videoCodec?: string
  /** SRS video.level（如 "5.1"）与分辨率：播放器据此判定本机能否播放该路 H.265 */
  videoLevel?: string
  videoWidth?: number
  videoHeight?: number
  audioCodec?: string
  /** 已运行秒数 */
  durationSec?: number
}

/** 通道 + 实时状态（列表页行数据） */
export interface ChannelWithStatus extends Channel {
  status: ChannelStatus
  /** 后端按当前系统设置（协议主机名覆盖）算好的推流/播放地址；mock 环境下不存在 */
  urls?: { push?: Record<string, string>; play: Record<string, string> }
  /** 是否在接入管理中登记过；false 表示 SRS 上正在直播但没有对应通道记录 */
  registered?: boolean
}

/** 上行协议显示名 */
export const UPSTREAM_LABEL: Record<UpstreamProtocol, string> = {
  rtmp: 'RTMP',
  srt: 'SRT',
  webrtc: 'WebRTC',
  rtsp: 'RTSP',
}

/** 下行协议显示名 */
export const DOWNSTREAM_LABEL: Record<DownstreamProtocol, string> = {
  flv: 'HTTP-FLV',
  hls: 'HLS',
  webrtc: 'WebRTC',
  rtmp: 'RTMP',
  srt: 'SRT',
}

/** AI 微服务连接信息（架构 §11.3.1：归属 console，浏览器不直接经手 ai-service 凭据） */
export interface AiServiceSettings {
  baseUrl: string
  apiKey: string
  pollIntervalMs: number
}

/** 系统设置（与后端 AppSettings 严格对齐） */
export interface AppSettings {
  srsApiHost: string
  srsRtmpHost: string
  srsHttpHost: string
  srsRtcHost: string
  srsSrtHost: string
  srsVersion: string
  monitorSoftLimit: number
  monitorHardLimit: number
  pollIntervalMs: number
  adminPasswordHash: string
  aiService: AiServiceSettings
}
