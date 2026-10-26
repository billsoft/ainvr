import type { DownstreamProtocol, UpstreamProtocol } from '@/types/channel'

/** 向导表单统一值结构（创建与编辑共用） */
export interface WizardFormValue {
  name: string
  description: string
  /** 来源：直推（RTMP/SRT/WebRTC）或 RTSP 摄像头拉流 */
  sourceType: 'push' | 'rtsp'
  rtspUrl: string
  rtspTransport?: 'tcp' | 'udp'
  inputUsername?: string
  inputPassword?: string
  inputEnabled?: boolean
  inputAudioMode?: 'off' | 'auto'
  upstreamProtocol: UpstreamProtocol
  app: string
  stream: string
  protocols: DownstreamProtocol[]
  primary: DownstreamProtocol
}

export const DEFAULT_WIZARD_VALUE: WizardFormValue = {
  name: '',
  description: '',
  sourceType: 'push',
  rtspUrl: '',
  rtspTransport: 'tcp',
  inputUsername: '',
  inputPassword: '',
  inputEnabled: true,
  inputAudioMode: 'off',
  upstreamProtocol: 'rtmp',
  app: 'live',
  stream: '',
  // WebRTC 延迟最低（原生 RTCPeerConnection，无需第三方播放器库），默认优先；
  // RTMP 作为标准拉流协议默认开启，FLV/HLS 作为浏览器降级备选。
  // 局域网/NAT 环境下若 WebRTC 连不上，播放器的降级链会自动摔到 FLV/HLS，不会白屏。
  protocols: ['webrtc', 'flv', 'hls', 'rtmp'],
  primary: 'webrtc',
}

export type FieldErrors = Partial<Record<'name' | 'rtspUrl' | 'app' | 'stream', string>>

const STREAM_RE = /^[a-zA-Z0-9_-]{1,128}$/
function validRtsp(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'rtsp:' && !!u.hostname && !u.hash && !/[\x00-\x20]/.test(value) }
  catch { return false }
}

/** 步骤 1：基本信息 */
export function validateStep1(v: WizardFormValue): FieldErrors {
  const errors: FieldErrors = {}
  if (!v.name.trim()) errors.name = '请输入通道名称'
  else if (v.name.trim().length > 50) errors.name = '名称不能超过 50 字'
  if (v.sourceType === 'rtsp' && !validRtsp(v.rtspUrl.trim())) {
    errors.rtspUrl = '请输入合法的 RTSP 地址（rtsp://host[:port]/path）'
  }
  return errors
}

/** 步骤 2：推流配置 */
export function validateStep2(v: WizardFormValue): FieldErrors {
  const errors: FieldErrors = {}
  if (!STREAM_RE.test(v.app)) {
    errors.app = '应用名只能包含字母、数字、下划线、短横线'
  }
  if (!STREAM_RE.test(v.stream)) {
    errors.stream = '流名只能包含字母、数字、下划线、短横线（1-128 位）'
  }
  return errors
}

/** 步骤 3：下行协议。返回全局错误文案，null 表示通过 */
export function validateStep3(v: WizardFormValue): string | null {
  if (v.protocols.length === 0) return '至少启用一个下行协议'
  if (!v.protocols.includes(v.primary)) return '默认播放协议必须在已启用的协议中'
  return null
}

/** 根据通道名生成可读流名（中文→过滤，附随机后缀保证可用性） */
export function generateStreamName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const rand = Math.random().toString(36).slice(2, 8)
  return slug ? `${slug}-${rand}` : `stream-${rand}`
}

/** 由表单值组装服务输入 */
export function toServiceInput(v: WizardFormValue) {
  return {
    name: v.name.trim(),
    description: v.description.trim() || undefined,
    upstream: {
      protocol: v.sourceType === 'rtsp' ? ('rtsp' as const) : v.upstreamProtocol,
      app: v.app,
      stream: v.stream,
      rtspUrl: v.sourceType === 'rtsp' ? v.rtspUrl.trim() : undefined,
      rtspTransport: v.sourceType === 'rtsp' ? v.rtspTransport ?? 'tcp' : undefined,
      inputAudioMode: v.sourceType === 'rtsp' ? v.inputAudioMode ?? 'off' : undefined,
      inputUsername: v.sourceType === 'rtsp' && v.inputUsername ? v.inputUsername : undefined,
      inputPassword: v.sourceType === 'rtsp' && v.inputPassword ? v.inputPassword : undefined,
      inputEnabled: v.inputEnabled ?? true,
    },
    downstream: { protocols: [...v.protocols], primary: v.primary },
  }
}

/** 通道编辑回填 */
export function fromChannel(ch: {
  name: string
  description?: string
  upstream: { protocol: UpstreamProtocol; app: string; stream: string; rtspUrl?: string; rtspTransport?: 'tcp' | 'udp'; inputUsername?: string; inputEnabled?: boolean; inputAudioMode?: 'off' | 'auto' }
  downstream: { protocols: DownstreamProtocol[]; primary: DownstreamProtocol }
}): WizardFormValue {
  return {
    name: ch.name,
    description: ch.description ?? '',
    sourceType: ch.upstream.protocol === 'rtsp' ? 'rtsp' : 'push',
    rtspUrl: ch.upstream.rtspUrl ?? '',
    rtspTransport: ch.upstream.rtspTransport ?? 'tcp',
    inputUsername: ch.upstream.inputUsername ?? '',
    inputPassword: '',
    inputEnabled: ch.upstream.inputEnabled ?? true,
    inputAudioMode: ch.upstream.inputAudioMode ?? 'off',
    upstreamProtocol: ch.upstream.protocol === 'rtsp' ? 'rtmp' : ch.upstream.protocol,
    app: ch.upstream.app,
    stream: ch.upstream.stream,
    protocols: [...ch.downstream.protocols],
    primary: ch.downstream.primary,
  }
}
