/**
 * 视频编码判定与本机播放能力（H.265 支持，设计 docs/h265-codec12-support-design-2026-09-29.md §8）。
 *
 * 编码不是用户配置：由 SRS /api/v1/streams 的 video.codec 读出——实测 H.264 为 "H264"、
 * H.265 为 "HEVC"（SRS 7.0.162）。各处判定一律走这里，不要各自写 includes('h265')
 * （ChannelDetail 曾因此永远识别不出 "HEVC"）。
 */

/** SRS / 录像服务报告的编码是否为 H.265（"HEVC"、"H265"、"h.265"、"h265" 都算） */
export function isH265(codec: string | null | undefined): boolean {
  return !!codec && /hevc|h\.?265/i.test(codec)
}

/** 界面显示用：H.264 / H.265；未知时 '-'，其他编码原样大写 */
export function formatCodec(codec: string | null | undefined): string {
  if (!codec) return '-'
  if (isH265(codec)) return 'H.265'
  if (/avc|h\.?264/i.test(codec)) return 'H.264'
  return codec.toUpperCase()
}

// ---- HEVC 档位（level_idc = level × 30）----

/** 探测阶梯：3.1(720p) / 4.0 / 4.1(1080p) / 5.0 / 5.1(4K) / 5.2 / 6.0(8K) */
// 183/186 = L6.1/L6.2：8K 相机常报 6.1，漏探会把能播的设备误判成不可播
const LEVEL_LADDER = [93, 120, 123, 150, 153, 156, 180, 183, 186] as const

/** 各档允许的最大亮度样本数（H.265 附录 A 表 A.8），用于只知道分辨率时推最低档 */
const MAX_LUMA_PS: Array<[number, number]> = [
  [93, 983_040], [120, 2_228_224], [150, 8_912_896], [180, 35_651_584],
]

export interface StreamVideoInfo {
  level?: string | number | null
  width?: number | null
  height?: number | null
}

/** 码流档位：优先用 SRS 报的 level（"5.1"），否则按分辨率推最低档；都没有返回 null */
export function hevcLevelIdc(info: StreamVideoInfo | null | undefined): number | null {
  if (!info) return null
  const lv = typeof info.level === 'number' ? info.level : Number.parseFloat(String(info.level ?? ''))
  if (Number.isFinite(lv) && lv > 0) return Math.round(lv * 30)
  if (info.width && info.height) {
    const ps = info.width * info.height
    for (const [idc, max] of MAX_LUMA_PS) if (ps <= max) return idc
    return 180
  }
  return null
}

/** Main profile、指定档位的 hvc1 MIME */
export function hvc1Mime(levelIdc: number): string {
  return `video/mp4; codecs="hvc1.1.6.L${levelIdc}.B0"`
}

function levelLabel(idc: number): string {
  return `L${idc / 30}`
}

/** 本机浏览器的播放能力（一次探测，缓存） */
export interface CodecSupport {
  /** WebRTC 接收是否支持 H.265（Chrome 136+ 且有硬解、Safari 18+） */
  webrtcH265: boolean
  /** hls.js（MSE / ManagedMediaSource）能播 hvc1 的最高档位；0 = 不能 */
  mseHevcMaxLevel: number
  /** 原生 HLS（Safari/iPad 的 video.src=m3u8）能播 H.265 的最高档位；0 = 没有原生 HLS 或不能 */
  nativeHlsHevcMaxLevel: number
  /** 原生 video 播 hvc1 MP4 文件（录像回放）的最高档位；0 = 不能 */
  fileHevcMaxLevel: number
  /** 取编码帧（SEI）的接口：Chrome 的 createEncodedStreams / 标准 RTCRtpScriptTransform / 无 */
  encodedTransform: 'insertable-streams' | 'script-transform' | null
  /** 显示帧回调 requestVideoFrameCallback */
  videoFrameCallback: boolean
}

export interface CodecSupportEnv {
  getVideoCodecs?: () => Array<{ mimeType: string }> | null | undefined
  isTypeSupported?: (mime: string) => boolean
  canPlayType?: (mime: string) => string
  hasInsertableStreams?: boolean
  hasScriptTransform?: boolean
  hasVideoFrameCallback?: boolean
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function maxLevel(probe: (mime: string) => boolean): number {
  let best = 0
  for (const idc of LEVEL_LADDER) if (safe(() => probe(hvc1Mime(idc)), false)) best = idc
  return best
}

/** 纯函数：给定环境探针，算出能力（单测用它锁行为） */
export function computeCodecSupport(env: CodecSupportEnv): CodecSupport {
  const webrtcH265 = safe(() => (env.getVideoCodecs?.() ?? []).some((c) => /h265|hevc/i.test(c.mimeType)), false)
  const canPlay = (m: string) => (env.canPlayType?.(m) ?? '') !== ''
  const fileHevcMaxLevel = maxLevel(canPlay)
  const nativeHls = safe(() => canPlay('application/vnd.apple.mpegurl'), false)
  return {
    webrtcH265,
    mseHevcMaxLevel: maxLevel((m) => !!env.isTypeSupported?.(m)),
    nativeHlsHevcMaxLevel: nativeHls ? fileHevcMaxLevel : 0,
    fileHevcMaxLevel,
    // Chrome 两个都有时优先 insertable streams：与改造前的 H.264 路径完全一致
    encodedTransform: env.hasInsertableStreams ? 'insertable-streams'
      : env.hasScriptTransform ? 'script-transform' : null,
    videoFrameCallback: !!env.hasVideoFrameCallback,
  }
}

let cached: CodecSupport | null = null

/** 真实浏览器环境的能力（首次调用时探测，之后复用） */
export function getCodecSupport(): CodecSupport {
  if (cached) return cached
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : {}
  const receiver = w.RTCRtpReceiver as
    | { getCapabilities?: (k: string) => { codecs: Array<{ mimeType: string }> } | null; prototype?: object }
    | undefined
  const ms = (w.ManagedMediaSource ?? w.MediaSource) as { isTypeSupported?: (m: string) => boolean } | undefined
  const video = typeof document !== 'undefined' ? document.createElement('video') : null
  cached = computeCodecSupport({
    getVideoCodecs: () => receiver?.getCapabilities?.('video')?.codecs,
    isTypeSupported: ms?.isTypeSupported ? (m) => ms.isTypeSupported!(m) : undefined,
    canPlayType: video ? (m) => video.canPlayType(m) : undefined,
    hasInsertableStreams: !!(receiver?.prototype && 'createEncodedStreams' in receiver.prototype),
    hasScriptTransform: typeof w.RTCRtpScriptTransform === 'function',
    hasVideoFrameCallback: typeof HTMLVideoElement !== 'undefined'
      && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  })
  return cached
}

/** 测试用：清掉缓存 */
export function resetCodecSupportCache(): void {
  cached = null
}

/** 实时播放方式判定（设计 §8.3）：264 维持现状；265 按服务端 + 本机能力 + 码流档位选 */
export type LivePlan =
  | { kind: 'default' }
  | { kind: 'pending' }
  | { kind: 'webrtc' }
  | { kind: 'hls'; engine: 'native' | 'hlsjs'; reason: string }
  | { kind: 'unsupported'; reason: string }

/**
 * @param server.rtcHevc 服务端（SRS ≥ 7.0.33）能否 WebRTC 播 H.265；null = 首次还没拿到；
 *   'unknown' = 这次没问到（后端/SRS 暂时不可达，调用方在重试）——先保守走 HLS，拿到结论后重新判定
 * @param levelIdc 码流档位（hevcLevelIdc）；null = 未知，只要求能播最低档，实际播放失败由播放器报错兜底
 */
export function planLivePlayback(
  codec: string | null | undefined,
  support: CodecSupport,
  server: { rtcHevc: boolean | 'unknown' | null },
  protocols: string[],
  levelIdc: number | null,
): LivePlan {
  if (!isH265(codec)) return { kind: 'default' }
  if (server.rtcHevc === null) return { kind: 'pending' }
  if (protocols.includes('webrtc') && server.rtcHevc === true && support.webrtcH265) return { kind: 'webrtc' }
  const why = server.rtcHevc === 'unknown'
    ? '暂时无法确认流媒体服务的 H.265 能力（正在重试）'
    : !server.rtcHevc
    ? '服务端未启用 H.265 实时播放（流媒体服务版本过低）'
    : !protocols.includes('webrtc')
      ? '该通道未开启 WebRTC'
      : '此设备不支持 H.265 的 WebRTC 播放'
  const need = levelIdc ?? LEVEL_LADDER[0]
  if (protocols.includes('hls')) {
    const suffix = '，改用 HLS（延迟较高，无识别框）'
    // 优先 hls.js：SRS 的 HLS 分片是 MPEG-TS，而 Apple 原生 HLS 规范要求 HEVC 用 fMP4；
    // hls.js 1.7 自带 HEVC-in-TS 解析（HevcVideoParser），转封装成 fMP4 喂 MSE /
    // ManagedMediaSource（iPadOS 17+）。原生 HLS 只在没有 MSE 时作为最后手段（TS 里的 HEVC
    // 能否原生播放未实测）。
    if (support.mseHevcMaxLevel >= need) return { kind: 'hls', engine: 'hlsjs', reason: why + suffix }
    if (support.nativeHlsHevcMaxLevel >= need) return { kind: 'hls', engine: 'native', reason: why + suffix }
  }
  const best = Math.max(support.nativeHlsHevcMaxLevel, support.mseHevcMaxLevel)
  const hlsWhy = !protocols.includes('hls')
    ? '该通道未开启 HLS，无法降级'
    : best > 0 && levelIdc !== null
      ? `此设备的 H.265 解码最高到 ${levelLabel(best)}，本路码流为 ${levelLabel(levelIdc)}`
      : '此设备也无法用 HLS 播放 H.265'
  return {
    kind: 'unsupported',
    reason: `${why}；${hlsWhy}。请使用 iPad/Safari 或有 H.265 硬件解码的 Chrome/Edge`,
  }
}

/** 录像回放：本机能否播放该档位的 hvc1 MP4（档位未知按最低档） */
export function canPlayHevcFile(support: Pick<CodecSupport, 'fileHevcMaxLevel'>, levelIdc: number | null): boolean {
  return support.fileHevcMaxLevel > 0 && support.fileHevcMaxLevel >= (levelIdc ?? LEVEL_LADDER[0])
}
