import type { DownstreamProtocol } from '@/types/channel'

/** 网页可播协议（rtmp/srt 仅生成地址，不参与网页播放） */
export type PlayProtocol = 'flv' | 'hls' | 'webrtc'

export type PlayerStatus = 'idle' | 'connecting' | 'playing' | 'failed'

export interface PlayerMachineState {
  status: PlayerStatus
  /** 完整降级链（首个为用户主协议） */
  chain: PlayProtocol[]
  /** 当前尝试的链下标 */
  index: number
  lastError?: string
  /**
   * 建连代次：仅在"需要发起一次新连接尝试"的转移上 +1（协议推进/同协议重连/手动切换）。
   * onSuccess 不递增。UI 层用它做 effect 依赖，避免播放成功（connecting→playing）
   * 被误判为"需要重新建连"而把刚建好的播放器销毁又不重建（闪一下就黑屏）。
   */
  generation: number
}

/** 非网页协议过滤 + 稳定排序：flv → hls → webrtc
 * webrtc 放末尾是因为 ICE 协商慢，自动降级时放在最后不会拖住 flv→hls 的快速降级路径；
 * 用户仍可通过协议切换下拉手动切到 webrtc。 */
const WEB_ORDER: PlayProtocol[] = ['flv', 'hls', 'webrtc']

/**
 * 构建降级链：所有支持的网页协议（flv / hls / webrtc）都在链里，
 * 用户主协议放首位，其余按 WEB_ORDER 顺序排列。
 *
 * 防御：primary 不在 enabled 时，从 enabled 中按优先级选第一个网页协议作为起点。
 */
export function buildFallbackChain(
  primary: DownstreamProtocol,
  enabled: DownstreamProtocol[],
): PlayProtocol[] {
  const web = enabled.filter((p): p is PlayProtocol =>
    p === 'flv' || p === 'hls' || p === 'webrtc',
  )
  const uniq = [...new Set(web)].sort(
    (a, b) => WEB_ORDER.indexOf(a) - WEB_ORDER.indexOf(b),
  )

  if (uniq.length === 0) return []

  // 主协议在可用列表里 → 挪到首位
  if (uniq.includes(primary as PlayProtocol)) {
    return [primary as PlayProtocol, ...uniq.filter((p) => p !== primary)]
  }

  // primary 不是网页协议或未启用 → 从可用列表选第一个
  return uniq
}

/** 创建状态机（起点 connecting 链首协议） */
export function createMachine(chain: PlayProtocol[]): PlayerMachineState {
  return {
    status: chain.length > 0 ? 'connecting' : 'failed',
    chain,
    index: 0,
    lastError: chain.length === 0 ? '没有可用的网页播放协议' : undefined,
    generation: 0,
  }
}

/** 当前已选择/正在播放的协议；无有效链时返回 null。 */
export function currentProtocol(s: PlayerMachineState): PlayProtocol | null {
  if (s.status === 'failed') return null
  return s.chain[s.index] ?? null
}

/** 播放成功 */
export function onSuccess(s: PlayerMachineState): PlayerMachineState {
  if (s.status !== 'connecting') return s
  return { ...s, status: 'playing' }
}

/**
 * 播放失败：
 * - connecting 阶段：推进到下一协议，链尽则 failed
 * - playing 阶段：回到 connecting 重试当前协议（用于直播流断流后自动重连）
 */
export function onFail(s: PlayerMachineState, reason?: string): PlayerMachineState {
  if (s.status === 'playing') {
    // 播放中出错：重试当前协议（同协议重连，需要新建连接 → generation +1）
    return { ...s, status: 'connecting', lastError: reason, generation: s.generation + 1 }
  }
  if (s.status !== 'connecting') return s
  const nextIndex = s.index + 1
  if (nextIndex >= s.chain.length) {
    return { ...s, status: 'failed', lastError: reason ?? s.lastError }
  }
  return { ...s, index: nextIndex, lastError: reason, generation: s.generation + 1 }
}

/** 用户手动切换到链内指定协议（从头开始尝试） */
export function switchTo(s: PlayerMachineState, p: PlayProtocol): PlayerMachineState {
  const idx = s.chain.indexOf(p)
  if (idx < 0) return s
  return { ...s, status: 'connecting', index: idx, lastError: undefined, generation: s.generation + 1 }
}

/** 是否显示"无视频信号"：失败原因是网络类（推流端大概率未推流） */
export function isNoSignalHint(reason?: string): boolean {
  if (!reason) return false
  return /network|404|断开|无流/i.test(reason)
}
