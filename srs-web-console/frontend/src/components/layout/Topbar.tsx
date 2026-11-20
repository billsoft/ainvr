import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { observabilityService, type StreamHealth, type Summary } from '@/api/observabilityService'
import { useBranding } from '@/store/branding'
import { Activity, Video } from 'lucide-react'
import { AlarmPendingIndicator } from './AlarmPendingIndicator'
import { RemoteAssistIndicator } from './RemoteAssistIndicator'

interface TopbarProps {
  children?: React.ReactNode
}

/**
 * 顶栏：左侧产品名 + 可选 slot（汉堡菜单等），右侧核心服务聚合状态。
 */
export function Topbar({ children }: TopbarProps) {
  const branding = useBranding()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [failed, setFailed] = useState(false)
  const [streams, setStreams] = useState<StreamHealth | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!document.hidden) {
        try { const data = await observabilityService.summary(); if (!cancelled) { setSummary(data); setFailed(false) } }
        catch { if (!cancelled) setFailed(true) }
        try { const data = await observabilityService.streamHealth(); if (!cancelled) setStreams(data) }
        catch { if (!cancelled) setStreams(null) }
      }
      if (!cancelled) timer = setTimeout(poll, 10000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])
  const snapshot = summary?.snapshot
  const services = snapshot?.services ?? []
  const unhealthy = services.filter(service => service.healthy === false)
  const unknown = !snapshot || !services.length || failed || Date.now() - snapshot.ts > 45000
  const healthy = services.filter(service => service.healthy).length
  // A channel that stopped producing pictures is a blind spot even when every service is "up".
  const interrupted = streams?.known ? streams.problems : []
  const minutes = (since: number) => { const m = Math.max(0, Math.round((Date.now() - since) / 60000)); return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分` }
  const label = unknown ? '系统状态未知' : unhealthy.length ? `${unhealthy.length} 项异常` : `${healthy}/${services.length} 服务正常`
  const interruptionDetail = interrupted.map(p => `${p.name}（${p.detail}，已 ${minutes(p.since)}）`).join('；')
  const detail = unknown ? '运行状态暂不可用，点击查看运行与日志中心' : unhealthy.length
    ? `需检查：${unhealthy.map(service => service.id).join('、')}`
    : '核心服务运行正常，点击查看详情'
  const bad = !unknown && unhealthy.length > 0

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        {children}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-base bg-primary text-white">
          <Video size={19} aria-hidden />
        </div>
        <div className="truncate text-sm font-semibold text-ink sm:text-base">{branding?.productName}</div>
        {branding?.subtitle && (
          <span className="hidden text-xs text-ink-faint xl:inline">
            {branding.subtitle}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center">
      <AlarmPendingIndicator />
      <RemoteAssistIndicator />
      <Link
        to="/dashboard"
        className={`ml-3 min-h-11 flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs ${
          bad ? 'bg-danger-50 text-danger-700' : unknown
            ? 'bg-surface-page text-ink-subtle'
            : 'bg-success-50 text-success-700'
        }`}
        data-testid="system-status"
        title={detail}
      >
        <Activity size={14} aria-hidden />
        <span>{label}</span>
      </Link>
      <Link to="/channels" title={interruptionDetail || '查看通道状态'} className={`ml-1 flex min-h-11 items-center rounded-full px-2 text-xs ${interrupted.length ? 'bg-danger-50 text-danger-700' : 'text-ink-subtle'}`}>通道 · <span>{interrupted.length ? `${interrupted.length} 路中断` : streams?.known ? '无中断' : '状态未知'}</span></Link>
      </div>
    </header>
  )
}
