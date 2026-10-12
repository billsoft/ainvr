/**
 * 近似叠框（设计 docs/h265-codec12-support-design-2026-09-29.md §8.2，D9）。
 *
 * 逐帧叠框靠 requestVideoFrameCallback 给出显示帧的 rtpTimestamp，去 SEI 缓存里精确
 * 取。拿不到 rtpTimestamp（或没有 rVFC）时改用近似对齐：
 *
 *   1. 编码帧到达时记下 (到达时刻, 该帧 SEI) —— ArrivalTimeline；
 *   2. 每次 getStats 采样（播放器 2s 一次）用最近窗口的增量估"到达→显示"延迟 D ——
 *      D = Δ jitterBufferDelay / Δ jitterBufferEmittedCount + Δ totalDecodeTime / Δ framesDecoded；
 *   3. 每个显示帧取"到达时刻 + D"最接近显示时刻的那一帧的 SEI。
 *
 * 每帧都用最新的 D 重新对齐、没有任何累加项，误差只取决于 D 的估计精度，不随运行
 * 时间累积（延迟涨落在一个采样窗口内被新的 D 吸收）。用户验收口径："差一两帧可以，
 * 不能累计"。
 *
 * 未验证的前提：到达时刻取"编码帧交到 JS"，而 jitterBufferDelay 从首包进缓冲起算，
 * 两者差一个组帧/调度偏移（大帧更大）。单测只证明算法无累加项；真机误差待 §8.2 实测。
 * 纯逻辑、不碰 DOM/PC，时间由参数注入，便于单测确定性驱动。
 */

export interface DecodeStatsRaw {
  jitterBufferDelay: number | null
  jitterBufferEmittedCount: number | null
  totalDecodeTime: number | null
  framesDecoded: number | null
}

/** 从 getStats 报表取 inbound-rtp/video 的累计计数器 */
export function extractDecodeStatsRaw(report: RTCStatsReport): DecodeStatsRaw {
  for (const stat of report.values()) {
    const s = stat as Record<string, unknown>
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null)
      return {
        jitterBufferDelay: num('jitterBufferDelay'),
        jitterBufferEmittedCount: num('jitterBufferEmittedCount'),
        totalDecodeTime: num('totalDecodeTime'),
        framesDecoded: num('framesDecoded'),
      }
    }
  }
  return { jitterBufferDelay: null, jitterBufferEmittedCount: null, totalDecodeTime: null, framesDecoded: null }
}

/** "到达→显示"延迟估计（毫秒），用两次采样之间的增量，不用开播以来的累计均值 */
export class DisplayDelayEstimator {
  private prev: DecodeStatsRaw | null = null
  private delayMs: number | null = null

  get current(): number | null {
    return this.delayMs
  }

  reset(): void {
    this.prev = null
    this.delayMs = null
  }

  sample(raw: DecodeStatsRaw): number | null {
    const prev = this.prev
    this.prev = raw
    if (!prev) return this.delayMs
    const dEmit = delta(prev.jitterBufferEmittedCount, raw.jitterBufferEmittedCount)
    const dJb = delta(prev.jitterBufferDelay, raw.jitterBufferDelay)
    // 计数器回退（连接重建）或窗口内没出帧：保持上一次的估计
    if (dEmit === null || dJb === null || dEmit <= 0 || dJb < 0) return this.delayMs
    let ms = (dJb / dEmit) * 1000
    const dDec = delta(prev.framesDecoded, raw.framesDecoded)
    const dDecT = delta(prev.totalDecodeTime, raw.totalDecodeTime)
    if (dDec !== null && dDecT !== null && dDec > 0 && dDecT >= 0) ms += (dDecT / dDec) * 1000
    this.delayMs = ms
    return ms
  }
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a
}

/** 按到达时刻排序的有界环（容量默认 300 帧 ≈ 30fps 下 10s） */
export class ArrivalTimeline<T> {
  private readonly capacity: number
  private times: number[] = []
  private values: T[] = []

  constructor(capacity = 300) {
    if (capacity < 1) throw new Error('capacity 必须 >= 1')
    this.capacity = capacity
  }

  get size(): number {
    return this.times.length
  }

  push(arrivalMs: number, value: T): void {
    // 到达时刻单调（同一线程依次收到）；万一回退（时钟异常）就清空重来，不留乱序
    if (this.times.length && arrivalMs < this.times[this.times.length - 1]!) this.clear()
    this.times.push(arrivalMs)
    this.values.push(value)
    if (this.times.length > this.capacity) {
      this.times.shift()
      this.values.shift()
    }
  }

  clear(): void {
    this.times = []
    this.values = []
  }

  /** Only past entries; preserve original age so repeated lookups cannot extend a hold. */
  pickPast(target: number, maxAgeMs: number, accept: (value: T) => boolean): { value: T; ageMs: number } | null {
    for (let i = this.times.length - 1; i >= 0; i--) {
      const ageMs = target - this.times[i]!
      if (ageMs < 0) continue
      if (ageMs > maxAgeMs) return null
      const value = this.values[i]!
      if (accept(value)) return { value, ageMs }
    }
    return null
  }

}
