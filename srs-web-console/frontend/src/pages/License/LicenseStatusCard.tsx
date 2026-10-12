import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Cpu, Hash, Hourglass, CalendarClock, ShieldCheck, ShieldOff } from 'lucide-react'
import type { LicenseStatus } from '@/types/license'
import { MODE_TEXT, REASON_TEXT, STATE_BADGE_CLASS, STATE_DETAIL, STATE_TEXT } from './licenseMessages'

interface Props {
  status: LicenseStatus | null
  statusAt: number
  loading: boolean
  unreachable: boolean
}

/** 把剩余秒数格式化成「Nd HH:MM:SS」。 */
function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds))
  const days = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return days > 0 ? `${days}天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

function Row({ icon: Icon, label, children }: {
  icon: typeof Cpu
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="flex items-center gap-2 text-sm text-ink-subtle">
        <Icon size={15} aria-hidden />
        {label}
      </dt>
      <dd className="text-right text-sm font-medium tabular-nums text-ink">{children}</dd>
    </div>
  )
}

export function LicenseStatusCard({ status, statusAt, loading, unreachable }: Props) {
  // 以服务器剩余秒数和浏览器单调时间显示估算；实际许可由后端短租约裁决。
  const [now, setNow] = useState(() => performance.now())
  const valid = status?.state === 'valid'
  useEffect(() => {
    if (!valid || !status || status.remaining_minutes < 0) return
    const t = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(t)
  }, [valid, status])

  const remainingSeconds = status && Number.isFinite(statusAt) && status.remaining_minutes >= 0
    ? Math.max(0, (status.remaining_seconds ?? status.remaining_minutes * 60) - Math.max(0, (now - statusAt) / 1000))
    : null
  const expiresText = status && status.expires_min > 0
    ? new Date(status.expires_min * 60_000).toLocaleString('zh-CN', { hour12: false })
    : '无固定到期点'
  const reasonText = status?.reason ? (REASON_TEXT[status.reason] ?? status.reason) : ''

  return (
    <section className="ui-panel p-5 sm:p-6" aria-labelledby="license-status-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="license-status-title" className="text-base font-semibold">授权状态</h2>
        {status ? (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATE_BADGE_CLASS[status.state]}`}>
            {STATE_TEXT[status.state]}
          </span>
        ) : (
          <span className="rounded-full bg-surface-page px-3 py-1 text-xs text-ink-subtle">
            {loading ? '检测中…' : unreachable ? '授权服务不可用' : '未知'}
          </span>
        )}
      </div>

      {status && !unreachable && (
        <p className="mt-2 text-sm leading-6 text-ink-subtle">{STATE_DETAIL[status.state]}</p>
      )}
      {unreachable && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-warning-700">
          <AlertTriangle size={15} aria-hidden />
          暂时无法连接授权服务，下方为上次状态。业务只能运行到已有短租约到期；登录、授权管理和必要诊断保持可用。
        </p>
      )}

      {valid && !unreachable && remainingSeconds !== null && (
        <div className="mt-4 rounded-panel bg-primary-50 p-4" role="status">
          <div className="flex items-center gap-2 text-xs text-primary-600">
            <Hourglass size={14} aria-hidden />剩余授权时间
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-primary-700">
            {formatRemaining(remainingSeconds)}
          </div>
        </div>
      )}

      {status && (
        <dl className="mt-4 divide-y divide-line border-t border-line pt-1">
          <Row icon={Cpu} label="整机型号">{status.soc_model || '—'}</Row>
          <Row icon={CalendarClock} label="计时方式">{MODE_TEXT[status.mode]}</Row>
          <Row icon={CalendarClock} label="预计到期时间">{expiresText}</Row>
          <Row icon={Hash} label="状态序列号"><span className="font-mono">{status.seq}</span></Row>
          <Row
            icon={status.service_ok ? ShieldCheck : ShieldOff}
            label="授权服务"
          >
            <span className={status.service_ok ? 'text-success-700' : 'text-danger-700'}>
              {unreachable ? '连接中断' : status.service_ok ? '运行正常' : '异常'}
            </span>
          </Row>
        </dl>
      )}

      {status?.enforcer_tripped && (
        <p className="mt-4 flex items-start gap-2 rounded-panel bg-danger-50 p-3 text-sm text-danger-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          授权状态频繁翻转，强制执行器已熔断。请排除时钟/存储故障后联系供应商处理。
        </p>
      )}
      {status && status.state !== 'valid' && reasonText && (
        <p className="mt-3 text-xs leading-5 text-ink-faint">原因：{reasonText}</p>
      )}
    </section>
  )
}
