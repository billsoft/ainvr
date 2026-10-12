import {
  ArrivalTimeline, DisplayDelayEstimator, extractDecodeStatsRaw, type DecodeStatsRaw,
} from '@/components/player/approxAlign'

describe('ArrivalTimeline', () => {
  it('只取过去的有效结果，过期或未来结果不能顶替', () => {
    const tl = new ArrivalTimeline<number>(10)
    for (let i = 0; i < 5; i++) tl.push(1000 + i * 40, i)
    expect(tl.pickPast(1041, 300, () => true)?.value).toBe(1)
    expect(tl.pickPast(1059, 300, () => true)?.value).toBe(1)
    expect(tl.pickPast(1061, 300, () => true)?.value).toBe(1)
    expect(tl.pickPast(850, 300, () => true)).toBeNull()
    expect(tl.pickPast(1461, 300, () => true)).toBeNull()
  })
  it('有界：超出容量丢最老；时钟回退清空', () => {
    const tl = new ArrivalTimeline<number>(3)
    for (let i = 0; i < 5; i++) tl.push(i * 40, i)
    expect(tl.size).toBe(3)
    expect(tl.pickPast(0, 300, () => true)).toBeNull()
    tl.push(10, 99)
    expect(tl.size).toBe(1)
    expect(tl.pickPast(10, 300, () => true)?.value).toBe(99)
  })
})

describe('DisplayDelayEstimator', () => {
  const raw = (jb: number, emit: number, dec: number, frames: number): DecodeStatsRaw => ({
    jitterBufferDelay: jb, jitterBufferEmittedCount: emit, totalDecodeTime: dec, framesDecoded: frames,
  })
  it('用两次采样的增量算最近窗口的延迟（抖动缓冲 + 解码）', () => {
    const e = new DisplayDelayEstimator()
    expect(e.sample(raw(10, 100, 0.5, 100))).toBeNull()        // 第一次只建基线
    expect(e.sample(raw(10 + 25 * 0.2, 125, 0.5 + 25 * 0.004, 125))).toBeCloseTo(204, 5)
  })
  it('窗口内没出帧、计数器回退（重连）都保持上一次估计', () => {
    const e = new DisplayDelayEstimator()
    e.sample(raw(0, 0, 0, 0))
    e.sample(raw(3, 30, 0, 30))                                  // 100ms
    expect(e.sample(raw(3, 30, 0, 30))).toBeCloseTo(100, 5)
    expect(e.sample(raw(0.1, 1, 0, 1))).toBeCloseTo(100, 5)
  })
  it('extractDecodeStatsRaw 只认 inbound-rtp/video', () => {
    const report = new Map<string, unknown>([
      ['a', { type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 9 }],
      ['v', { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 1.5, jitterBufferEmittedCount: 10,
        totalDecodeTime: 0.1, framesDecoded: 10 }],
    ]) as unknown as RTCStatsReport
    expect(extractDecodeStatsRaw(report)).toEqual({
      jitterBufferDelay: 1.5, jitterBufferEmittedCount: 10, totalDecodeTime: 0.1, framesDecoded: 10,
    })
  })
})

describe('近似对齐：算法层面没有累加项（模型自洽性，不代表真机精度）', () => {
  // 模拟 10 分钟直播：25fps，网络到达抖动 ±15ms，抖动缓冲延迟从 80ms 慢慢涨到 400ms
  // （正是"运行久了延迟越来越大"的场景），解码 5ms。每秒按真实计数器增量采样一次 D。
  // ⚠️ 这里的显示时刻按算法同一假设（到达 + 抖动缓冲 + 解码）生成，只能证明"延迟涨落
  // 不会让误差随时间变大"，证明不了真机误差 ≤ 2 帧：真实浏览器里"编码帧交到 JS 的
  // 时刻"与抖动缓冲计时起点（首包到达）之间还有组帧/调度偏移。真机精度以设计 §8.2 的
  // 实测验收为准（Chromium 强制近似模式 ≥1h + iPad 复测）。
  it('每分钟的帧偏差中位数 ≤ 1、最大 ≤ 2，且最后一分钟不比第一分钟差', () => {
    const FPS = 25
    const frames = 10 * 60 * FPS
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const tl = new ArrivalTimeline<number>(300)
    const est = new DisplayDelayEstimator()
    let jb = 0, emitted = 0, decT = 0
    const perMinute: number[][] = Array.from({ length: 10 }, () => [])
    const displays: Array<{ at: number; idx: number }> = []
    let nextSample = 1000
    for (let i = 0; i < frames; i++) {
      const sendAt = i * (1000 / FPS)
      const arrival = sendAt + 50 + (rand() - 0.5) * 30
      // 真实抖动缓冲：显示时刻平滑（发送时刻 + 固定网络 + 目标缓冲），每帧实际
      // "在缓冲里待了多久"随它自己的到达抖动反向变化——统计量里累加的是这个
      const targetBufMs = 80 + (320 * i) / frames
      const decMs = 5
      const displayAt = sendAt + 50 + targetBufMs + decMs
      tl.push(arrival, i)
      jb += (displayAt - decMs - arrival) / 1000
      emitted += 1
      decT += decMs / 1000
      displays.push({ at: displayAt, idx: i })
      if (arrival >= nextSample) {
        est.sample({ jitterBufferDelay: jb, jitterBufferEmittedCount: emitted, totalDecodeTime: decT, framesDecoded: emitted })
        nextSample += 1000
      }
      // 显示在到达之后：处理所有已到显示时刻的帧
      while (displays.length && displays[0]!.at <= arrival) {
        const d = displays.shift()!
        const D = est.current
        if (D === null) continue
        const got = tl.pickPast(d.at - D, 300, () => true)?.value ?? null
        if (got === null) continue
        perMinute[Math.min(9, Math.floor(d.idx / (60 * FPS)))]!.push(Math.abs(got - d.idx))
      }
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
    for (const m of perMinute) {
      expect(m.length).toBeGreaterThan(1000)
      expect(median(m)).toBeLessThanOrEqual(1)
      expect(Math.max(...m)).toBeLessThanOrEqual(2)
    }
    expect(median(perMinute[9]!)).toBeLessThanOrEqual(median(perMinute[0]!))
  })
})
