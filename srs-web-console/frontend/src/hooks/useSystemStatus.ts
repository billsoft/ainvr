import { useState, useEffect, useRef } from 'react'
import { systemService } from '@/api/systemService'

export interface SummaryData {
  srsOnline: boolean
  srsVersion: string
  srsVersionLive?: boolean
  srsRtcHevc?: boolean
  serverTime: number
  streams: {
    total: number
    online: number
    totalClients: number
    totalBitrateKbps: number
  }
  channels: {
    total: number
    online: number
    offline: number
  }
}

/**
 * 系统状态轮询 hook
 * - 按 intervalMs 间隔轮询
 * - 失败时指数退避（interval → 2x → 4x → 最大 maxInterval）
 * - 成功后恢复正常间隔
 */
export function useSystemStatus(intervalMs = 5000, maxIntervalMs = 30000) {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const currentIntervalRef = useRef(intervalMs)
  const retryCountRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function fetchData() {
      if (cancelled) return
      try {
        const result = await systemService.getSummary()
        if (cancelled) return
        setData(result)
        setError(null)
        setLoading(false)
        retryCountRef.current = 0
        currentIntervalRef.current = intervalMs
      } catch (e: any) {
        if (cancelled) return
        setError(e.message || '获取状态失败')
        setLoading(false)
        // 指数退避
        retryCountRef.current += 1
        // ⚠️ intervalMs 现在可能来自用户设置（最大 60000ms），一旦大于 maxIntervalMs，
        // maxIntervalMs/intervalMs < 1 会让退避倍数反而 <1——变成「失败后轮询更快」，
        // 和退避的本意相反。下限钳到 1，保证退避倍数至少是 1x（不加速）。
        const factor = Math.max(1, Math.min(Math.pow(2, retryCountRef.current - 1), maxIntervalMs / intervalMs))
        currentIntervalRef.current = intervalMs * factor
      }
    }

    async function tick() {
      await fetchData()
      if (!cancelled) {
        timer = setTimeout(tick, currentIntervalRef.current)
      }
    }

    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs, maxIntervalMs])

  return { data, loading, error }
}
