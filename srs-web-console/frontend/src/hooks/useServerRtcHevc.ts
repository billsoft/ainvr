import { useEffect, useState } from 'react'
import { systemService } from '@/api/systemService'

/**
 * 服务端能否把 RTMP 的 H.265 转成 WebRTC（SRS ≥ 7.0.33）——H.265 实时播放判定的服务端条件
 * （设计 §8.2）。后端 /summary 的 srsRtcHevc 按 SRS 实时版本算出；回滚到 SRS 6 后为 false。
 *
 * 三种结果必须区分：true/false 是服务端给出的结论；'unknown' 是这次没问到（后端或 SRS
 * 暂时不可达）——不能当成"不支持"永久记住，要自动重试。
 */
export type ServerRtcHevc = boolean | 'unknown'

const TTL_MS = 60_000
/** 查询失败后的重试间隔（逐次递增，最后一档一直沿用） */
const RETRY_MS = [3_000, 10_000, 30_000]

export function createServerRtcHevcLoader(
  fetcher: () => Promise<{ srsRtcHevc?: boolean; srsVersionLive?: boolean }>,
  now: () => number = Date.now,
): () => Promise<ServerRtcHevc> {
  let cached: { value: boolean; at: number } | null = null
  let inflight: Promise<ServerRtcHevc> | null = null
  return () => {
    if (cached && now() - cached.at < TTL_MS) return Promise.resolve(cached.value)
    if (inflight) return inflight
    inflight = fetcher()
      .then((d): ServerRtcHevc => {
        // BFF 可达不代表 SRS 可达：实时版本读取失败时，能力字段的 false
        // 只是保守占位，不能当成确认不支持或缓存 60 秒。
        if (d.srsVersionLive === false) return 'unknown'
        // 没有该字段 = 旧后端，服务端能力确认为"不支持"
        const value = d.srsRtcHevc === true
        cached = { value, at: now() }
        return value
      })
      // 失败不缓存：调用方按 unknown 处理并重试
      .catch((): ServerRtcHevc => 'unknown')
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

const load = createServerRtcHevcLoader(() => systemService.getSummary())

/**
 * 可注入 loader 的实现（单测用）。enabled=false（非 H.265）时不请求、返回 null；
 * 否则 null（首次取数中）→ true / false / 'unknown'。
 * - 'unknown'：按 3s/10s/30s… 退避重试，直到拿到结论；
 * - 拿到结论后每 60s 复查一次（服务端升级/回滚能跟上；值不变时 React 不会重渲染）。
 */
export function useServerRtcHevcWith(
  loader: () => Promise<ServerRtcHevc>,
  enabled: boolean,
): ServerRtcHevc | null {
  const [value, setValue] = useState<ServerRtcHevc | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const run = () => {
      void loader().then((v) => {
        if (cancelled) return
        setValue(v)
        if (v === 'unknown') {
          timer = setTimeout(run, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)])
          failures += 1
        } else {
          failures = 0
          timer = setTimeout(run, TTL_MS)
        }
      })
    }
    run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [enabled, loader])
  return enabled ? value : null
}

export function useServerRtcHevc(enabled: boolean): ServerRtcHevc | null {
  return useServerRtcHevcWith(load, enabled)
}
