import type { AiDetection, AiFrameResult } from '@/types/aiChannel'

export interface ContainLayout {
  /** 视频实际显示区域宽/高（CSS px），可能小于容器（宽高比不匹配时留白） */
  dispW: number
  dispH: number
  /** 显示区域相对容器左上角的偏移（CSS px） */
  offsetX: number
  offsetY: number
}

/**
 * `object-fit: contain` 的字母箱换算：给定视频固有分辨率和容器 CSS 尺寸，
 * 算出视频实际显示的子区域（宽高比不匹配时上下或左右会留白，不能假设
 * 视频铺满整个容器）。纯函数，不摸 DOM，方便单测锁定这段容易算错的几何。
 */
export function computeContainLayout(
  videoW: number, videoH: number, boxW: number, boxH: number,
): ContainLayout {
  if (videoW <= 0 || videoH <= 0 || boxW <= 0 || boxH <= 0) {
    return { dispW: 0, dispH: 0, offsetX: 0, offsetY: 0 }
  }
  const videoAspect = videoW / videoH
  const boxAspect = boxW / boxH
  if (videoAspect > boxAspect) {
    const dispW = boxW
    const dispH = boxW / videoAspect
    return { dispW, dispH, offsetX: 0, offsetY: (boxH - dispH) / 2 }
  }
  const dispH = boxH
  const dispW = boxH * videoAspect
  return { dispW, dispH, offsetX: (boxW - dispW) / 2, offsetY: 0 }
}

/**
 * 按 wall-clock（FrameResult.timestamp，Unix 秒）从历史结果里挑最接近
 * nowS 的一条。超过 staleMs 就当没有可用结果（返回 null）——直播场景下
 * video.currentTime 跟源端 PTS 没有统一的时间原点，wall-clock 才是浏览器
 * 和 Jetson 两边都能独立算出来的公共时钟（头注见 AiDetectionOverlay）。
 */
/**
 * 未来结果容差（毫秒）——nowS 估算本身有误差（时钟偏移校准 + 抖动缓冲
 * 修正都不是精确解），容差内的"略超前"结果接受；超过容差的大幅未来结果
 * 说明估算失真，画出来必然抢跑（框比人脸先到），跳过——宁缺毋滥。
 * 第一版可调参数：50ms 是设计估值，不是实测最优值；诊断端有符号 gap 可观测。
 */
export const FUTURE_TOLERANCE_MS = 50

export function pickClosestResult(
  history: AiFrameResult[], nowS: number, staleMs: number,
  futureToleranceMs: number = FUTURE_TOLERANCE_MS,
): AiFrameResult | null {
  let best: AiFrameResult | null = null
  let bestDeltaMs = Infinity
  for (const r of history) {
    const signedDeltaMs = (nowS - r.timestamp) * 1000
    // 大幅未来（nowS 比结果还早超过容差）不画：结果对应的人脸位置在
    // 当前画面时刻还没发生，视觉上就是抢跑
    if (signedDeltaMs < -futureToleranceMs) continue
    const deltaMs = Math.abs(signedDeltaMs)
    if (deltaMs < bestDeltaMs) {
      bestDeltaMs = deltaMs
      best = r
    }
  }
  if (!best || bestDeltaMs > staleMs) return null
  return best
}

/**
 * 历史结果里离 nowS 最近的一条差多远（ms）——不做 staleMs 门槛判断，
 * 单纯给"为什么没画框"这类诊断用（比如跟本机时钟对不上时，
 * pickClosestResult 会一直返回 null，光看那个结果分不清是"真的没有新结果"
 * 还是"时钟不同步"，这个函数把差值暴露出来给上层自己判断）。
 * 历史为空时返回 null。
 */
export function nearestResultGapMs(history: AiFrameResult[], nowS: number): number | null {
  let bestDeltaMs: number | null = null
  for (const r of history) {
    const deltaMs = Math.abs(nowS - r.timestamp) * 1000
    if (bestDeltaMs === null || deltaMs < bestDeltaMs) bestDeltaMs = deltaMs
  }
  return bestDeltaMs
}

/**
 * nearestResultGapMs 的有符号版本——正值=估算的"画面时刻"比结果新（结果
 * 滞后于画面），负值=结果在画面时刻之后（未来结果，会触发 pickClosestResult
 * 的单侧跳过）。诊断"框是超前还是滞后"必须有方向，绝对值只能回答"差多少"
 * 回答不了"往哪边差"。历史为空时返回 null（同 nearestResultGapMs）。
 */
export function signedNearestGapMs(history: AiFrameResult[], nowS: number): number | null {
  let bestDeltaMs: number | null = null
  for (const r of history) {
    const deltaMs = (nowS - r.timestamp) * 1000
    if (bestDeltaMs === null || Math.abs(deltaMs) < Math.abs(bestDeltaMs)) bestDeltaMs = deltaMs
  }
  return bestDeltaMs
}

/**
 * 校准"本机时钟 - Jetson 时钟"的偏移量（秒）——2026-09-09 生产环境实测
 * 复现：两台机器时钟没对齐时，pickClosestResult 会把明明刚产出的新结果
 * 误判成几十秒前的旧结果，永远画不出框，且没有任何报错，只会显示
 * "最近识别结果 33s 前"这类看起来像是通道卡住了的提示——实际是纯本地
 * 时钟问题，SEI/推理链路完全正常（该次复现里全链路 curl 到的最新结果只有
 * 0.4s 新鲜度）。
 *
 * 用法：每轮拉到新的历史结果后，只在 shouldRecalibrateClockOffset 判定为
 * "真的有新数据"时才重新估算一次偏移；画框时用 `Date.now()/1000 - offset`
 * 代替裸的 `Date.now()/1000` 去跟结果时间戳比较。不做加权平滑——通道正常
 * 运行时最新一条几乎总是"刚产出"（轮询间隔通常 <1s、推理间隔通常 <1s），
 * 每轮都用最新样本直接覆盖，偏移估计会跟着系统时钟被 NTP 校正之类的情况
 * 自动收敛，不会卡在一次性校准的旧值上。
 */
export function computeClockOffsetS(localReceiptS: number, latestResultTimestampS: number): number {
  return localReceiptS - latestResultTimestampS
}

/**
 * 判断这一轮该不该用 latestTs 重新校准时钟偏移——只有 latestTs 比上一次
 * 校准时用过的值更新，才说明这批数据里真的有新结果产出，能拿来校准。
 *
 * 这是对一个已经在生产环境上线过的真实 bug 的修复：最早的实现是"每轮拉到
 * 数据就无条件重新算一次偏移"，代码审查时发现这会跟 staleness 检测互相
 * 抵消——通道卡住/断流时，历史里最新一条的时间戳不再前进，但 offset 每轮
 * 还是拿这条不变的旧数据去对齐本机当前时刻，相当于把"卡住的时长"整个
 * 吸收进偏移量里；吸收之后 `Date.now()/1000 - offset` 又精确落回那条旧
 * 结果的时间戳上，deltaMs 算出来趋近于 0，pickClosestResult 反而判定为
 * "新鲜"，把几十秒前的旧框当成实时结果继续画，nearestResultGapMs 也会
 * 被同样吸收掉，导致本该触发的告警文字永远不出现——两层保护同时失效，
 * 且没有任何报错或异常，是最危险的一类静默失效。
 *
 * 修复后：只有 latestTs 真的前进了才更新偏移并记住这次的 latestTs；
 * 卡住期间偏移冻结在最后一次已知正确的值上，本机时钟持续走动，
 * `nowS - latestTs` 的差距会如实变大，两层保护照常生效；一旦数据恢复、
 * latestTs 重新前进，立刻重新校准，不需要额外处理。
 */
export function shouldRecalibrateClockOffset(
  latestTs: number, previousCalibratedTs: number | null,
): boolean {
  return previousCalibratedTs === null || latestTs > previousCalibratedTs
}

/**
 * 时钟偏移滑动窗口估计器——单样本校准的抖动治理。
 *
 * 单样本 computeClockOffsetS(localReceiptS, latestTs) 每轮都把轮询相位
 * （0 ~ pollMs）+ HTTP 延迟抖动直接吸进偏移量：latestTs 每前进一次，
 * offset 就可能跳几十毫秒，nowS 跟着跳，pickClosestResult 的匹配相位
 * 跟着跳——画面上就是框无故跳变（"时快时慢"的直接来源之一）。
 * 本类维护最近 N 个有效样本（只在 latestTs 真前进时收集，沿用
 * shouldRecalibrateClockOffset 的卡住冻结语义），取中位数作为偏移估计
 * ——中位数对轮询相位这类随机抖动鲁棒。
 *
 * ⚠️ 这不是无偏估计：样本 = 时钟差 + 传输延迟，中位数保留了传输延迟的
 * 中心偏置（一个稳定的常数）。要彻底消除需要服务端给出帧捕获时刻
 * （capture_timestamp，服务端 Phase 2）。稳定性优先，无偏其次。
 */
export class ClockOffsetEstimator {
  private samples: number[] = []
  private lastCalibratedTs: number | null = null
  // 显式字段声明：tsconfig 开了 erasableSyntaxOnly，构造函数参数属性
  // （constructor(private readonly x)）会生成运行时代码、不允许使用。
  private readonly windowSize: number

  constructor(windowSize: number = 8) {
    if (windowSize < 1) throw new Error('windowSize 必须 >= 1')
    this.windowSize = windowSize
  }

  /**
   * 拉到新历史结果后调用一次。latestTs 没有前进（通道卡住/断流）时不收
   * 样本，偏移估计冻结在最后已知值上（回归锁定：见
   * shouldRecalibrateClockOffset 头注的静默失效推导）。
   */
  update(localReceiptS: number, latestResultTs: number): void {
    if (!shouldRecalibrateClockOffset(latestResultTs, this.lastCalibratedTs)) return
    this.lastCalibratedTs = latestResultTs
    this.samples.push(localReceiptS - latestResultTs)
    if (this.samples.length > this.windowSize) {
      this.samples.shift()
    }
  }

  /**
   * 会话重置——WebRTC 重连/协议切换后旧会话的样本与 lastCalibratedTs
   * 必须清空：断流恢复正是"时快时慢"的发生场景，把旧会话的传输延迟样本
   * 和冻结的时间基准带进新会话，恢复后的前几轮仍用旧估计，反而延长错位。
   * 调用方以播放器会话重建（VideoPlayer state.generation）为信号触发。
   */
  reset(): void {
    this.samples = []
    this.lastCalibratedTs = null
  }

  /** 当前偏移估计（秒）。无样本时返回 0——等价于改造前"还没拉到数据时假设时钟同步"的行为。 */
  offsetS(): number {
    if (this.samples.length === 0) return 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    // noUncheckedIndexedAccess 下数组取值带 undefined；length>0 保证
    // 这些下标必然存在（奇数取 mid；偶数时 mid-1/mid 都在界内），
    // ?? 0 只是满足类型检查，运行时不会取到默认值。
    if (sorted.length % 2 !== 0) return sorted[mid] ?? 0
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  }
}

export interface ProjectedBox { x: number; y: number; w: number; h: number }

/**
 * 把一条 AiDetection 的 bbox（真实源分辨率坐标系，见 Phase 1 的两段式
 * 坐标还原）投影到 canvas 的 CSS 像素坐标系——先按 frame_width/height
 * 换算到 object-contain 字母箱内的显示子区域，再加上偏移。
 */
export function projectDetectionBox(
  d: Pick<AiDetection, 'bbox'>, layout: ContainLayout, frameW: number, frameH: number,
): ProjectedBox {
  const scaleX = layout.dispW / frameW
  const scaleY = layout.dispH / frameH
  return {
    x: layout.offsetX + d.bbox.x * scaleX,
    y: layout.offsetY + d.bbox.y * scaleY,
    w: d.bbox.w * scaleX,
    h: d.bbox.h * scaleY,
  }
}

export function projectLandmark(
  lm: { x: number; y: number }, layout: ContainLayout, frameW: number, frameH: number,
): { x: number; y: number } {
  return {
    x: layout.offsetX + lm.x * (layout.dispW / frameW),
    y: layout.offsetY + lm.y * (layout.dispH / frameH),
  }
}
