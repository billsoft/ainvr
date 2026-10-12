import { describe, expect, it } from 'vitest'
import {
  extractWebrtcJitterBufferRaw, extractWebrtcVideoStats, WebrtcWatchdog,
  windowedJitterBufferDelayS,
} from '@/components/player/webrtc'

/** 造一个最小的 RTCStatsReport 假货——真实类型是 Map-like（有 .values()），
 * 测试只需要这一个方法，不用实现整个 RTCStatsReport 接口。 */
function fakeReport(entries: Record<string, unknown>[]): RTCStatsReport {
  return { values: () => entries.values() } as unknown as RTCStatsReport
}

describe('extractWebrtcVideoStats', () => {
  it('没有 inbound-rtp/video 条目时全部返回 null', () => {
    const stats = extractWebrtcVideoStats(fakeReport([
      { type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 1, jitterBufferEmittedCount: 1 },
      { type: 'outbound-rtp', kind: 'video' },
    ]))
    expect(stats).toEqual({
      jitterBufferDelayS: null, framesDecoded: null, freezeCount: null, pauseCount: null,
    })
  })

  it('报表为空时全部返回 null', () => {
    expect(extractWebrtcVideoStats(fakeReport([]))).toEqual({
      jitterBufferDelayS: null, framesDecoded: null, freezeCount: null, pauseCount: null,
    })
  })

  it('正常提取 jitterBufferDelay/emittedCount 算出均值延迟（秒）', () => {
    const stats = extractWebrtcVideoStats(fakeReport([
      {
        type: 'inbound-rtp', kind: 'video',
        jitterBufferDelay: 3.6, jitterBufferEmittedCount: 120,
        framesDecoded: 900, freezeCount: 2, pauseCount: 1,
      },
    ]))
    expect(stats.jitterBufferDelayS).toBeCloseTo(0.03, 5)
    expect(stats.framesDecoded).toBe(900)
    expect(stats.freezeCount).toBe(2)
    expect(stats.pauseCount).toBe(1)
  })

  it('emittedCount 为 0（还没出过帧）时延迟是 null，不是 0——避免误报"零延迟"', () => {
    const stats = extractWebrtcVideoStats(fakeReport([
      { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 0, jitterBufferEmittedCount: 0 },
    ]))
    expect(stats.jitterBufferDelayS).toBeNull()
  })

  it('字段类型不对（比如浏览器没提供）时对应字段返回 null 而不是抛错', () => {
    const stats = extractWebrtcVideoStats(fakeReport([
      { type: 'inbound-rtp', kind: 'video' },
    ]))
    expect(stats).toEqual({
      jitterBufferDelayS: null, framesDecoded: null, freezeCount: null, pauseCount: null,
    })
  })

  it('多条目时只挑第一条 inbound-rtp/video，忽略其它类型', () => {
    const stats = extractWebrtcVideoStats(fakeReport([
      { type: 'candidate-pair' },
      { type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 99, jitterBufferEmittedCount: 1 },
      { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 1, jitterBufferEmittedCount: 10 },
    ]))
    expect(stats.jitterBufferDelayS).toBeCloseTo(0.1, 5)
  })
})

describe('extractWebrtcJitterBufferRaw', () => {
  it('提取原始累计计数器（不做除法）', () => {
    const raw = extractWebrtcJitterBufferRaw(fakeReport([
      { type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 3.6, jitterBufferEmittedCount: 120 },
    ]))
    expect(raw).toEqual({ jitterBufferDelay: 3.6, jitterBufferEmittedCount: 120 })
  })

  it('没有 inbound-rtp/video 条目时返回全 null', () => {
    expect(extractWebrtcJitterBufferRaw(fakeReport([]))).toEqual({
      jitterBufferDelay: null, jitterBufferEmittedCount: null,
    })
  })
})

describe('windowedJitterBufferDelayS', () => {
  it('用两次采样之间的增量算出这一窗口的平均延迟，不是全程累计平均', () => {
    // 开播时（累计基线）延迟很小；负载升高后的这一小段窗口延迟明显变大——
    // 如果直接拿累计值相除，会被开播以来的历史低延迟稀释、反应迟钝，见
    // channel.py inference_fps_actual 头注同款教训。
    const prev = { jitterBufferDelay: 3.0, jitterBufferEmittedCount: 300 } // 全程均值 10ms
    const curr = { jitterBufferDelay: 3.0 + 6.0, jitterBufferEmittedCount: 300 + 60 } // 这一窗口新增 60 帧、6s 延迟
    // 窗口内均值 = 6.0s / 60 帧 = 100ms，远高于全程均值 10ms，说明负载确实升高了
    expect(windowedJitterBufferDelayS(prev, curr)).toBeCloseTo(0.1, 5)
  })

  it('窗口内没有新帧（emittedCount 没变）→ 返回 null，不产出除零/NaN', () => {
    const prev = { jitterBufferDelay: 3.0, jitterBufferEmittedCount: 300 }
    const curr = { jitterBufferDelay: 3.0, jitterBufferEmittedCount: 300 }
    expect(windowedJitterBufferDelayS(prev, curr)).toBeNull()
  })

  it('任意一次采样缺字段（null）→ 返回 null，不假装算出一个数', () => {
    const prev = { jitterBufferDelay: null, jitterBufferEmittedCount: null }
    const curr = { jitterBufferDelay: 3.6, jitterBufferEmittedCount: 120 }
    expect(windowedJitterBufferDelayS(prev, curr)).toBeNull()
  })

  it('连接刚重建（curr 计数器比 prev 还小，累计计数器归零重来）→ 返回 null，不产出负延迟', () => {
    const prev = { jitterBufferDelay: 5.0, jitterBufferEmittedCount: 500 }
    const curr = { jitterBufferDelay: 0.1, jitterBufferEmittedCount: 10 }
    expect(windowedJitterBufferDelayS(prev, curr)).toBeNull()
  })
})

/** 造一个"本窗口平均延迟 = delayS 秒、新增 frames 帧"的累计采样对 */
function jitterRaw(prevDelay: number, prevEmitted: number, delayS: number, frames: number) {
  return {
    prev: { jitterBufferDelay: prevDelay, jitterBufferEmittedCount: prevEmitted },
    curr: { jitterBufferDelay: prevDelay + delayS * frames, jitterBufferEmittedCount: prevEmitted + frames },
  }
}

describe('WebrtcWatchdog', () => {
  const opts = { startGraceMs: 20_000, latencyThresholdS: 5, latencyConfirmPolls: 3, freezeThresholdMs: 8_000 }

  it('宽限期内：即使窗口延迟远超阈值也不判定', () => {
    const w = new WebrtcWatchdog(opts)
    let raw = jitterRaw(0, 0, 0.01, 60)
    w.sample(0, raw.curr, 60)
    for (let t = 2000; t <= 18_000; t += 2000) {
      raw = jitterRaw(raw.curr.jitterBufferDelay, raw.curr.jitterBufferEmittedCount, 8, 60)
      expect(w.sample(t, raw.curr, 60 + t / 33)).toBe('ok')
    }
  })

  it('宽限期后：延迟连续 3 个轮询超阈值才判 latency，单次尖峰不误报', () => {
    const w = new WebrtcWatchdog(opts)
    let delay = 0
    let emitted = 0
    const feed = (t: number, windowS: number) => {
      const raw = jitterRaw(delay, emitted, windowS, 60)
      delay = raw.curr.jitterBufferDelay
      emitted = raw.curr.jitterBufferEmittedCount
      return w.sample(t, raw.curr, 30 * (t / 1000))
    }
    feed(0, 0.01)
    feed(20_000, 0.01) // 刚出宽限，基线
    expect(feed(22_000, 8)).toBe('ok')
    expect(feed(24_000, 0.02)).toBe('ok') // 尖峰后回落，确认计数清零
    expect(feed(26_000, 8)).toBe('ok')
    expect(feed(28_000, 8)).toBe('ok')
    expect(feed(30_000, 8)).toBe('latency') // 连续第 3 次
  })

  it('宽限期后：framesDecoded 超过 freezeThresholdMs 不增长判 freeze', () => {
    const w = new WebrtcWatchdog(opts)
    const raw = jitterRaw(0, 0, 0.01, 60)
    w.sample(0, raw.curr, 60)
    w.sample(18_000, raw.curr, 600) // 宽限内帧在推进，progress=18s
    w.sample(20_000, raw.curr, 600) // 出宽限，刚停 2s
    expect(w.sample(24_000, raw.curr, 600)).toBe('ok') // 累计停 6s，未到阈值
    expect(w.sample(26_000, raw.curr, 600)).toBe('freeze') // 累计停满 8s
  })

  it('framesDecoded 为 null 时不判冻屏（统计尚未就绪）', () => {
    const w = new WebrtcWatchdog(opts)
    const raw = jitterRaw(0, 0, 0.01, 60)
    w.sample(0, raw.curr, null)
    w.sample(20_000, raw.curr, null)
    expect(w.sample(40_000, raw.curr, null)).toBe('ok')
  })

  it('PC 重建导致 framesDecoded 计数器归零时按新基线处理，不误判 freeze', () => {
    const w = new WebrtcWatchdog(opts)
    const raw = jitterRaw(0, 0, 0.01, 60)
    w.sample(0, raw.curr, 900)
    w.sample(18_000, raw.curr, 1400) // 宽限内仍在推进
    // 新会话计数器从 10 重新开始（< 1400）→ 新基线
    expect(w.sample(22_000, raw.curr, 10)).toBe('ok')
    expect(w.sample(31_000, raw.curr, 10)).toBe('freeze') // 之后真停滞仍能判出
  })

  it('reset() 后宽限与确认计数全部重来', () => {
    const w = new WebrtcWatchdog(opts)
    let raw = jitterRaw(0, 0, 0.01, 60)
    w.sample(0, raw.curr, 0)
    raw = jitterRaw(raw.curr.jitterBufferDelay, raw.curr.jitterBufferEmittedCount, 8, 60)
    w.reset()
    // 重置后立刻喂高延迟样本：重新进入宽限，不判
    expect(w.sample(0, raw.curr, 60)).toBe('ok')
  })
})
