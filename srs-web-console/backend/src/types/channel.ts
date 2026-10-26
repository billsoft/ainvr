// 通道相关类型定义（与前端对齐，保持同步）
export type UpstreamProtocol = 'rtmp' | 'srt' | 'webrtc' | 'rtsp';
export type DownstreamProtocol = 'flv' | 'hls' | 'webrtc' | 'rtmp' | 'srt';

export interface OnvifBinding {
  deviceId: string;
  deviceVersion: number;
  service: 'media1' | 'media2';
  profileToken: string;
  videoSource: string;
}

export function sameOnvifBinding(a:OnvifBinding|undefined,b:OnvifBinding|undefined):boolean {
  if(!a||!b)return a===b;
  return (['deviceId','deviceVersion','service','profileToken','videoSource'] as const).every(key=>a[key]===b[key]);
}

export interface Channel {
  id: string;
  name: string;
  upstreamProtocol: UpstreamProtocol;
  streamName: string;       // SRS 上的流名，对应 live/<streamName>
  downstreamProtocols: DownstreamProtocol[];
  app?: string;             // per-channel 推流应用名；未设置时用全局 defaultApp（老数据无此字段）
  primaryProtocol?: DownstreamProtocol; // 用户选择的默认播放协议；未设置时按固定规则推导
  remark?: string;
  rtspUrl?: string;         // 仅 upstreamProtocol = rtsp 时有值
  rtspTransport?: 'tcp' | 'udp';
  inputEnabled?: boolean;
  inputGeneration?: string;
  inputUsername?: string;
  inputCredentialSet?: boolean;
  sourceRef?: string;       // encrypted configuration-store reference; never returned to browsers
  onvif?: OnvifBinding;
  inputAudioMode?: 'off' | 'auto';
  createdAt: number;
  updatedAt: number;
}

export interface ChannelStatus {
  online: boolean;
  clients: number;
  bitrate?: number;         // kbps
  srsOnline: boolean;       // SRS 服务本身是否可达
  inputState?: string;
  connectionActive?: boolean;
  videoCodec?: string;
  audioCodec?: string;      // 来自 SRS video.codec：H.264 为 "H264"、H.265 为 "HEVC"；未在线/未知时不存在
  videoLevel?: string;      // SRS video.level（实测为字符串，如 "5.1"）——前端按它判定本机能否播放 H.265
  videoWidth?: number;
  videoHeight?: number;
}

export interface ChannelWithStatus extends Channel {
  status: ChannelStatus;
}

// AI 微服务连接信息（架构 §11.3.1：数据归属 console，不归属 ai-service 自己）——
// baseUrl/apiKey 只由 console 持有，浏览器/前端永远不直接经手 ai-service 的
// 凭据；/api/ai/* 代理与 /api/ai-test-connection 都从这里读，不接受调用方
// 自带凭据覆盖（见 aiProxy.ts 的 X-API-Key 注入逻辑）。
export interface AiServiceSettings {
  baseUrl: string;        // 如 http://host.docker.internal:8000；空字符串=未配置，代理退回 env AI_SERVICE_BASE_URL
  apiKey: string;         // ai-service 的 X-API-Key；空字符串=未设置（ai-service 端不鉴权）
  pollIntervalMs: number; // 前端轮询 AI 通道状态的间隔
}

/** 录像微服务连接信息（2026-09-14 ainvr-recorder，默认 :8100）。无独立凭据：
 * 代理时注入控制台口令哈希（X-Console-Token）。 */
export interface RecorderServiceSettings {
  /** 如 http://host.docker.internal:8100；空字符串/缺省=走 fallback */
  baseUrl: string;
}

// 系统设置
export interface AppSettings {
  srsApiHost: string;       // SRS HTTP API 地址，默认 127.0.0.1:1985
  srsRtmpHost: string;      // SRS RTMP 主机（生成推流地址用）
  srsHttpHost: string;      // SRS HTTP-FLV/HLS 主机（生成播放地址用）
  srsRtcHost: string;       // SRS WebRTC 主机
  srsSrtHost: string;       // SRS SRT 主机
  monitorSoftLimit: number; // 监看软上限
  monitorHardLimit: number; // 监看硬上限
  pollIntervalMs: number;   // 前端轮询间隔
  /** B4 迁移后密码哈希不再存 settings（PG 单源时存 config_secrets
   *  `backend/adminPasswordHash`）；本字段仅保留旧 JSON 兜底路径使用 */
  adminPasswordHash?: string;
  // rtcCandidateIp 不在这里：唯一归属是 srs/system/settings 文档
  // （store/srsAdapter.ts），这份文档的写入路径从不触达 writeCandidateIp。
  srsVersion: string;       // SRS 版本号展示用（默认基线版本）
  ingest?: { maxPullChannels: number; connectTimeoutSec: number; maxAudioTranscodes?: number };
  aiService: AiServiceSettings;
  /** 可选：磁盘上的旧 settings.json 没有此字段，时代码用 fallback 兜底 */
  recorderService?: RecorderServiceSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  srsApiHost: '127.0.0.1:1985',
  srsRtmpHost: '',
  srsHttpHost: '',
  srsRtcHost: '',
  srsSrtHost: '',
  monitorSoftLimit: 6,
  monitorHardLimit: 9,
  pollIntervalMs: 5000,
  adminPasswordHash: '',
  srsVersion: '6.0.191',
  aiService: {
    baseUrl: '',
    apiKey: '',
    pollIntervalMs: 5000,
  },
};
