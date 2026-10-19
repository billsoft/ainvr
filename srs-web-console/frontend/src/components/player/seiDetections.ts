import type { AiDetection } from '@/types/aiChannel'
import { parseGroundingOverlay, type GroundingOverlay } from './groundingPoints'

/**
 * 从 WebRTC 编码帧里解出 ai-service 注入的检测结果（SEI）。
 *
 * 为什么要有这个模块（2026-09-17）：
 * 在这之前，浏览器端的识别框走的是"每 150ms 轮询 /results 拿最新结果 + 用
 * 墙上时钟猜当前画面是哪一帧"（见 AiDetectionOverlay 与 overlayGeometry）。
 * 那套做法有一个无法回避的结构性缺陷：**框跟着实时时钟走，画面跟着内容时钟
 * 走**，两条时间线之间差多少延迟，框就超前多少。开播时延迟小看不出来，
 * 延迟涨到 10s 框就超前 10s——用户看到的就是"框先走过去，人再过去"。
 * 而且这个错位**用现有诊断指标看不出来**：signedGapMs 是拿结果时间戳跟同样
 * 由墙钟推出来的 nowS 比的，永远是 ±100ms 以内，跟画面实际有多旧无关。
 *
 * 真正的解法是让框跟帧一起走。实测验证过两件事（无头 chromium 136，默认
 * 配置无需任何实验性 flag）：
 *   1. ai-service 打进 H.264 码流的 SEI **完好穿过 SRS 的 rtmp_to_rtc 到达
 *      浏览器**——逐帧扫 UUID，456/456 全中，JSON 载荷完整；
 *   2. `RTCRtpReceiver.createEncodedStreams()` 给出的 `frame.timestamp` 与
 *      `video.requestVideoFrameCallback` metadata 里的 `rtpTimestamp` 是
 *      同一把尺，**绑定"正在显示的那一帧"命中率 100%**。
 * 于是识别框可以精确画在它本来对应的那一帧上：画面延迟多少，框就延迟多少，
 * 和延迟大小彻底解耦。
 *
 * 本模块只做纯字节解析（不碰 DOM/PC），方便单测锁定这段容易写错的扫描逻辑。
 */

/** AINVR SEI protocol identifier: "AINVR-SEI-v1" + 00 00 00 01 (16 bytes).
 * The AI producer and recording parser must use the same identifier. */
export const SEI_UUID = new Uint8Array([
  0x41, 0x49, 0x4e, 0x56, 0x52, 0x2d, 0x53, 0x45, // "AINVR-SE"
  0x49, 0x2d, 0x76, 0x31, 0x00, 0x00, 0x00, 0x01, // "I-v1" + version suffix
])

// H.264/H.265 EBSP inserts 0x03 into the UUID's zero-byte suffix. Match
// both wire bytes and already-unescaped RBSP without copying video frames.
const SEI_UUID_EBSP = (() => {
  const bytes: number[] = []
  let zeros = 0
  for (const byte of SEI_UUID) {
    if (zeros >= 2 && byte <= 3) { bytes.push(3); zeros = 0 }
    bytes.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return new Uint8Array(bytes)
})()

export interface SeiFrameDetections {
  /** false means no inference metadata, not an explicit no-object result. */
  inferred?: boolean
  /** Age relative to the displayed video frame, never the newest received frame. */
  displayAgeMs?: number
  /** 该 AU 在源流上的 PTS（纳秒）——诊断/对账用，画框本身不需要 */
  ptsNs: number | null
  /** 这条结果相对产出时刻有多旧（毫秒），ai-service 侧的口径 */
  ageMs: number | null
  detections: AiDetection[]
  modelExtra?: Record<string, unknown>
  grounding?: GroundingOverlay
}

/** SEI 载荷里单个检测的紧凑编码（sei.py::_det_json）：
 *  c=class_id n=class_name p=confidence b=[x,y,w,h] k=[[x,y]...] 关键点 */
interface CompactDetection {
  c?: unknown
  n?: unknown
  p?: unknown
  l?: unknown
  t?: unknown
  b?: unknown
  k?: unknown
}

/**
 * 在一段 H.264 字节里找 SEI 载荷的 JSON 文本。
 *
 * 实现上只做"找 UUID，然后从它后面第一个 `{` 起做花括号配对"，不完整解析
 * NAL 结构——编码帧里 SEI 的位置/长度编码形式（0xFF 连缀的 payloadSize）
 * 各家写法不一，按结构解析反而脆弱；UUID 是 16 字节的强特征，误命中概率
 * 可以忽略。找不到返回 null（正常情况：ai-service 对没有结果可注的帧不打
 * SEI，实测 au_pushed 比 sei_injected 多几十个）。
 */
export function findSeiJson(data: Uint8Array): string | null {
  return jsonAfterUuid(data, indexOfSeiUuid(data))
}

function jsonAfterUuid(data: Uint8Array, at: number): string | null {
  if (at < 0) return null
  const start = data.indexOf(0x7b /* { */, at + SEI_UUID.length)
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < data.length; i++) {
    const b = data[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (b === 0x5c) escaped = true
      else if (b === 0x22) quoted = false
      continue
    }
    if (b === 0x22) { quoted = true; continue }
    if (b === 0x7b) depth++
    else if (b === 0x7d /* } */) {
      depth--
      if (depth === 0) {
        return new TextDecoder().decode(data.subarray(start, i + 1))
      }
    }
  }
  return null
}

export function inspectSeiDetections(data: Uint8Array): { present: boolean; result: SeiFrameDetections | null } {
  const at = indexOfSeiUuid(data)
  if (at < 0) return { present: false, result: null }
  const json = jsonAfterUuid(data, at)
  return { present: true, result: json === null ? null : parseSeiJson(json) }
}

function indexOfSeiUuid(hay: Uint8Array): number {
  const matches = (at: number, needle: Uint8Array) => {
    if (at + needle.length > hay.length) return false
    for (let j = 0; j < needle.length; j++) {
      if (hay[at + j] !== needle[j]) return false
    }
    return true
  }
  for (let i = 0; i <= hay.length - SEI_UUID.length; i++) {
    if (hay[i] !== SEI_UUID[0]) continue
    if (matches(i, SEI_UUID) || matches(i, SEI_UUID_EBSP)) return i
  }
  return -1
}

/**
 * 把 SEI 的紧凑 JSON 解析成叠加层能直接画的形状。
 *
 * 容错优先：整条解析不出来返回 null（这一帧就不画框，等下一帧），单个检测
 * 字段不对就跳过那一条——推流链路上的一个坏包不该让整个叠加层崩掉。
 */
export function parseSeiJson(json: string): SeiFrameDetections | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { pts?: unknown; age_ms?: unknown; det?: unknown; model_extra?: unknown }
  const detections: AiDetection[] = []
  if (Array.isArray(obj.det)) {
    for (const item of obj.det) {
      const d = toDetection(item as CompactDetection)
      if (d) detections.push(d)
    }
  }
  const modelExtra = obj.model_extra && typeof obj.model_extra === 'object' && !Array.isArray(obj.model_extra)
    ? obj.model_extra as Record<string, unknown> : undefined
  const grounding = parseGroundingOverlay(modelExtra)
  return {
    ptsNs: typeof obj.pts === 'number' ? obj.pts : null,
    ageMs: typeof obj.age_ms === 'number' ? obj.age_ms : null,
    detections,
    ...(modelExtra ? { modelExtra } : {}),
    ...(grounding ? { grounding } : {}),
  }
}

function toDetection(c: CompactDetection): AiDetection | null {
  if (!c || !Array.isArray(c.b) || c.b.length < 4) return null
  const [x, y, w, h] = c.b as unknown[]
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const det: AiDetection = {
    class_id: typeof c.c === 'number' ? c.c : 0,
    class_name: typeof c.n === 'string' ? c.n : '',
    confidence: typeof c.p === 'number' ? c.p : c.p === null ? null : 0,
    ...(typeof c.l === 'string' ? { label_id: c.l } : {}),
    ...(typeof c.t === 'string' && c.t.length <= 256 ? { track_id: c.t } : {}),
    bbox: { x: x as number, y: y as number, w: w as number, h: h as number },
  }
  if (Array.isArray(c.k)) {
    const pts: { x: number; y: number }[] = []
    for (const p of c.k) {
      if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
        pts.push({ x: p[0], y: p[1] })
      }
    }
    if (pts.length) det.landmarks = pts
  }
  return det
}

/** findSeiJson + parseSeiJson 的组合；没有 SEI 或解析失败都返回 null */
export function extractSeiDetections(data: Uint8Array): SeiFrameDetections | null {
  return inspectSeiDetections(data).result
}

/**
 * rtpTimestamp → 该帧检测结果 的有界缓存。
 *
 * 编码帧（Encoded Transform，收到即触发）总是**早于**同一帧被显示
 * （requestVideoFrameCallback，出画才触发），中间隔着解码和抖动缓冲，
 * 所以必须存一段而不是只留最新的一条——只留最新就等于又把框绑回"最新
 * 收到的帧"，重新引入几百毫秒的超前。
 *
 * 容量按"抖动缓冲最坏能攒多久"取：300 帧 @30fps = 10s，远大于实测的
 * 百毫秒级抖动缓冲，同时内存占用可忽略（每条只有几个框）。超出后按插入
 * 顺序淘汰最老的。
 */
export class SeiFrameCache {
  private readonly capacity: number
  private readonly map = new Map<number, SeiFrameDetections>()

  constructor(capacity: number = 300) {
    if (capacity < 1) throw new Error('capacity 必须 >= 1')
    this.capacity = capacity
  }

  put(rtpTimestamp: number, value: SeiFrameDetections): void {
    // 已存在时先删再插，保证 Map 的插入顺序就是淘汰顺序
    if (this.map.has(rtpTimestamp)) this.map.delete(rtpTimestamp)
    this.map.set(rtpTimestamp, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  /** Live-only smoothing, bounded to 300 ms on the 90 kHz video RTP clock.
   * Also recovers metadata on decoded frames the browser did not present.
   * Explicit empty results clear boxes; unprocessed frames do not.
   */
  getForDisplay(rtpTimestamp: number): SeiFrameDetections | null {
    let best: SeiFrameDetections | null = null
    let age = 27_001
    for (const [stamp, value] of this.map) {
      if (value.inferred === false) continue
      const delta = (rtpTimestamp - stamp) | 0
      if (delta >= 0 && delta <= 27_000 && delta < age) {
        age = delta
        best = value
      }
    }
    return best ? { ...best, displayAgeMs: age / 90 } : null
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}
