import { request } from './httpClient'

/**
 * 播放器时序异常进入统一日志中心，不再维护专用日志文件。
 * 健康心跳在浏览器端过滤，同一通道/事件每分钟最多上报一次。
 *
 * fire-and-forget：失败静默丢弃，诊断上报绝不能反过来影响画面渲染主流程。
 * 请求有界超时，不阻塞播放、不自动重试。
 */
export interface ClockOffsetDiagEvent {
  channelId: string
  /** recalibrate：本轮时钟偏移相比上一帧跳变超过阈值；heartbeat：常规心跳，不管有没有异常都按固定间隔发一条，用来确认诊断链路本身还活着 */
  event: 'recalibrate' | 'heartbeat'
  /** 当前时钟偏移（秒） */
  offsetS: number
  /** 相比上一帧的跳变幅度（毫秒） */
  offsetJumpMs: number
  /** 这一帧用于匹配的"校准后现在时刻"（秒，unix） */
  nowS: number
  /** 当前匹配到/最接近的结果距 nowS 差多少毫秒；历史为空时为 null */
  matchGapMs: number | null
  /** 2026-09-11 web OSD 同步重构诊断增强（可选字段，后端 diagOverlay zod
   * 白名单已同步扩展）：有符号 gap——正值=结果滞后于估算的"画面时刻"（框
   * 偏旧），负值=结果在画面时刻之后（未来结果/框抢跑）。绝对值回答不了
   * "往哪边差"，方向是断流恢复排查的关键信号。 */
  signedGapMs?: number | null
  /** 本帧参与 nowS 修正的抖动缓冲延迟值（getJitterBufferDelayS() 快照） */
  jitterBufferDelayS?: number
  /** 当前播放器下行协议（WebRTC/HTTP-FLV/HLS）——恢复行为按协议区分 */
  protocol?: string
  /** 本帧的识别框是从哪条路径来的。
   * 'sei'        = 逐帧：按显示帧的 rtpTimestamp 读它自带的 SEI，与画面同帧；
   * 'sei-approx' = 近似：浏览器不给 rtpTimestamp，按"到达时刻 + 实测延迟"取帧
   *                （设计 §8.2），误差有界、不累计，iPad 等实机待标定；
   * 'result' / 'none' = 已删除的旧墙钟路径，保留枚举值只为兼容历史日志。
   * 这个字段是排查"用户浏览器到底走了哪条路"的唯一依据。 */
  matchType?: 'result' | 'none' | 'sei' | 'sei-approx'
  /** 逐帧路径下这一帧画了几个框（回退路径不填）——用来区分"走通了但确实
   * 没检测到目标"和"压根没走通" */
  detCount?: number
}

export interface WebrtcStatsDiagEvent {
  /** 复用同一个字段名存标签——这里不是 AI 通道 id，是 `app/stream` 这种流标识，
   * 纯粹用来在日志里区分是哪一路画面，跟叠加层诊断的字段语义不同但没必要
   * 另起一个字段名，日志消费方（人眼 grep）按 event 类型自己分得清。 */
  channelId: string
  event: 'webrtc-stats'
  /** 见 webrtc.ts::extractWebrtcVideoStats 头注——null 代表这轮没测到，不是 0 秒延迟 */
  jitterBufferDelayS: number | null
  framesDecoded: number | null
  freezeCount: number | null
  pauseCount: number | null
}

export type OverlayDiagEvent = ClockOffsetDiagEvent | WebrtcStatsDiagEvent

const lastReported = new Map<string, number>()
export function reportOverlayDiag(ev: OverlayDiagEvent): void {
  // Do not send healthy polling traffic just to discard it in the BFF.
  const abnormal = ev.event === 'recalibrate' ? Math.abs(ev.offsetJumpMs) > 500
    : ev.event === 'heartbeat' ? Math.abs(ev.matchGapMs ?? 0) > 500
    : (ev.jitterBufferDelayS ?? 0) > 2
  if (!abnormal) return
  const key = `${ev.channelId}:${ev.event}`, now = Date.now()
  if (now - (lastReported.get(key) ?? 0) < 60000) return
  if (lastReported.size >= 128) lastReported.delete(lastReported.keys().next().value!)
  lastReported.set(key, now)
  void request('/diag/overlay', {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify(ev),
  }).catch(() => {
    // 诊断上报本身失败不影响画面——静默丢弃，不重试
  })
}
