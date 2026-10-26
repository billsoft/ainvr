import { SEI_UUID } from './seiDetections'

/**
 * SRS WebRTC 播放（WHEP 风格 API 交换 SDP）
 * 两级超时：SDP fetch 5s（AbortController）、ICE 建立 10s（NAT 穿透留余量）
 */
export interface WebRtcOptions {
  api: string
  streamurl: string
  fetchTimeoutMs?: number
  iceTimeoutMs?: number
  /** ICE 建连完成之后连接再次丢失时回调（failed 立即回调；disconnected 持续
   *  5s 未恢复才回调，短暂抖动不误报）。调用方通常用它触发同协议自动重连。
   *  注意：建连阶段（attachWebRTC 的 Promise 完成前）的失败仍然走 reject，
   *  不会进这个回调。 */
  onConnectionLost?: (reason: 'failed' | 'disconnected') => void
  /** 编码帧处理管道意外失败；主动关闭不报告。每个连接最多报告一次。 */
  onEncodedPipelineError?: (reason: string) => void
  /** 传了就在接收端挂 Encoded Transform，把每个编码视频帧（的 SEI 部分）连同它的
   *  RTP 时间戳、到达时刻交给回调——AI 叠加层用它解出该帧自带的 SEI 检测结果，
   *  做到识别框跟帧对齐（见 seiDetections.ts 头注的实测依据）。
   *  两条实现：Chrome 的 createEncodedStreams（主线程，data 为整帧）；标准
   *  RTCRtpScriptTransform（Safari/iPad，Worker 里扫 UUID，data 只含 UUID 起的
   *  片段，没有 SEI 时为空数组）。arrivalMs 统一为主线程 performance.now() 时基，
   *  近似对齐（approxAlign.ts）用。
   *  ⚠️ Chrome 路径的回调在视频帧处理链路上同步执行，必须足够快且绝不能抛错。
   *  内部已经包了 try/catch 兜底。
   *  两条都不支持时跳过（handle.encodedFramesSupported 为 false），调用方据此
   *  提示"不支持识别框"。 */
  onEncodedVideoFrame?: (rtpTimestamp: number, data: Uint8Array, arrivalMs: number) => void
}

export interface WebRtcHandle {
  close: () => void
  /** 拉一次原生 RTCPeerConnection 统计——播放延迟排查用（见 extractWebrtcVideoStats）。
   * 不支持时（理论上不会，getStats 是标准 API）拒绝的 Promise 由调用方 catch 掉。 */
  getStats: () => Promise<RTCStatsReport>
  /** 本次连接是否真的挂上了编码帧回调。传了 onEncodedVideoFrame 但浏览器不
   * 支持时是 false——调用方必须据此回退，不能假定一定拿得到 SEI。 */
  encodedFramesSupported: boolean
}

/** addTransceiver 的返回值：只用到 receiver 上的 Encoded Transform 入口 */
type MinimalTransceiver = {
  receiver?: {
    /** RTCRtpScriptTransform 挂载点（标准接口） */
    transform?: unknown
    createEncodedStreams?: () => {
      readable: ReadableStream<{ timestamp: number; data: ArrayBuffer }>
      writable: WritableStream<{ timestamp: number; data: ArrayBuffer }>
    }
  }
}

type MinimalPC = {
  addTransceiver: (kind: string, init: { direction: string }) => MinimalTransceiver | void
  createOffer: () => Promise<{ type: string; sdp?: string }>
  setLocalDescription: (d: unknown) => Promise<void>
  setRemoteDescription: (d: unknown) => Promise<void>
  close: () => void
  connectionState: string
  iceConnectionState: string
  onconnectionstatechange: (() => void) | null
  oniceconnectionstatechange: (() => void) | null
  ontrack: ((e: { streams: MediaStream[] }) => void) | null
  getStats: () => Promise<RTCStatsReport>
}

/**
 * 在接收端挂 Encoded Transform，把每个编码视频帧喂给回调。
 *
 * 用的是 Chrome 的 `receiver.createEncodedStreams()`（配合建连时的
 * `encodedInsertableStreams: true`）。实测 chromium 136 默认即可用，不需要
 * 任何实验性 flag；标准的 RTCRtpScriptTransform 在该版本反而还没有，所以
 * Chrome 上优先走这条。没有它时改走下面的 attachScriptTransformTap（标准接口）。
 *
 * ⚠️ 帧必须原样 enqueue 回去，否则视频不会解码（这条链路是解码前的必经之路，
 * 不是旁路监听）。回调抛错不能冒泡——所以整段包在 try/catch 里。
 */
function attachEncodedFrameTap(
  trans: MinimalTransceiver | void,
  onFrame: (rtpTimestamp: number, data: Uint8Array, arrivalMs: number) => void,
  onError: (reason: string) => void,
): boolean {
  const receiver = trans && typeof trans === 'object' ? trans.receiver : undefined
  if (!receiver || typeof receiver.createEncodedStreams !== 'function') return false
  try {
    const streams = receiver.createEncodedStreams()
    const transform = new TransformStream<
      { timestamp: number; data: ArrayBuffer },
      { timestamp: number; data: ArrayBuffer }
    >({
      transform(frame, controller) {
        try {
          onFrame(frame.timestamp, new Uint8Array(frame.data), performance.now())
        } catch {
          // 叠加层出问题绝不能拖垮视频解码，静默吞掉这一帧的解析
        }
        controller.enqueue(frame)
      },
    })
    void streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch((error) => {
      onError(`encoded stream: ${String(error)}`)
    })
    return true
  } catch {
    return false
  }
}

/**
 * Worker 内运行的 SEI 扫描（RTCRtpScriptTransform 路径）。经 toString() 序列化进
 * Blob Worker，所以**不能引用任何外部变量/导入**，UUID 由参数传入。
 *
 * 每帧：原样放行（这是解码前的必经之路）；扫 UUID，把 UUID 起最多 64 KiB 的片段
 * 连同 RTP 时间戳、到达时刻（epoch 毫秒 = timeOrigin + now，主线程换回自己的时基）
 * postMessage 给主线程。没有 SEI 也报一条（data=null），缓存据此记"本帧无框"。
 */
export function installSeiTap(scope: Record<string, unknown>, uuid: number[]): void {
  const pattern = new Uint8Array(uuid)
  // EBSP escapes 00 00 00/01/02/03. Match the on-wire UUID as well as RBSP.
  // This function is serialized into a Worker; keep both patterns self-contained.
  const escaped: number[] = []
  let zeros = 0
  for (const byte of uuid) {
    if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0 }
    escaped.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  const wirePattern = new Uint8Array(escaped)
  const find = (d: Uint8Array): number => {
    for (let i = d.indexOf(pattern[0]!); i >= 0; i = d.indexOf(pattern[0]!, i + 1)) {
      for (const candidate of [pattern, wirePattern]) {
        let j = 1
        while (j < candidate.length && d[i + j] === candidate[j]) j++
        if (j === candidate.length) return i
      }
    }
    return -1
  }
  const perf = scope.performance as { timeOrigin: number; now: () => number }
  const post = scope.postMessage as (msg: unknown, transfer?: Transferable[]) => void
  scope.onrtctransform = (event: {
    transformer: { readable: ReadableStream<unknown>; writable: WritableStream<unknown> }
  }) => {
    const t = event.transformer
    void t.readable
      .pipeThrough(new TransformStream<unknown, unknown>({
        transform(frame, controller) {
          try {
            const f = frame as { timestamp: number; data: ArrayBuffer; getMetadata?: () => { rtpTimestamp?: number } }
            const meta = typeof f.getMetadata === 'function' ? f.getMetadata() : {}
            const ts = typeof meta.rtpTimestamp === 'number' ? meta.rtpTimestamp : f.timestamp
            const d = new Uint8Array(f.data)
            const at = find(d)
            const slice = at < 0 ? null : d.slice(at, Math.min(d.length, at + 65536))
            post({ ts, arrivalEpochMs: perf.timeOrigin + perf.now(), data: slice }, slice ? [slice.buffer] : [])
          } catch {
            // 叠加层出问题绝不能拖垮视频解码
          }
          controller.enqueue(frame)
        },
      }))
      .pipeTo(t.writable)
      .catch((error) => {
        try { post({ error: `encoded worker stream: ${String(error)}` }) } catch {
          // Worker 已终止时无法再向主线程发送诊断。
        }
      })
  }
}

/** 标准 RTCRtpScriptTransform 路径：起一个 Blob Worker 跑 installSeiTap。返回释放函数；不支持返回 null */
function attachScriptTransformTap(
  trans: MinimalTransceiver | void,
  onFrame: (rtpTimestamp: number, data: Uint8Array, arrivalMs: number) => void,
  onError: (reason: string) => void,
): (() => void) | null {
  const w = window as unknown as {
    RTCRtpScriptTransform?: new (worker: Worker, options?: unknown) => unknown
  }
  const receiver = trans && typeof trans === 'object' ? trans.receiver : undefined
  if (typeof w.RTCRtpScriptTransform !== 'function' || !receiver) return null
  let url: string | null = null
  let worker: Worker | null = null
  try {
    const src = `(${installSeiTap.toString()})(self, ${JSON.stringify(Array.from(SEI_UUID))});`
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
    worker = new Worker(url)
    worker.onerror = (event) => onError(`encoded worker: ${event.message}`)
    worker.onmessageerror = () => onError('encoded worker message could not be read')
    const empty = new Uint8Array(0)
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { error?: string; ts: number; arrivalEpochMs: number; data: Uint8Array | null }
      if (m.error) { onError(m.error); return }
      try {
        onFrame(m.ts, m.data ?? empty, m.arrivalEpochMs - performance.timeOrigin)
      } catch {
        // 同 Chrome 路径：回调出错只丢这一帧的解析
      }
    }
    receiver.transform = new w.RTCRtpScriptTransform(worker, { name: 'ainvr-sei-tap' })
  } catch {
    worker?.terminate()
    if (url) URL.revokeObjectURL(url)
    return null
  }
  const u = url
  const wk = worker
  return () => {
    wk.terminate()
    URL.revokeObjectURL(u)
  }
}

/** Chrome 的 createEncodedStreams 是否可用——必须建连前知道（要在构造 PC 时声明） */
function hasInsertableStreams(): boolean {
  const R = (window as unknown as { RTCRtpReceiver?: { prototype?: object } }).RTCRtpReceiver
  return !!R?.prototype && 'createEncodedStreams' in R.prototype
}

export async function attachWebRTC(
  video: HTMLVideoElement,
  opts: WebRtcOptions,
): Promise<WebRtcHandle> {
  const PC = (window as unknown as {
    RTCPeerConnection?: new (cfg?: Record<string, unknown>) => MinimalPC
  }).RTCPeerConnection
  if (!PC) throw new Error('当前浏览器不支持 WebRTC')

  // encodedInsertableStreams 必须在建连时声明，事后挂不上（Chrome 的要求）。
  // Chrome 两种接口都有时仍走它（与改造前一致）；只有标准接口时（Safari）不声明。
  // 不需要编码帧时不传，行为与改造前完全一致。
  const useInsertable = !!opts.onEncodedVideoFrame && hasInsertableStreams()
  const pc = useInsertable
    ? new PC({ encodedInsertableStreams: true })
    : new PC()
  let closed = false
  let encodedFramesSupported = false
  let pipelineFailed = false
  const reportPipelineError = (reason: string) => {
    if (closed || pipelineFailed) return
    pipelineFailed = true
    encodedFramesSupported = false
    console.warn('[WebRTC] encoded frame pipeline failed:', reason)
    opts.onEncodedPipelineError?.(reason)
  }
  let disposeTap: (() => void) | null = null
  const handle: WebRtcHandle = {
    close() {
      closed = true
      disposeTap?.()
      disposeTap = null
      try {
        pc.close()
      } catch {
        /* already closed */
      }
      video.srcObject = null
    },
    getStats: () => pc.getStats(),
    get encodedFramesSupported() {
      return encodedFramesSupported
    },
  }

  // ⚠️ ontrack 必须在 setRemoteDescription 之前挂好：浏览器处理完 SDP answer
  // 后几乎立刻就会派发 ontrack（不需要等 ICE/DTLS 建连完成），它是 on-属性式
  // 事件、不是队列——迟绑定=事件已经发生过了，永久错过，不会补发。
  // 曾经把这段放在下面"等 ICE 建立"之后，实测 SRS 端连接、DTLS、RTP 全部正常
  // （服务端日志可证），但 video.srcObject 永远没被赋值：轨道事件在赋值之前
  // 就已经丢了，页面表现为一直转圈"正在连接 WebRTC…"，实际连接早就成功了。
  pc.ontrack = (e) => {
    if (closed) return
    const [stream] = e.streams
    if (stream) {
      video.srcObject = stream
      // 无 autoplay 属性时设置 srcObject 不会自动播放；跟 flv/hls 分支一致，
      // 显式 play() 一次，被浏览器自动播放策略拦截时用户手动播放兜底。
      void video.play().catch(() => {
        /* autoplay 被拦截时用户手动播放 */
      })
    }
  }

  const videoTrans = pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  // 必须在 setRemoteDescription 之前挂好：媒体一开始流动就会有编码帧过来，
  // 迟挂等于开头那批帧的 SEI 全丢（同 ontrack 的早绑定要求）。
  if (opts.onEncodedVideoFrame) {
    if (useInsertable) {
      encodedFramesSupported = attachEncodedFrameTap(videoTrans, opts.onEncodedVideoFrame, reportPipelineError)
    } else {
      disposeTap = attachScriptTransformTap(videoTrans, opts.onEncodedVideoFrame, reportPipelineError)
      encodedFramesSupported = disposeTap !== null
    }
  }

  // 建连阶段任何一步失败（SDP 请求失败、ICE 超时/失败）都在这里收尾：调用方拿不到 handle，
  // 关不了 PC 和编码帧 Worker——而失败后播放器会反复重试，每次都漏一份。
  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const ctrl = new AbortController()
    const fetchTimer = setTimeout(() => ctrl.abort(), opts.fetchTimeoutMs ?? 5000)
    try {
      const res = await fetch(opts.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api: opts.api,
          streamurl: opts.streamurl,
          sdp: offer.sdp,
        }),
        signal: ctrl.signal,
      })
      const data = (await res.json()) as { code: number; sdp?: string }
      if (data.code !== 0 || !data.sdp) {
        throw new Error(`WebRTC API 错误 code=${data.code}`)
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
    } finally {
      clearTimeout(fetchTimer)
    }

    // 等 ICE 建立（connected / failed / 超时）
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebRTC ICE 连接超时'))
      }, opts.iceTimeoutMs ?? 10000)
      const check = () => {
        if (
          pc.connectionState === 'connected' ||
          pc.iceConnectionState === 'connected'
        ) {
          clearTimeout(timer)
          resolve()
        } else if (
          pc.connectionState === 'failed' ||
          pc.iceConnectionState === 'failed'
        ) {
          clearTimeout(timer)
          reject(new Error('WebRTC ICE 连接失败'))
        }
      }
      pc.onconnectionstatechange = check
      pc.oniceconnectionstatechange = check
      check()
    })
  } catch (e) {
    handle.close()
    throw e
  }

  // 建连之后的连接状态监视（2026-09-13 延迟/断流自动重连加固）：
  // failed 立即上报；disconnected 给 5s 自愈宽限（ICE 短暂抖动很常见，
  // Chrome 通常几秒内自己回到 connected），仍不恢复才上报。覆盖上面的
  // 建连期监听器——那两个只负责让 attach 的 Promise 落定。
  let disconnectedAt: number | null = null
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null
  const onStateChange = () => {
    if (closed) return
    const s = pc.connectionState
    const i = pc.iceConnectionState
    if (s === 'failed' || i === 'failed') {
      opts.onConnectionLost?.('failed')
    } else if (s === 'disconnected' || i === 'disconnected') {
      if (disconnectedAt === null) {
        disconnectedAt = Date.now()
        disconnectedTimer = setTimeout(() => {
          if (!closed) opts.onConnectionLost?.('disconnected')
        }, 5000)
      }
    } else if (s === 'connected' || i === 'connected' || s === 'completed') {
      disconnectedAt = null
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer)
        disconnectedTimer = null
      }
    }
  }
  pc.onconnectionstatechange = onStateChange
  pc.oniceconnectionstatechange = onStateChange

  return handle
}

/** 组装 webrtc 播放 API 与流地址 */
export function webrtcPlayUrls(host: string, app: string, stream: string) {
  return {
    api: '/rtc/v1/play/',
    streamurl: `webrtc://${host}/${app}/${stream}`,
  }
}

export interface WebrtcVideoStatsSnapshot {
  /** 播放延迟（秒）：jitterBufferDelay / jitterBufferEmittedCount，标准 WebRTC 统计
   * 字段的官方定义就是"缓冲区为每一帧多攒了多久"的均值。emittedCount 为 0（还没
   * 出过帧）时是 null，不是 0——0 代表"确实测到零延迟"，null 代表"这轮没测到"，
   * 两者含义不同，调用方要按 null 跳过这次上报，不能当成延迟真的是 0。 */
  jitterBufferDelayS: number | null
  framesDecoded: number | null
  freezeCount: number | null
  pauseCount: number | null
}

/** 从 RTCPeerConnection.getStats() 报表里挑出 inbound-rtp / video 那条，抽取播放延迟
 * 相关字段——纯函数，不摸 DOM/PC，方便单测锁定这段字段名容易记错的解析逻辑。
 * 找不到匹配条目（连接未就绪、没有视频轨）时整体返回全 null。 */
export function extractWebrtcVideoStats(report: RTCStatsReport): WebrtcVideoStatsSnapshot {
  for (const stat of report.values()) {
    const s = stat as Record<string, unknown>
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      const delay = typeof s.jitterBufferDelay === 'number' ? s.jitterBufferDelay : null
      const emitted = typeof s.jitterBufferEmittedCount === 'number' ? s.jitterBufferEmittedCount : null
      return {
        jitterBufferDelayS: delay !== null && emitted ? delay / emitted : null,
        framesDecoded: typeof s.framesDecoded === 'number' ? s.framesDecoded : null,
        freezeCount: typeof s.freezeCount === 'number' ? s.freezeCount : null,
        pauseCount: typeof s.pauseCount === 'number' ? s.pauseCount : null,
      }
    }
  }
  return { jitterBufferDelayS: null, framesDecoded: null, freezeCount: null, pauseCount: null }
}

export interface JitterBufferRaw {
  jitterBufferDelay: number | null
  jitterBufferEmittedCount: number | null
}

/** 提取原始累计计数器，不做除法——供 windowedJitterBufferDelayS 拿两次采样算增量用。 */
export function extractWebrtcJitterBufferRaw(report: RTCStatsReport): JitterBufferRaw {
  for (const stat of report.values()) {
    const s = stat as Record<string, unknown>
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      return {
        jitterBufferDelay: typeof s.jitterBufferDelay === 'number' ? s.jitterBufferDelay : null,
        jitterBufferEmittedCount:
          typeof s.jitterBufferEmittedCount === 'number' ? s.jitterBufferEmittedCount : null,
      }
    }
  }
  return { jitterBufferDelay: null, jitterBufferEmittedCount: null }
}

/**
 * 用两次连续采样的累计计数器算出"最近一段窗口"的平均抖动缓冲延迟。
 *
 * jitterBufferDelay/jitterBufferEmittedCount 是 WebRTC 规范定义的累计计数器
 * （从连接建立起只增不减），直接拿 delay/emitted 算出来的是"开播以来的全程
 * 平均"——负载升高时新增的延迟会被历史均值稀释、反应极慢，这个项目已经在
 * channel.py 的 inference_fps_actual 上踩过同一个坑（见该文件 start() 头注）。
 * 这里改成两次采样之间的增量之比，只反映最近一个轮询窗口内的真实延迟，
 * 能跟着负载变化实时升降，供 WebrtcWatchdog 判定延迟累积用（识别框的近似对齐
 * 用 approxAlign.DisplayDelayEstimator，同一增量思路，另含解码耗时）。
 *
 * 返回 null 的情况：任一采样缺字段；窗口内没有新帧（emittedCount 未变，
 * 避免除零）；curr 的计数器反而比 prev 小（连接重建，累计计数器归零重
 * 来，不能拿新旧两段拼在一起算，产出负延迟没有意义）。
 */
export function windowedJitterBufferDelayS(
  prev: JitterBufferRaw, curr: JitterBufferRaw,
): number | null {
  if (
    prev.jitterBufferDelay === null || prev.jitterBufferEmittedCount === null ||
    curr.jitterBufferDelay === null || curr.jitterBufferEmittedCount === null
  ) {
    return null
  }
  const deltaEmitted = curr.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
  if (deltaEmitted <= 0) return null
  const deltaDelay = curr.jitterBufferDelay - prev.jitterBufferDelay
  return deltaDelay / deltaEmitted
}

/**
 * WebRTC 直播延迟/冻屏看门狗（2026-09-13：修复"开播约 3s，运行一段时间或
 * 源流中断恢复后延迟累积到 8s"）。
 *
 * 背景：RTMP→WebRTC 这条链路基于 UDP，但播放端 jitter buffer 在突发到达/
 * 源中断恢复后会越攒越大，且浏览器不会自动追直播点（没有 flv.js 那种
 * liveBufferLatencyChasing）。SRS 侧已用 queue_length 限制服务器端堆积，
 * 浏览器这一端只能靠"检测到落后/冻屏 → 重新建连，从最新 GOP 缓存重新开播"
 * 追回（官方 low-latency 文档对 RTMP 累积延迟给的就是这个对策）。
 *
 * 两类判据（必须持续/超时才触发，避免误判）：
 * 1. latency：窗口平均 jitterBufferDelay 连续 confirmPolls 个轮询 ≥ 阈值。
 * 2. freeze：连接还在但 framesDecoded 连续 freezeThresholdMs 没有增长
 *    （源流中断后浏览器停在上一帧，连接本身未必 failed）。
 * 开播宽限期内一律放行——刚建连时 GOP 缓存突发和计数器预热都会产生假信号。
 *
 * 纯逻辑类（不碰 DOM/PC），时间由参数注入，方便单测确定性驱动。
 */
export interface WatchdogOptions {
  /** 每次建连后的免判宽限（ms），默认 20s */
  startGraceMs?: number
  /** 窗口平均抖动缓冲延迟阈值（秒），默认 5s（开播典型 3~4s，8s 是故障） */
  latencyThresholdS?: number
  /** 延迟连续命中多少个轮询才判定，默认 3（配合 2s 轮询 = 持续 6s） */
  latencyConfirmPolls?: number
  /** 连续多久没有新解码帧判定冻屏（ms），默认 8s */
  freezeThresholdMs?: number
}

export type WatchdogVerdict = 'ok' | 'latency' | 'freeze'

export class WebrtcWatchdog {
  private readonly startGraceMs: number
  private readonly latencyThresholdS: number
  private readonly latencyConfirmPolls: number
  private readonly freezeThresholdMs: number

  private firstSampleAt: number | null = null
  private prevRaw: JitterBufferRaw | null = null
  private highRuns = 0
  private lastFramesDecoded: number | null = null
  private lastProgressAt: number | null = null

  constructor(opts: WatchdogOptions = {}) {
    this.startGraceMs = opts.startGraceMs ?? 20_000
    this.latencyThresholdS = opts.latencyThresholdS ?? 5.0
    this.latencyConfirmPolls = opts.latencyConfirmPolls ?? 3
    this.freezeThresholdMs = opts.freezeThresholdMs ?? 8_000
  }

  /** 新一轮建连后调用：所有基线/确认计数归零（宽限重新计算）。 */
  reset(): void {
    this.firstSampleAt = null
    this.prevRaw = null
    this.highRuns = 0
    this.lastFramesDecoded = null
    this.lastProgressAt = null
  }

  /**
   * 喂一次采样（建议 2s 一次）。
   * @param wallMs 单调时间（performance.now()）
   * @param raw extractWebrtcJitterBufferRaw 的结果
   * @param framesDecoded extractWebrtcVideoStats 的 framesDecoded，可为 null
   */
  sample(
    wallMs: number,
    raw: JitterBufferRaw,
    framesDecoded: number | null,
  ): WatchdogVerdict {
    if (this.firstSampleAt === null) this.firstSampleAt = wallMs
    const inGrace = wallMs - this.firstSampleAt < this.startGraceMs

    // ---- 冻屏判据（与宽限无关地维护进度，判定才受宽限约束）----
    if (framesDecoded !== null) {
      if (this.lastFramesDecoded === null || framesDecoded < this.lastFramesDecoded) {
        // 首次采样 / 计数器归零（PC 重建）：当作新基线，不判冻屏
        this.lastProgressAt = wallMs
      } else if (framesDecoded > this.lastFramesDecoded) {
        this.lastProgressAt = wallMs
      } else if (
        !inGrace &&
        this.lastProgressAt !== null &&
        wallMs - this.lastProgressAt >= this.freezeThresholdMs
      ) {
        return 'freeze'
      }
      this.lastFramesDecoded = framesDecoded
    }

    // 宽限期内只建基线，不判延迟
    if (inGrace) {
      this.prevRaw = raw
      this.highRuns = 0
      return 'ok'
    }

    // ---- 延迟判据：窗口增量平均，连续 N 次超阈值 ----
    let windowed: number | null = null
    if (this.prevRaw) windowed = windowedJitterBufferDelayS(this.prevRaw, raw)
    this.prevRaw = raw
    if (windowed !== null) {
      if (windowed >= this.latencyThresholdS) {
        this.highRuns += 1
        if (this.highRuns >= this.latencyConfirmPolls) {
          // 触发后归零：调用方若没有真的销毁重建（节流），下一轮要重新累计
          this.highRuns = 0
          return 'latency'
        }
      } else {
        this.highRuns = 0
      }
    }
    return 'ok'
  }
}
