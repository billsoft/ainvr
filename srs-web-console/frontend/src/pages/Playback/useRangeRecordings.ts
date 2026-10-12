import { useEffect, useState, useRef, useCallback } from 'react'
import { recordingService } from '@/api/recordingService'
import type { RecordingDrop, RecordingSegment } from '@/types/recording'
import { segmentsInRange } from '@/utils/recording'

async function loadDrops(channel: string, from: number, to: number, signal: AbortSignal): Promise<RecordingDrop[]> {
  // 丢弃区间只是时间轴标注：取不到不影响录像列表与播放
  try { return await recordingService.listDrops(channel, from, to, signal) } catch { return [] }
}

/** One range query supplies both list and timeline. Old responses cannot cross scopes. */
export function useRangeRecordings(channel: string | undefined, from: number, to: number) {
  const scope = `${channel}:${from}:${to}`
  const [data, setData] = useState<{ scope: string; segments: RecordingSegment[]; drops: RecordingDrop[] }>({ scope: '', segments: [], drops: [] })
  const [status, setStatus] = useState({ scope: '', loading: true, error: '' })
  const refresh = useRef(() => {})
  useEffect(() => {
    let disposed = false, inFlight = false
    const controller = new AbortController()
    async function load() {
      if (!channel || inFlight || disposed) return
      inFlight = true
      try {
        const [rows, drops] = await Promise.all([
          recordingService.listSegments(channel, from, to, controller.signal),
          loadDrops(channel, from, to, controller.signal),
        ])
        if (disposed) return
        const unique = [...new Map(rows.map(row => [row.id, row])).values()]
        setData({ scope, segments: segmentsInRange(unique, from, to), drops })
        setStatus({ scope, loading: false, error: '' })
      } catch (error) {
        if (!disposed) setStatus({ scope, loading: false, error: error instanceof Error ? error.message : '加载录像失败' })
      } finally { inFlight = false }
    }
    setStatus({ scope, loading: true, error: '' })
    refresh.current = () => { void load() }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 5000)
    const focus = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [channel, from, to, scope])
  const remove = useCallback((id: string) => setData(prev => ({ ...prev, segments: prev.segments.filter(row => row.id !== id) })), [])
  return { segments: data.scope === scope ? data.segments : [], drops: data.scope === scope ? data.drops : [],
    loading: status.scope !== scope || status.loading,
    error: status.scope === scope ? status.error : '', remove, refresh: () => refresh.current() }
}
