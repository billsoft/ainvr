import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock, X } from 'lucide-react'
import { systemTimeService, SYSTEM_TIME_CHANGED_EVENT, type SystemTimeStatus } from '@/api/systemTimeService'

const DISMISS_KEY = 'ainvr.systemTimeNotice.dismissed'
const POLL_MS = 300_000

/**
 * 全局时间提示：时间无效（早于 2026 年，录像与 AI 已暂停）红色常驻；开机后尚未对时、
 * 也没人工校准时黄色提示，可关闭（本次会话不再出现）。读取失败时不打扰用户。
 */
export function SystemTimeNotice() {
  const [status, setStatus] = useState<SystemTimeStatus | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const s = await systemTimeService.get()
        if (!cancelled) setStatus(s)
      } catch {
        if (!cancelled) setStatus(null)
      }
    }
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    const onChanged = () => void load()
    window.addEventListener(SYSTEM_TIME_CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      clearInterval(t)
      window.removeEventListener(SYSTEM_TIME_CHANGED_EVENT, onChanged)
    }
  }, [])

  if (!status) return null
  const link = <Link to="/config-center?category=time" className="ml-2 font-medium underline">校准时间</Link>
  if (!status.valid) {
    return (
      <div role="alert" className="mb-4 flex items-center gap-2 rounded-panel border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-800">
        <Clock size={16} aria-hidden className="shrink-0" />
        <span>设备时间无效（早于 2026 年，断电后时钟未校准），录像与 AI 已暂停。{link}</span>
      </div>
    )
  }
  if (status.ntp_synchronized || status.manually_set || dismissed) return null
  return (
    <div role="status" className="mb-4 flex items-center gap-2 rounded-panel border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <Clock size={16} aria-hidden className="shrink-0" />
      <span className="flex-1">设备开机后尚未对时（可能处于离线环境），时间可能不准确。{link}</span>
      <button type="button" aria-label="关闭提示" className="rounded-base p-1.5 hover:bg-amber-100"
        onClick={() => {
          setDismissed(true)
          try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* 隐私模式等：只在本页关闭 */ }
        }}>
        <X size={16} aria-hidden />
      </button>
    </div>
  )
}
