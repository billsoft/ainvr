import { PROTO_LABEL } from './protocolLabels'
import { LivePlayerToolbar } from './LivePlayerToolbar'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import flvjs from 'flv.js'
import Hls from 'hls.js'
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import {
  buildFallbackChain,
  createMachine,
  currentProtocol,
  isNoSignalHint,
  onFail,
  onSuccess,
  switchTo,
  type PlayProtocol,
  type PlayerMachineState,
} from '@/utils/playerMachine'
import { buildPlayUrl } from '@/utils/format'
import {
  attachWebRTC, extractWebrtcJitterBufferRaw, extractWebrtcVideoStats, webrtcPlayUrls,
  WebrtcWatchdog,
} from './webrtc'
import { inspectSeiDetections, SeiFrameCache, type SeiFrameDetections } from './seiDetections'
import { AiDetectionOverlay } from './AiDetectionOverlay'
import { SavedZoneOverlay } from './SavedZoneOverlay'
import type { ZonePreviewSource } from '@/features/zoneSourceGeometry'
import { ArrivalTimeline, DisplayDelayEstimator, extractDecodeStatsRaw } from './approxAlign'
import { reportOverlayDiag } from '@/api/diagService'
import type { DownstreamProtocol } from '@/types/channel'
import {
  formatCodec, getCodecSupport, hevcLevelIdc, isH265, planLivePlayback, type StreamVideoInfo,
} from '@/utils/codec'
import { useServerRtcHevc } from '@/hooks/useServerRtcHevc'
import { PanoramaView } from './PanoramaView'
import { usePlayerView } from './PlayerViewControls'

// 诊断上报轮询间隔——见 diagService.ts 头注。5s 足够跟断流重连事件（间隔通常
// 数十秒到数分钟）对齐做时间关联分析，又不会因为轮询过密而把日志刷满。
const DIAG_WEBRTC_STATS_INTERVAL_MS = 5000

// WebRTC 延迟/冻屏看门狗轮询间隔（2026-09-13 延迟累积修复）。2s 一个点：
// 冻屏 8s 内可发现（4 个点）、高延迟需连续 3 点（6s）确认，再算上 20s 开播
// 宽限，误报面很小，最坏的重连代价也只是重新开播（典型 3~4s 初始延迟）。
const WEBRTC_WATCHDOG_POLL_MS = 2000
// 自动重连节流：90s 滑窗内最多 3 次。防止"新连接恰好又落在很老的 GOP
// 缓存位置→又被判高延迟→再重连"的震荡，滑窗释放额度后继续检测。
const WEBRTC_AUTO_RECONNECT_MAX = 3
const WEBRTC_AUTO_RECONNECT_WINDOW_MS = 90_000
// 恢复链路（后台最小化导致的失败遮罩问题，2026-10-08 根因：直播降级链只有
// WebRTC 一个协议，"连接中"收到任何失败都会把链推尽、进入无出口的失败终态）：
// - 看门狗/断线触发的重连只在"播放中"生效（reducer 'reconnect'），连接中的重复事件忽略；
// - 隐藏时不判冻屏、不重连（后台浏览器本就不解码，判停滞全是误报）；
// - 连接中超过 WEBRTC_CONNECT_TIMEOUT_MS 才算一次失败；失败后每 FAILED_RETRY_MS 自动重试；
// - 回到前台：非播放中、AI 通道（恢复逐帧同步）、或隐藏超过 VISIBILITY_RECONNECT_AFTER_MS 才重连，
//   短暂切换标签页不让所有画面黑一下。
const WEBRTC_CONNECT_TIMEOUT_MS = 30_000
const FAILED_RETRY_MS = 5_000
const VISIBILITY_RECONNECT_AFTER_MS = 10_000

export interface VideoPlayerProps {
  onArming?: (video: HTMLVideoElement) => void
  compactZones?: boolean
  savedZoneSource?: ZonePreviewSource
  allowPanorama?: boolean
  /** 展示标题（控制栏/覆盖层）；传空串可关闭该角标（配合 footerBadge 使用，避免重复显示同一个名字） */
  title: string
  /** 通道启用的下行协议 */
  protocols: DownstreamProtocol[]
  /** 主播放协议（降级链首位） */
  primary: DownstreamProtocol
  stream: { host: string; app: string; stream: string }
  muted?: boolean
  showControls?: boolean
  className?: string
  onStateChange?: (s: PlayerMachineState) => void
  /** 左下角悬浮的"通道名 + 在线状态点"角标（聚焦大画面场景用） */
  footerBadge?: { name: string; online: boolean }
  /** 底层 <video> 元素就绪/卸载时回调——供需要读取 videoWidth/videoHeight
   * 的调用方拿到引用。可选字段，不传不影响任何现有行为。 */
  onVideoElement?: (video: HTMLVideoElement | null) => void
  /** 这路流是某个 AI 通道的输出流时传它的 id——传了就在控制栏出现"识别框"
   * 开关，播放器内部自己叠加检测框图层（见 AiDetectionOverlay），不用调用方
   * 自己接线。不是 AI 输出流（没有识别结果可显示）时不传，控制栏不出现这个
   * 按钮。这样实时监看宫格/聚焦大画面/AI 通道衍生流预览用的是同一份实现，
   * 不用每个页面各自接一遍。 */
  aiChannelId?: string
  /** 传了就在 webrtc 协议下每 5s 上报一次 RTCPeerConnection.getStats() 里的
   * jitterBufferDelay 等播放延迟指标（见 webrtc.ts::extractWebrtcVideoStats），
   * 用这个字符串当日志里的标识——临时排查"AI 输出流比原始流延迟好几秒"问题
   * 用（见 diagService.ts 头注）。不传不会有任何额外请求。非 webrtc 协议下
   * 不生效（getStats 里的 jitterBufferDelay 是 WebRTC 特有字段，flv/hls 没有
   * 对应概念）。 */
  diagLabel?: string
  /** 源流的视频参数（SRS /api/v1/streams 的 video：codec/level/宽高）。H.265 时据此
   * 选择播放方式（设计 §8.3）；H.264 或不传时行为与改造前完全一致。编码变化时重建连接。 */
  videoInfo?: StreamVideoInfo & { codec?: string | null }
}

type Action =
  | { type: 'reconnect'; reason: string }
  | { type: 'fail'; reason?: string }
  | { type: 'success' }
  | { type: 'switch'; protocol: PlayProtocol }
  | { type: 'retry' }
  | { type: 'reset'; chain: PlayProtocol[] }

function reducer(s: PlayerMachineState, a: Action): PlayerMachineState {
  switch (a.type) {
    case 'reconnect':
      // Duplicate health/ICE events during one recovery must not exhaust the chain.
      return s.status === 'playing' ? onFail(s, a.reason) : s
    case 'success':
      // 超时后旧连接仍可能收到首帧；当前连接确认恢复后取消自动重试。
      return onSuccess(s.status === 'failed' && s.chain[s.index]
        ? { ...s, status: 'connecting', lastError: undefined } : s)
    case 'fail':
      return onFail(s, a.reason)
    case 'switch':
      return switchTo(s, a.protocol)
    case 'retry':
      return switchTo(s, s.chain[s.index] ?? s.chain[0]!)
    case 'reset':
      // 播放方式变了（编码变化、能力判定到位）：换协议链并强制新连接（generation +1）
      return { ...createMachine(a.chain), generation: s.generation + 1 }
  }
}



/**
 * 通用播放器：多协议 + 自动降级（主协议→FLV→HLS）
 * 生命周期铁律（防 MSE 泄漏）：pause → destroy → 清 video src/load；
 * webrtc：pc.close() + srcObject=null。mounted flag 防卸载后 setState。
 */
export function VideoPlayer({
  title,
  protocols,
  primary,
  stream,
  muted = true,
  showControls = true,
  className,
  onStateChange,
  footerBadge,
  onVideoElement,
  aiChannelId,
  savedZoneSource,
  onArming,
  compactZones = false,
  diagLabel,
  videoInfo,
  allowPanorama = false,
}: VideoPlayerProps) {
  // 播放方式（设计 §8.3）：H.264 维持现状；H.265 按服务端（SRS 版本）+ 本机能力 + 码流档位
  // 选 WebRTC / HLS 兜底 / 明确不可播。服务端能力只在 H.265 时才去取。
  const h265 = isH265(videoInfo?.codec)
  const serverRtcHevc = useServerRtcHevc(h265)
  const levelIdc = hevcLevelIdc(videoInfo)
  const plan = useMemo(
    () => planLivePlayback(videoInfo?.codec, getCodecSupport(), { rtcHevc: serverRtcHevc }, protocols, levelIdc),
    [videoInfo?.codec, serverRtcHevc, protocols, levelIdc],
  )
  const planKey = plan.kind === 'hls' ? `hls:${plan.engine}` : plan.kind
  // 直播只走 WebRTC：SEI 逐帧精确对齐要求 WebRTC 的 Encoded Transform + rVFC
  // 帧身份绑定，FLV/HLS 无法可靠地将识别框与显示帧一一对应。局域网内
  // WebRTC 连通性有保障，去掉 FLV/HLS 选项避免用户切到不对齐的协议。
  // 例外：H.265 在本机/服务端播不了 WebRTC 时以 HLS 兜底（无识别框，画面上说明原因）。
  const hasWebRtc = protocols.includes('webrtc')
  const effectiveProtocols: DownstreamProtocol[] = plan.kind === 'hls'
    ? ['hls']
    : hasWebRtc
      ? ['webrtc']
      : protocols
  const effectivePrimary = plan.kind === 'hls' ? 'hls' : hasWebRtc ? 'webrtc' : primary
  const effectiveKey = effectiveProtocols.join(',')
  const chain = useMemo(
    () => buildFallbackChain(effectivePrimary, effectiveProtocols),
    // effectiveProtocols 每次渲染都是新数组，按内容键记忆
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectivePrimary, effectiveKey],
  )
  const [state, dispatch] = useReducer(reducer, chain, createMachine)
  const statusRef = useRef(state.status)
  statusRef.current = state.status
  const activeGenerationRef = useRef<number | null>(null)
  const generationRef = useRef(state.generation)
  generationRef.current = state.generation
  // H.265 能力未定（pending）或不可播（unsupported）时不建任何连接
  const canConnect = plan.kind !== 'pending' && plan.kind !== 'unsupported'
  // 播放方式或协议链变化 → 重建连接（首次挂载除外：reducer 初值已经是当前链）
  const resetKey = `${planKey}|${chain.join(',')}`
  const lastResetKeyRef = useRef(resetKey)
  useEffect(() => {
    if (lastResetKeyRef.current === resetKey) return
    lastResetKeyRef.current = resetKey
    dispatch({ type: 'reset', chain })
  }, [resetKey, chain])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const view = usePlayerView(containerRef)
  const { panorama, panoramaReset, panoramaError, panoramaFailed, receivePanoramaCamera, drawPanoramaFrame, fullscreenError } = view
  const mountedRef = useRef(true)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [paused, setPaused] = useState(false)
  const [isMuted, setIsMuted] = useState(muted)
  // 叠框状态（设计 §8.2）：synced=逐帧；approx=近似；unsupported=播放方式没有 SEI 通道；
  // no_device=浏览器取不到编码帧；no_sei=通道在但流里没扫到识别数据
  const [overlaySync, setOverlaySync] = useState<
    'syncing' | 'synced' | 'approx' | 'unsupported' | 'no_device' | 'no_sei' | 'pipeline_error'
  >('syncing')
  const [overlayFailure, setOverlayFailure] = useState('未收到逐帧识别数据')
  // 稳定引用：AiDetectionOverlay 的 rVFC effect 拿它当依赖，引用变化会反复
  // 取消/重建监听，导致漏帧或重复订阅。
  const onOverlayMode = useCallback(
    (mode: 'exact' | 'approx') => setOverlaySync(mode === 'exact' ? 'synced' : 'approx'),
    [],
  )
  // 默认开——这路流已经被判定为 AI 输出流（aiChannelId 有值）时，用户大概率
  // 就是为了看识别框才点进来的，不用每次都手动开一遍；不想看直接点掉。
  const [overlayEnabled, setOverlayEnabled] = useState(true)
  // WebRTC 自动重连节流：记录最近自动重连的时间戳（ms），见常量注释。
  // 用 ref 不用 state——纯事件节流，不需要触发渲染。
  const autoReconnectsRef = useRef<number[]>([])
  const lastReconnectWarningRef = useRef(-Infinity)

  // 画面是否真的在动（状态机兜底）：状态机可能因降级/重连/异步事件落后于
  // 真实 video 元素（典型现象：failed 遮罩盖在还在播的画面上）。这里以
  // timeupdate 中 currentTime 是否实际推进为判据，连续 5 秒没有推进就视为
  // 静止。只用于 UI 遮罩显示的兜底判断，不影响状态机本身的降级/重试逻辑。
  const [videoHasSignal, setVideoHasSignal] = useState(false)
  const lastTimeRef = useRef<number>(0)
  const signalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kickSignalWatchdog = useCallback(() => {
    if (signalTimerRef.current) clearTimeout(signalTimerRef.current)
    signalTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setVideoHasSignal(false)
    }, 5000)
  }, [])

  // 逐帧精确识别框：编码帧一到就把它自带的 SEI 解出来按 RTP 时间戳存起来，
  // 叠加层在这一帧真正出画时（requestVideoFrameCallback）按同一个时间戳取回。
  // 必须缓存一段而不是只留最新——收到帧总是早于显示帧（中间隔着解码+抖动
  // 缓冲），只留最新等于把框又绑回"刚收到的帧"，重新引入几百毫秒超前。
  const seiCacheRef = useRef(new SeiFrameCache())
  const receiveStatsRef = useRef({ encoded: 0, parsed: 0, withTargets: 0, malformed: 0 })
  const [overlayDiagnostics] = useState(() => new URLSearchParams(window.location.search).get('overlayDiagnostics') === '1')
  const getReceiveStats = useCallback(() => ({ ...receiveStatsRef.current }), [])
  useEffect(() => {
    receiveStatsRef.current = { encoded: 0, parsed: 0, withTargets: 0, malformed: 0 }
    seiCacheRef.current.clear()
    arrivalRef.current.clear()
  }, [aiChannelId, state.generation])
  // useCallback 空依赖：AiDetectionOverlay 拿它做 rVFC effect 依赖，引用必须稳定
  const getSeiForFrame = useCallback(
    (rtpTimestamp: number) => seiCacheRef.current.getForDisplay(rtpTimestamp),
    [],
  )
  // 近似对齐（设计 §8.2）：浏览器不给显示帧的 rtpTimestamp 时，按"到达时刻 + 实测延迟 D"
  // 取帧。D 每 2s 用 getStats 最近窗口的增量重估，没有累加项，误差不随时间累计。
  // 模型：D ≈ 抖动缓冲 + 解码；"到达"取编码帧交到 JS 的时刻，与抖动缓冲计时起点
  // （首包到达）差一个"组帧 + 回调调度"的有界偏移——实机（iPad）标定前只算近似，
  // 画面上如实标注"近似对齐"，诊断上报 matchType='sei-approx'。
  const arrivalRef = useRef(new ArrivalTimeline<SeiFrameDetections>(300))
  const delayRef = useRef(new DisplayDelayEstimator())
  const getSeiApprox = useCallback((displayMs: number) => {
    const d = delayRef.current.current
    if (d === null) return null
    const hit = arrivalRef.current.pickPast(displayMs - d, 300, value => value.inferred !== false)
    return hit ? { ...hit.value, displayAgeMs: hit.ageMs } : null
  }, [])
  // aiChannelId 的 ref 版本：给 onEncodedVideoFrame 回调内部做动态判定用。
  //
  // 为什么需要它：encodedInsertableStreams 必须在 new RTCPeerConnection()
  // 时声明，建连后补不上；刷新页面时 AI 通道配置（outputIds）是异步加载的
  // （useMonitorCatalog 1.5s 宽限），VideoPlayer 先挂载时 aiChannelId=
  // undefined，如果那时才决定"不开编码帧通道"，等配置到了就永远补不上了——
  // 这正是"刷新页面后识别框永远同步不了、必须关了重开"的根因。
  //
  // 解决方案：WebRTC 建连时无条件开 encoded 通道，但回调内部读这个 ref
  // 判断当前是否真的需要解析 SEI：
  //   - aiChannelId 为空 → 直接跳过，空转开销极低（一次 ref 判断 + 早返回）
  //   - aiChannelId 到位 → 立刻开始解析并写缓存，无需重连、无黑屏闪烁
  // 普通监看流上这点开销可以忽略（30fps 下每帧一次函数调用 + ref 判断，
  // 不比一次 UUID 扫描多多少），换来的是首屏无闪烁 + 异步配置无感生效。
  const aiChannelIdRef = useRef<string | undefined>(aiChannelId)
  useEffect(() => {
    aiChannelIdRef.current = aiChannelId
  }, [aiChannelId])

  // WebRTC 看门狗/连接中断统一走这个带节流的重连入口：playing 阶段 dispatch
  // reconnect 会被 playerMachine 解释为"同协议重连"（generation+1 重建 PC），这是
  // WebRTC 路径唯一能追回直播点的手段（浏览器不会自己追帧）。
  const scheduleWebRtcReconnect = useCallback((reason: string) => {
    if (!mountedRef.current || document.hidden || statusRef.current !== 'playing') return
    const now = performance.now()
    const recent = autoReconnectsRef.current.filter(
      (t) => now - t < WEBRTC_AUTO_RECONNECT_WINDOW_MS,
    )
    if (recent.length >= WEBRTC_AUTO_RECONNECT_MAX) {
      // 滑窗内重连够多了还在触发：多半是源流本身异常或新连接又落在老 GOP
      // 缓存位置，暂停触发避免重连震荡，滑窗释放额度后恢复检测
      if (now - lastReconnectWarningRef.current >= 30_000) {
        lastReconnectWarningRef.current = now
        console.warn('[VideoPlayer] WebRTC 自动重连已达节流上限，稍后重试:', reason)
      }
      return
    }
    recent.push(now)
    autoReconnectsRef.current = recent
    // 同一轮事件循环的重复回调也不能重复扣额度。
    statusRef.current = 'connecting'
    dispatch({ type: 'reconnect', reason })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 底层 video 元素在挂载时就已经通过 ref 就绪（React 保证 ref 挂载先于
  // effect 运行），这里把它转交给调用方；卸载时回传 null 让调用方清理。
  // videoEl 这份 state 是同一件事的内部版本——AiDetectionOverlay 不能直接读
  // videoRef.current：ref 变化不触发重渲染，若挂载后恰好没有其它状态变化
  // 触发 VideoPlayer 重渲（比如一直卡在 connecting 没进 playing），叠加层会
  // 永远拿着挂载前那次渲染的 null，identical 于"没在监看"却查不出原因。
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  useEffect(() => {
    setVideoEl(videoRef.current)
    onVideoElement?.(videoRef.current)
    return () => {
      setVideoEl(null)
      onVideoElement?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => onStateChange?.(state), [state, onStateChange])

  const proto = currentProtocol(state)

  // 非 WebRTC 协议下没有逐帧 SEI 路径，识别框无法精确对齐，直接标注不支持，
  // 不让用户对着"同步中…"傻等。
  useEffect(() => {
    if (!aiChannelId) return
    if (proto && proto !== 'webrtc') setOverlaySync('unsupported')
  }, [aiChannelId, proto])

  // aiChannelId 从无到有时，把 overlaySync 切到 syncing（如果当前正在
  // webrtc playing）。WebRTC 连接本身不需要重建——编码帧通道已经在跑了，
  // 只是之前 aiChannelId 为空时回调直接返回没往缓存里写。现在开始写了，
  // 让 UI 从"初始态"进入"正在同步"。
  // ⚠️ 只在 aiChannelId 本身变化时做一次，不能以 overlaySync 为依赖：那样任何已判定的
  // 状态（approx 近似 / no_device 设备不支持 / no_sei 未收到数据）一设置就被冲回 syncing——
  // 近似模式只上报一次，会永远显示"同步中"；no_sei 的重试上限也会失效。
  // 连接重建时的复位由建连/清理路径负责（setOverlaySync('syncing')），不在这里。
  const lastAiChannelIdRef = useRef(aiChannelId)
  useEffect(() => {
    if (lastAiChannelIdRef.current === aiChannelId) return
    lastAiChannelIdRef.current = aiChannelId
    if (!aiChannelId || proto !== 'webrtc' || state.status !== 'playing') return
    setOverlaySync('syncing')
  }, [aiChannelId, proto, state.status])

  // 首次同步超时要区分接收、解析和显示对齐；不能把所有失败都说成流没有 SEI。
  useEffect(() => {
    if (!overlayEnabled || !aiChannelId || proto !== 'webrtc' || overlaySync !== 'syncing') return
    if (state.status !== 'playing') return
    const t = setTimeout(() => {
      if (!mountedRef.current) return
      const stats = { ...receiveStatsRef.current }
      const reason = stats.encoded === 0
        ? '未收到编码帧，识别框接收尚未恢复'
        : stats.parsed > 0
        ? '已收到识别数据，尚未与画面对齐'
        : stats.malformed > 0
        ? '收到识别信息，但解析失败'
        : '未收到逐帧识别数据（当前流可能不含识别信息）'
      setOverlayFailure(reason)
      console.warn('[sei-overlay] initial-sync-timeout', {
        channelId: aiChannelId, generation: state.generation,
        ...stats, retries: noSeiRetryRef.current, hidden: document.hidden,
      })
      setOverlaySync('no_sei')
    }, 8000)
    return () => clearTimeout(t)
  }, [overlayEnabled, aiChannelId, proto, overlaySync, state.status, state.generation])

  // 预算属于当前通道，不能在 connecting 时归零，否则永久无 SEI 会无限重连。
  const noSeiRetryRef = useRef(0)
  const MAX_NO_SEI_RETRIES = 3

  // 真正重建接收链路，复用页面恢复时的限流入口，而不是仅切换提示文字。
  // 达到上限后仍监听晚到的数据；成功对齐依然可以自行恢复显示。
  useEffect(() => {
    if (!overlayEnabled || !aiChannelId || proto !== 'webrtc') return
    if (overlaySync !== 'no_sei') return
    if (state.status !== 'playing') return
    if (noSeiRetryRef.current >= MAX_NO_SEI_RETRIES) return
    const t = setTimeout(() => {
      if (!mountedRef.current) return
      noSeiRetryRef.current += 1
      scheduleWebRtcReconnect('识别框首次同步超时，重建接收连接')
    }, 15000)
    return () => clearTimeout(t)
  }, [overlayEnabled, aiChannelId, proto, overlaySync, state.status, scheduleWebRtcReconnect])

  useEffect(() => {
    noSeiRetryRef.current = 0
  }, [aiChannelId, stream.host, stream.app, stream.stream])

  // 回到前台时决定是否重建 WebRTC：后台浏览器停止解码、直播点继续前进。
  // 非播放中（连接中/失败）一律重建；AI 通道必须重建以恢复逐帧同步（新一代
  // 播放器会清空精确 SEI 缓存）；普通通道只在隐藏足够久时重建，短暂切换标签页
  // 画面仍在追直播，不必让所有画面黑一下、同时冲击流媒体服务。
  useEffect(() => {
    if (!canConnect || !state.chain.includes('webrtc')) return
    let hiddenAt: number | null = document.hidden ? performance.now() : null
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now()
        return
      }
      const hiddenFor = hiddenAt === null ? 0 : performance.now() - hiddenAt
      hiddenAt = null
      const ai = !!aiChannelIdRef.current
      if (statusRef.current === 'playing' && !ai && hiddenFor < VISIBILITY_RECONNECT_AFTER_MS) return
      autoReconnectsRef.current = []
      if (ai) setOverlaySync('syncing')
      dispatch({ type: 'retry' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [canConnect, state.chain])

  // 失败不是终点：可见时按固定间隔自动重试（隐藏时等回到前台再说）。
  useEffect(() => {
    if (!canConnect || state.status !== 'failed' || !state.chain.length) return
    const timer = setInterval(() => {
      if (!document.hidden) dispatch({ type: 'retry' })
    }, FAILED_RETRY_MS)
    return () => clearInterval(timer)
  }, [canConnect, state.status, state.chain])

  // 连接中的兜底：ICE 可能连上却始终不出画面（连接中的重连事件已被忽略），
  // 超时才算一次失败。隐藏时不计（后台本就不出画面）。
  useEffect(() => {
    if (!canConnect || state.status !== 'connecting') return
    const timer = setTimeout(() => {
      if (!document.hidden) dispatch({ type: 'fail', reason: '等待视频画面超时' })
    }, WEBRTC_CONNECT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [canConnect, state.status, state.generation])

  // 播放器挂载/切换效果
  useEffect(() => {
    if (state.status !== 'connecting') return
    const video = videoRef.current
    if (!proto || !video || !canConnect) return

    let cancelled = false
    activeGenerationRef.current = state.generation
    let localCleanup: (() => void) | null = null

    const url = proto === 'flv' || proto === 'hls'
      ? `/media/${encodeURIComponent(stream.app)}/${encodeURIComponent(stream.stream)}.${proto === 'flv' ? 'flv' : 'm3u8'}`
      : buildPlayUrl(proto, stream)

    const run = async () => {
      try {
        if (proto === 'flv') {
          if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 HTTP-FLV 播放')
          const player = flvjs.createPlayer({
            type: 'flv',
            url,
            isLive: true,
            hasVideo: true,
          }, {
            // ===== 直播低延迟优化 =====
            // 追帧：延迟超过阈值时加速播放追赶
            liveBufferLatencyChasing: true,
            // 最大延迟（秒），超过就追
            liveBufferLatencyMaxLatency: 3.0,
            // 最小残留缓冲（秒），低于就暂停追帧防止卡
            liveBufferLatencyMinRemain: 0.5,
            // ===== 缓冲优化 =====
            // 初始缓冲：攒够这么多再开始播，避免首帧后立刻卡
            stashInitialSize: 512 * 1024, // 512KB
            // 自动清理已播 buffer，防止内存涨爆
            autoCleanupSourceBuffer: true,
            // 加载超时
            loadTimeout: 10000,
          } as Record<string, unknown>)

          // flv.js ERROR 事件真实签名：(type, detail, info)。
          // ⚠️ 之前这里判断"是否致命"时看错了字段：把 type（第一个参数，真正的
          // ErrorTypes={NetworkError|MediaError|OtherError}）丢了，反而拿 detail
          // （第二个参数，细粒度原因 ErrorDetails，取值是 Exception/
          // HttpStatusCodeInvalid/ConnectingTimeout/EarlyEof/UnrecoverableEarlyEof/
          // MediaMSEError/FormatError/... 之类）去比对 'NetworkError'/'MediaError'/
          // 'NetworkStatus' 这些值——detail 永远不可能等于这些字符串，'NetworkStatus'
          // 更是 flv.js 里根本不存在的字符串。净效果：真实的网络/解码致命错误从未
          // 被判定为致命，既不会降级到 HLS，也不会触发 playing 阶段的自动重连。
          // 致命与否应该看粗粒度的 type：NetworkError/MediaError 视为致命，
          // OtherError（多是缓冲溢出等可自愈问题）不视为致命。
          const onError = (type: string, detail: string, _info: any) => {
            if (cancelled || !mountedRef.current) return

            const isFatal = type === 'NetworkError' || type === 'MediaError'

            if (isFatal) {
              dispatch({ type: 'fail', reason: `FLV ${type}:${detail}` })
            }
          }
          player.on(flvjs.Events.ERROR, onError)
          player.attachMediaElement(video)
          player.load()
          void video.play().catch(() => {
            /* autoplay 被拦截时用户手动播放 */
          })
          localCleanup = () => {
            player.off(flvjs.Events.ERROR, onError)
            // 铁律：先 pause 再 destroy，防 MSE sourceBuffer 卡 updating
            try {
              player.pause()
            } catch {
              /* not loaded yet */
            }
            player.destroy()
          }
        } else if (proto === 'hls') {
          // H.265 兜底按判定结果选引擎（native=Safari 原生 / hlsjs=MSE）；H.264 维持原逻辑
          const nativeHls = plan.kind === 'hls'
            ? plan.engine === 'native'
            : video.canPlayType('application/vnd.apple.mpegurl')
          if (nativeHls) {
            video.src = url
            void video.play().catch(() => {})
            localCleanup = () => {
              video.removeAttribute('src')
              video.load()
            }
          } else {
            if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS 播放')
            const hls = new Hls({
              liveDurationInfinity: true,
              // 防御性上限：7x24 长时间监看场景下，不加限制的话前向/回收缓冲会
              // 缓慢无限增长（liveDurationInfinity 只是不让 hls.js 在直播流上做
              // duration 相关的 seek 限制，不等于不限制 buffer 大小）。
              maxBufferLength: 30, // 前向缓冲上限（秒）
              liveBackBufferLength: 30, // 已播放部分的回收窗口（秒）
            })
            const onError = (_e: string, data: { fatal: boolean; details?: string }) => {
              if (data.fatal && !cancelled && mountedRef.current) {
                dispatch({ type: 'fail', reason: `HLS ${data.details ?? 'error'}` })
              }
            }
            hls.on(Hls.Events.ERROR, onError)
            hls.loadSource(url)
            hls.attachMedia(video)
            void video.play().catch(() => {})
            localCleanup = () => {
              hls.off(Hls.Events.ERROR, onError)
              hls.destroy()
              video.removeAttribute('src')
              video.load()
            }
          }
        } else {
          seiCacheRef.current.clear()
          arrivalRef.current.clear()
          delayRef.current.reset()
          if (aiChannelId) setOverlaySync('syncing')
          const { api, streamurl } = webrtcPlayUrls(stream.host, stream.app, stream.stream)
          const handle = await attachWebRTC(video, {
            api,
            streamurl,
            // 建连之后 ICE failed/disconnected(5s 未恢复) → 自动重连。
            // 注意 reason 文案不要含"无流/network/404"，否则失败页会被
            // 误判成"无视频信号"（见 isNoSignalHint）。
            onConnectionLost: (why) => {
              if (!cancelled) scheduleWebRtcReconnect(`WebRTC 连接中断(${why})，自动重连`)
            },
            onEncodedPipelineError: () => {
              if (cancelled || !mountedRef.current) return
              setOverlaySync('pipeline_error')
              setOverlayFailure('识别信息同步中断，正在尝试恢复')
              scheduleWebRtcReconnect('视频处理链路中断，自动重连')
            },
            // 无条件挂编码帧回调：aiChannelId 是否到位由回调内部通过
            // aiChannelIdRef 动态判断，见该 ref 上方注释。这样刷新首屏
            // AI 配置异步到达时无需重连 PC（无黑屏闪烁），普通源流上
            // 只是多一次 ref 判断 + 早返回，开销可忽略。
            onEncodedVideoFrame: (rtpTimestamp, data, arrivalMs) => {
              if (cancelled || !aiChannelIdRef.current) return
              // 没有 SEI 的视频帧通常没有参与推理，不能当成“检测到零个目标”。
              const { present, result: parsed } = inspectSeiDetections(data)
              const counters = receiveStatsRef.current
              counters.encoded++
              if (parsed) counters.parsed++
              if (parsed?.detections.length || parsed?.grounding?.points.length) counters.withTargets++
              // Worker sends an empty buffer when there is no UUID. Legacy tap
              // sends the complete frame; only count malformed identified SEI.
              if (!parsed && present) counters.malformed++
              const result = parsed ?? { ptsNs: null, ageMs: null, detections: [], inferred: false }
              seiCacheRef.current.put(rtpTimestamp, result)
              arrivalRef.current.push(arrivalMs, result)
            },
          })
          if (cancelled || !mountedRef.current) {
            handle.close()
            return
          }
          // 编码帧和显示回调可能早于建连 Promise 返回；不要覆盖已成功的模式。
          if (aiChannelIdRef.current && !handle.encodedFramesSupported) setOverlaySync('no_device')
          // diagLabel 传了才轮询——避免给每一路没人关心的 webrtc 播放都加请求。
          // 见 VideoPlayerProps.diagLabel 头注。
          let diagTimer: ReturnType<typeof setInterval> | null = null
          if (diagLabel) {
            diagTimer = setInterval(() => {
              void handle.getStats()
                .then((report) => {
                  const s = extractWebrtcVideoStats(report)
                  reportOverlayDiag({
                    channelId: diagLabel,
                    event: 'webrtc-stats',
                    jitterBufferDelayS: s.jitterBufferDelayS,
                    framesDecoded: s.framesDecoded,
                    freezeCount: s.freezeCount,
                    pauseCount: s.pauseCount,
                  })
                })
                .catch(() => {
                  // getStats 本身失败（连接刚断等）不影响画面——静默丢弃，下一轮再试
                })
            }, DIAG_WEBRTC_STATS_INTERVAL_MS)
          }
          // 延迟/冻屏看门狗（2026-09-13 延迟累积修复）：所有 webrtc 播放
          // 都开，不依赖 aiChannelId/diagLabel。判定逻辑（宽限/连续确认/
          // 冻屏超时）都在 WebrtcWatchdog 里，这里只负责采样和触发重连。
          const watchdog = new WebrtcWatchdog()
          const watchdogTimer = setInterval(() => {
            if (document.hidden) return
            void handle.getStats()
              .then((report) => {
                if (cancelled || !mountedRef.current || document.hidden) return
                const raw = extractWebrtcJitterBufferRaw(report)
                const { framesDecoded } = extractWebrtcVideoStats(report)
                delayRef.current.sample(extractDecodeStatsRaw(report))
                if (overlayDiagnostics) {
                  const inbound = Array.from(report.values()).find((r) => r.type === 'inbound-rtp' && r.kind === 'video')
                  console.info('[player-receive]', JSON.stringify({ stream: stream.stream, generation: state.generation,
                    encoded: receiveStatsRef.current.encoded, parsed: receiveStatsRef.current.parsed,
                    bytes: inbound?.bytesReceived, packets: inbound?.packetsReceived,
                    lost: inbound?.packetsLost, framesReceived: inbound?.framesReceived,
                    framesDecoded, keyFramesDecoded: inbound?.keyFramesDecoded,
                    decoder: inbound?.decoderImplementation, ready: video.readyState }))
                }
                const verdict = watchdog.sample(performance.now(), raw, framesDecoded)
                if (verdict === 'latency') {
                  scheduleWebRtcReconnect('WebRTC 延迟过大，自动重连追直播点')
                } else if (verdict === 'freeze') {
                  scheduleWebRtcReconnect('WebRTC 画面长时间停滞，自动重连追直播点')
                }
              })
              .catch(() => {
                // getStats 失败（连接刚断等）不影响画面，下一轮再试
              })
          }, WEBRTC_WATCHDOG_POLL_MS)
          localCleanup = () => {
            if (diagTimer) clearInterval(diagTimer)
            clearInterval(watchdogTimer)
            // 旧会话的编码帧一律丢弃：RTP 时间戳在新连接里会重新起头，
            // 留着不但没用，还可能跟新会话的时间戳撞上画出错帧的框。
            seiCacheRef.current.clear()
            arrivalRef.current.clear()
            delayRef.current.reset()
            if (aiChannelId && mountedRef.current) setOverlaySync('syncing')
            handle.close()
          }
        }
        if (!cancelled && mountedRef.current) {
          cleanupRef.current?.()
          cleanupRef.current = localCleanup
        } else {
          localCleanup?.()
        }
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          activeGenerationRef.current = null
          dispatch({ type: 'fail', reason: e instanceof Error ? e.message : String(e) })
        }
        localCleanup?.()
      }
    }
    void run()

    return () => {
      cancelled = true
      activeGenerationRef.current = null
      // 组件/源切换卸载：执行当前清理并强制复位 video
      try {
        cleanupRef.current?.()
      } catch {
        /* ignore */
      }
      cleanupRef.current = null
      try {
        video.pause()
      } catch {
        /* ignore */
      }
      video.srcObject = null
    }
    // ⚠️ 依赖只用 state.generation，不能用 state.status/state.index/proto：
    // 播放成功（connecting→playing）也会让这三者发生变化，若列进依赖数组，
    // effect 会在成功的瞬间重跑一次——先执行上一轮的 cleanup（销毁刚建立好的
    // 播放器、video.srcObject=null），新一轮 effect body 又因为 status 已经
    // 变成 'playing'（非 'connecting'）而直接 return，不会重新建连——现象就是
    // "画面闪一下就黑屏"。generation 只在 playerMachine.ts 里"确实需要发起新
    // 连接"的转移（协议推进/同协议重连/手动切换协议）才 +1，onSuccess 不动它，
    // 从根上避免这次误判。
    // stream 对象由父层 useMemo 保持稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.generation, stream.host, stream.app, stream.stream])

  // playing 事件 → success
  // timeupdate → 校验 currentTime 实际推进，作为 videoHasSignal 兜底判据
  // （状态机可能落后于真实 video：failed 遮罩盖在还在播的画面上）。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = () => {
      if (mountedRef.current && activeGenerationRef.current === generationRef.current) {
        setPaused(false)
        dispatch({ type: 'success' })
      }
    }
    const onPause = () => {
      if (mountedRef.current) setPaused(true)
    }
    const onTimeUpdate = () => {
      if (!mountedRef.current) return
      const t = video.currentTime
      if (Math.abs(t - lastTimeRef.current) > 1e-3) {
        lastTimeRef.current = t
        setVideoHasSignal(true)
        kickSignalWatchdog()
      }
    }
    const onSignalLost = () => {
      if (!mountedRef.current) return
      setVideoHasSignal(false)
      lastTimeRef.current = 0
      if (signalTimerRef.current) clearTimeout(signalTimerRef.current)
    }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('emptied', onSignalLost)
    video.addEventListener('abort', onSignalLost)
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('emptied', onSignalLost)
      video.removeEventListener('abort', onSignalLost)
      if (signalTimerRef.current) clearTimeout(signalTimerRef.current)
    }
  }, [kickSignalWatchdog])

  function togglePlay() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  function toggleMute() {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setIsMuted(video.muted)
  }


  return (
    <div
      ref={containerRef}
      className={[
        'group relative flex min-h-0 flex-col overflow-hidden rounded-base bg-black',
        className ?? '',
      ].join(' ')}
      data-testid="video-player"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
      {fullscreenError && <div role="status" className="pointer-events-none absolute bottom-14 left-2 z-30 rounded bg-black/75 px-2 py-1 text-xs text-white">{fullscreenError}</div>}
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        muted={isMuted}
        playsInline
      />
      {allowPanorama && panorama && videoEl && (
        <PanoramaView video={videoEl} onError={panoramaFailed} resetToken={panoramaReset} onCamera={receivePanoramaCamera} />
      )}
      {allowPanorama && panoramaError && (
        <div role="status" className="pointer-events-none absolute bottom-12 left-2 z-10 rounded bg-black/65 px-2 py-1 text-xs text-white">
          {panoramaError}
        </div>
      )}

      {savedZoneSource&&<SavedZoneOverlay key={savedZoneSource.id} video={videoEl} source={savedZoneSource} compact={compactZones} transformed={allowPanorama&&panorama} camera={view.camera} resetKey={state.generation}/>}
      {aiChannelId && (
        <AiDetectionOverlay
          video={videoEl}
          enabled={true}
          showDetections={overlayEnabled}
          showTrails={true}
          drawFrame={panorama ? drawPanoramaFrame : undefined}
          channelId={aiChannelId}
          getSeiForFrame={getSeiForFrame}
          getSeiApprox={getSeiApprox}
          getReceiveStats={getReceiveStats}
          diagnostics={overlayDiagnostics}
          protocol={proto ? PROTO_LABEL[proto] : undefined}
          resetKey={state.generation}
          onMode={onOverlayMode}
        />
      )}

      {aiChannelId && overlayEnabled && canConnect && overlaySync !== 'synced' && state.status === 'playing' && (
        <div className="pointer-events-none absolute bottom-10 left-2 z-10 rounded-base bg-black/65 px-2 py-1 text-xs text-white" role="status">
          {overlaySync === 'unsupported'
            ? plan.kind === 'hls'
              ? 'H.265 以 HLS 播放，无识别框'
              : '当前播放方式不支持逐帧识别框；请切换 WebRTC'
            : overlaySync === 'no_device'
            ? '当前设备不支持识别框叠加（浏览器取不到逐帧识别数据）'
            : overlaySync === 'approx'
            ? '识别框近似对齐（此浏览器不提供逐帧时间戳，可能差 1–2 帧）'
            : overlaySync === 'no_sei' || overlaySync === 'pipeline_error'
            ? overlayFailure
            : '识别框同步中…'}
        </div>
      )}

      {/* 编码角标：只标 H.265（H.264 是常态，不打扰） */}
      {h265 && (
        <div className="pointer-events-none absolute right-2 top-2 z-10 rounded-base bg-black/55 px-1.5 py-0.5 font-mono text-[11px] text-white">
          {formatCodec(videoInfo?.codec)}
        </div>
      )}

      {/* H.265 以 HLS 兜底时说明原因（延迟更高、无识别框） */}
      {plan.kind === 'hls' && state.status !== 'failed' && (
        <div className="pointer-events-none absolute right-2 top-9 z-10 max-w-[70%] rounded-base bg-black/55 px-2 py-1 text-right text-[11px] leading-snug text-white" role="note">
          {plan.reason}
        </div>
      )}

      {/* H.265 能力检测中 / 不可播：不连接，明确说明（不黑屏转圈） */}
      {plan.kind === 'pending' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white">
          <Loader2 size={26} className="animate-spin" aria-hidden />
          <p className="text-xs">正在检测 H.265 播放能力…</p>
        </div>
      )}
      {plan.kind === 'unsupported' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-page/95 px-4 text-center">
          <AlertTriangle size={26} className="text-danger" aria-hidden />
          <p className="text-sm font-medium text-ink">无法播放 H.265</p>
          <p className="max-w-[90%] text-xs text-ink-faint">{plan.reason}</p>
        </div>
      )}

      {/* 状态覆盖层 */}
      {canConnect && state.status === 'connecting' && (
        <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-2 rounded-base bg-black/60 px-3 py-2 text-white">
          <Loader2 size={26} className="animate-spin" aria-hidden />
          <p className="text-xs">正在连接 {proto ? PROTO_LABEL[proto] : ''}…</p>
        </div>
      )}
      {canConnect && state.status === 'failed' && !videoHasSignal && (
        <div data-testid="player-recovery-status" role="status" title={state.lastError ?? undefined}
          className="absolute right-2 top-2 flex max-w-[85%] items-center gap-2 rounded-base bg-black/70 px-3 py-2 text-white" onClick={(event) => event.stopPropagation()}>
          <AlertTriangle
            size={26}
            className={isNoSignalHint(state.lastError) ? 'text-ink-faint' : 'text-danger'}
            aria-hidden
          />
          <p className="text-xs">
            {isNoSignalHint(state.lastError) ? '无视频信号' : '连接暂时中断'}
          </p>
          <p className="text-xs">正在自动重试</p>
          <button
            type="button"
            onClick={() => dispatch({ type: 'retry' })}
            className="mt-1 flex items-center gap-1 rounded-base border border-line bg-surface px-3 py-1.5 text-xs text-ink-subtle hover:border-primary hover:text-primary"
          >
            <RefreshCw size={12} aria-hidden /> 重试
          </button>
        </div>
      )}

      {/* 标题角标（聚焦大画面场景传空串关闭，改用左下角 footerBadge） */}
      {title && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-base bg-black/50 px-2 py-1 text-xs text-white">
          {title}
        </div>
      )}

      {/* 左下角角标：通道名 + 在线状态点（聚焦大画面场景用） */}
      {footerBadge && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded-base bg-black/50 px-2 py-1 text-xs text-white">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${footerBadge.online ? 'bg-success' : 'bg-ink-faint'}`}
          />
          {footerBadge.name}
        </div>
      )}

      </div>
      {/* 控制栏 */}
      {showControls && (
        <LivePlayerToolbar
          paused={paused}
          isMuted={isMuted}
          togglePlay={togglePlay}
          toggleMute={toggleMute}
          aiChannelId={aiChannelId}
          overlayEnabled={overlayEnabled}
          setOverlayEnabled={setOverlayEnabled}
          onArming={onArming}
          chain={chain}
          selectedProtocol={proto ?? state.chain[state.index] ?? ''}
          onProtocol={(protocol) => dispatch({ type: 'switch', protocol })}
          view={view}
          allowPanorama={allowPanorama}
          videoEl={videoEl}
          canConnect={canConnect}
        />
      )}
    </div>
  )
}
