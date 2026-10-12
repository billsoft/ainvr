import { describe, expect, it } from 'vitest'
import {
  ClockOffsetEstimator, computeClockOffsetS, computeContainLayout,
  nearestResultGapMs, pickClosestResult, projectDetectionBox, projectLandmark,
  shouldRecalibrateClockOffset,
} from '@/components/player/overlayGeometry'
import type { AiFrameResult } from '@/types/aiChannel'

function makeResult(overrides: Partial<AiFrameResult> = {}): AiFrameResult {
  return {
    schema_version: '1.2',
    channel_id: 'cam01',
    stream_url: 'rtmp://x',
    stream_protocol: 'rtmp',
    timestamp: 1000,
    frame_pts_ns: 0,
    frame_index: 1,
    frame_width: 1920,
    frame_height: 960,
    model: { name: 'yolo26m', format: 'engine', provider: 'tensorrt', input_size: [640, 640], end2end: true, version: '1.0' },
    timing_ms: { decode: 0, preprocess: 0, inference: 0, postprocess: 0, total: 0 },
    task_type: 'object_detection',
    detections: [],
    model_extra: {},
    ...overrides,
  }
}

describe('computeContainLayout', () => {
  it('视频比容器"更宽"（宽高比更大）→ 上下留白', () => {
    // 视频 16:9，容器正方形 → 视频铺满宽度，高度不足，上下各留一截
    const layout = computeContainLayout(1920, 1080, 1000, 1000)
    expect(layout.dispW).toBe(1000)
    expect(layout.dispH).toBeCloseTo(562.5, 1)
    expect(layout.offsetX).toBe(0)
    expect(layout.offsetY).toBeCloseTo((1000 - 562.5) / 2, 1)
  })

  it('视频比容器"更窄"（宽高比更小）→ 左右留白', () => {
    // 视频 9:16（竖屏），容器 16:9 横向 → 视频铺满高度，宽度不足，左右留白
    const layout = computeContainLayout(1080, 1920, 1600, 900)
    expect(layout.dispH).toBe(900)
    expect(layout.dispW).toBeCloseTo(506.25, 1)
    expect(layout.offsetY).toBe(0)
    expect(layout.offsetX).toBeCloseTo((1600 - 506.25) / 2, 1)
  })

  it('宽高比完全一致 → 铺满容器，零偏移', () => {
    const layout = computeContainLayout(1920, 960, 640, 320)
    expect(layout.dispW).toBe(640)
    expect(layout.dispH).toBe(320)
    expect(layout.offsetX).toBe(0)
    expect(layout.offsetY).toBe(0)
  })

  it('任一维度为 0（视频还没就绪/容器还没布局）→ 全零，不产出 NaN/Infinity', () => {
    expect(computeContainLayout(0, 0, 640, 480)).toEqual({ dispW: 0, dispH: 0, offsetX: 0, offsetY: 0 })
    expect(computeContainLayout(1920, 1080, 0, 0)).toEqual({ dispW: 0, dispH: 0, offsetX: 0, offsetY: 0 })
  })
})

describe('pickClosestResult', () => {
  it('精确匹配当前时刻时选中它', () => {
    const results = [makeResult({ timestamp: 998 }), makeResult({ timestamp: 1000 }), makeResult({ timestamp: 995 })]
    const picked = pickClosestResult(results, 1000, 2000)
    expect(picked?.timestamp).toBe(1000)
  })

  it('没有精确匹配时选时间差最小的一条', () => {
    const results = [makeResult({ timestamp: 990 }), makeResult({ timestamp: 999.5 }), makeResult({ timestamp: 1010 })]
    const picked = pickClosestResult(results, 1000, 2000)
    expect(picked?.timestamp).toBe(999.5)
  })

  it('最接近的一条也超过 staleMs → 返回 null（画面上不该显示过期的框）', () => {
    const results = [makeResult({ timestamp: 990 })] // 差 10s
    expect(pickClosestResult(results, 1000, 2000)).toBeNull() // stale 阈值 2s
  })

  it('空历史 → 返回 null', () => {
    expect(pickClosestResult([], 1000, 2000)).toBeNull()
  })

  it('恰好等于 staleMs 边界时仍然接受（不是严格小于）', () => {
    const results = [makeResult({ timestamp: 998 })] // 差 2000ms 整
    expect(pickClosestResult(results, 1000, 2000)).not.toBeNull()
  })
})

describe('nearestResultGapMs', () => {
  it('不做 staleMs 门槛判断，只回报最近一条的时间差', () => {
    const results = [makeResult({ timestamp: 990 }), makeResult({ timestamp: 940 })]
    // 990 离 1000 差 10s，即使远超典型 staleMs 也如实回报，不返回 null
    expect(nearestResultGapMs(results, 1000)).toBeCloseTo(10000, 0)
  })

  it('空历史 → 返回 null（跟 pickClosestResult 的"没有可用结果"区分开：这里是"根本没数据"）', () => {
    expect(nearestResultGapMs([], 1000)).toBeNull()
  })

  it('多条结果里挑时间差最小的那个差值', () => {
    const results = [makeResult({ timestamp: 900 }), makeResult({ timestamp: 995 }), makeResult({ timestamp: 800 })]
    expect(nearestResultGapMs(results, 1000)).toBeCloseTo(5000, 0)
  })
})

describe('computeClockOffsetS', () => {
  it('本机时钟比结果时间戳快 → 正偏移；画框时用 now - offset 应能还原出接近服务端的"当下"', () => {
    // 本机收到这批结果时读到 1033（本机时钟），但这条结果本身盖的时间戳是
    // 1000（服务端时钟）——本机比服务端快了 33s，这正是 2026-09-09 生产环境
    // 实测复现的那种量级（"最近识别结果 33s 前"却全链路验证只有 0.4s 新鲜度）。
    const offset = computeClockOffsetS(1033, 1000)
    expect(offset).toBe(33)
    // 画框时：Date.now()/1000（本机此刻）- offset，应该约等于服务端此刻，
    // 而不是被误判成"33s 前"。
    const localNowS = 1033.4 // 本机时钟又往前走了 0.4s
    expect(localNowS - offset).toBeCloseTo(1000.4, 5)
  })

  it('本机时钟比结果时间戳慢 → 负偏移，同样能修正回来', () => {
    const offset = computeClockOffsetS(1000, 1020) // 本机收到时读 1000，结果戳着 1020（本机慢了 20s）
    expect(offset).toBe(-20)
    expect(1000.1 - offset).toBeCloseTo(1020.1, 5)
  })

  it('两边时钟本就同步 → 偏移接近 0', () => {
    expect(computeClockOffsetS(1000.05, 1000)).toBeCloseTo(0.05, 5)
  })
})

describe('shouldRecalibrateClockOffset', () => {
  it('第一次校准（previousCalibratedTs 为 null）→ 总是允许', () => {
    expect(shouldRecalibrateClockOffset(1000, null)).toBe(true)
  })

  it('latestTs 比上次校准用过的更新 → 允许（真的有新结果产出）', () => {
    expect(shouldRecalibrateClockOffset(1005, 1000)).toBe(true)
  })

  it('通道卡住/断流：latestTs 跟上次校准用过的一样 → 拒绝重新校准', () => {
    // 这是对生产环境真实 bug 的回归锁定：如果这里返回 true，偏移会被
    // 反复拿同一条旧数据重新对齐本机当前时刻，把停滞的时长悄悄吸收进
    // 偏移量里，staleness 检测和告警会同时失效（见 computeClockOffsetS
    // 头注和 shouldRecalibrateClockOffset 头注的完整推导）。
    expect(shouldRecalibrateClockOffset(1000, 1000)).toBe(false)
  })

  it('latestTs 比上次校准用过的更旧（不应发生，但防御性验证）→ 拒绝', () => {
    expect(shouldRecalibrateClockOffset(995, 1000)).toBe(false)
  })

  it('端到端场景：通道卡住期间偏移冻结，nowS 相对旧数据的差距如实变大', () => {
    // t=0：正常校准一次，本机与服务端同步
    let lastCalibratedTs: number | null = null
    let offset = 0
    const t0Latest = 1000
    if (shouldRecalibrateClockOffset(t0Latest, lastCalibratedTs)) {
      offset = computeClockOffsetS(1000, t0Latest) // 0
      lastCalibratedTs = t0Latest
    }
    expect(offset).toBe(0)

    // t=60s：通道卡住，历史里最新一条还是 1000（没有新结果产出），
    // 但本机时钟已经走到 1060
    const t60Latest = 1000
    if (shouldRecalibrateClockOffset(t60Latest, lastCalibratedTs)) {
      offset = computeClockOffsetS(1060, t60Latest) // 若允许校准会算出 60，掩盖卡住
    }
    // 偏移必须冻结在 0，不能被卡住的 60s 悄悄吸收掉
    expect(offset).toBe(0)

    // 用冻结的偏移换算出的 nowS，应如实反映跟最新结果差了 60s，
    // 而不是被错误地拉回到看起来"刚刚好"
    const nowS = 1060 - offset
    expect(nowS - t60Latest).toBeCloseTo(60, 5)
  })
})

describe('projectDetectionBox / projectLandmark', () => {
  it('无留白（layout 与源分辨率同比例）时，投影就是简单的等比缩放', () => {
    const layout = { dispW: 960, dispH: 480, offsetX: 0, offsetY: 0 } // 源 1920x960 缩小一半
    const box = projectDetectionBox({ bbox: { x: 100, y: 50, w: 200, h: 100 } }, layout, 1920, 960)
    expect(box).toEqual({ x: 50, y: 25, w: 100, h: 50 })
  })

  it('有留白时，偏移量要叠加到投影坐标上（不是只缩放不加偏移）', () => {
    // 字母箱：显示区域比容器窄，左右各留 100px
    const layout = { dispW: 800, dispH: 800, offsetX: 100, offsetY: 0 }
    const box = projectDetectionBox({ bbox: { x: 0, y: 0, w: 1920, h: 960 } }, layout, 1920, 960)
    // 整帧大小的框应该正好落在显示区域内：左上角在 offset 处，宽高等于 disp
    expect(box.x).toBe(100)
    expect(box.y).toBe(0)
    expect(box.w).toBe(800)
    expect(box.h).toBe(800)
  })

  it('关键点投影同一套换算', () => {
    const layout = { dispW: 960, dispH: 480, offsetX: 0, offsetY: 0 }
    const p = projectLandmark({ x: 960, y: 480 }, layout, 1920, 960)
    expect(p).toEqual({ x: 480, y: 240 })
  })
})

describe('ClockOffsetEstimator', () => {
  it('窗口内取中位数——离群的轮询相位/HTTP 延迟样本被抑制', () => {
    const est = new ClockOffsetEstimator()
    // 模拟轮询相位抖动：大多数样本稳定在 0.05 附近，偶发离群 0.35（HTTP 慢包）
    est.update(1000.05, 1000)
    est.update(1000.35, 1000.01)
    est.update(1000.06, 1000.01)
    est.update(1000.04, 1000)
    est.update(1000.05, 1000.02)
    // 样本：0.05, 0.34, 0.05, 0.04, 0.03 → 排序中位数 0.05（单样本法则下第 2 个 0.34
    // 会直接把偏移拉到 0.34，nowS 跟着跳 290ms，框匹配相位跟着跳）
    expect(est.offsetS()).toBeCloseTo(0.05, 5)
  })

  it('窗口滚动：超出 windowSize 的旧样本被淘汰', () => {
    const est = new ClockOffsetEstimator(2)
    est.update(1000, 999)
    est.update(1001, 1000)
    expect(est.offsetS()).toBeCloseTo(1, 5)
    // push 第 3 个 → 最老的样本被 shift
    est.update(1001.4, 1001)
    // 剩 [1.0, 0.4]
    expect(est.offsetS()).toBeCloseTo(0.7, 5)
  })

  it('latestTs 不前进时不收样本（卡住冻结，复用 shouldRecalibrateClockOffset 语义）', () => {
    const est = new ClockOffsetEstimator()
    est.update(1000.1, 1000)
    expect(est.offsetS()).toBeCloseTo(0.1, 5)
    // 通道卡住：latestTs 一直是 1000，本机时钟在走
    est.update(1030.1, 1000)
    // 必须被冻结——不吸收卡住时长（回归锁定：静默失效推导见原函数头注）
    expect(est.offsetS()).toBeCloseTo(0.1, 5)
  })

  it('reset 清空样本与时间基准，新会话样本从零重新积累', () => {
    const est = new ClockOffsetEstimator()
    est.update(1000.1, 1000)
    // 同一 latestTs 的第二次 update 被卡住冻结语义拦截——不收样本（回归确认）
    est.update(1000.2, 1000)
    expect(est.offsetS()).toBeCloseTo(0.1, 5)

    est.reset()
    expect(est.offsetS()).toBe(0)
    // reset 后时间基准也被清：新会话（哪怕 latestTs 与旧会话无关）能立即
    // 重新积累，不受旧会话冻结值/旧 lastCalibratedTs 污染
    est.update(2000.5, 2000)
    expect(est.offsetS()).toBeCloseTo(0.5, 5)
  })

  it('无样本时返回 0（等价改造前"未校准=假设同步"）', () => {
    expect(new ClockOffsetEstimator().offsetS()).toBe(0)
  })

  it('windowSize < 1 拒绝', () => {
    expect(() => new ClockOffsetEstimator(0)).toThrow()
  })
})

describe('pickClosestResult 单侧约束（2026-09-11）', () => {
  it('大幅未来结果（nowS 比它早超过容差）不被选中——宁缺毋滥', () => {
    const results = [makeResult({ timestamp: 1010 })] // 未来 10s
    expect(pickClosestResult(results, 1000, 2000)).toBeNull()
  })

  it('容差内的略超前结果仍可被选中（nowS 估算误差内）', () => {
    const results = [makeResult({ timestamp: 1000.04 })] // 40ms 未来
    const picked = pickClosestResult(results, 1000, 2000)
    expect(picked?.timestamp).toBe(1000.04)
  })

  it('未来与过去混合时仍按时间距离挑最近的（容差内未来更近则胜出）', () => {
    const results = [
      makeResult({ timestamp: 999 }), // 1s 过去
      makeResult({ timestamp: 1000.04 }), // 40ms 未来
    ]
    const picked = pickClosestResult(results, 1000, 500)
    expect(picked?.timestamp).toBe(1000.04)
  })

  it('全部结果都在容差外未来 → 返回 null（短暂无框好过画必然抢跑的框）', () => {
    const results = [makeResult({ timestamp: 1005 }), makeResult({ timestamp: 1003 })]
    expect(pickClosestResult(results, 1000, 2000)).toBeNull()
  })
})
