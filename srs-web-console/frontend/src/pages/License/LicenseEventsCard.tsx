import { ArrowRightLeft, CheckCircle2, History, KeyRound, Unplug, Wifi } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { LicenseEvent, LicenseStateName } from '@/types/license'
import { STATE_TEXT } from './licenseMessages'

const KIND_ICON: Record<LicenseEvent['kind'], LucideIcon> = {
  state: ArrowRightLeft,
  'activate-ok': KeyRound,
  'activate-failed': KeyRound,
  'service-lost': Unplug,
  'service-back': Wifi,
}

const KIND_CLASS: Record<LicenseEvent['kind'], string> = {
  state: 'bg-primary-50 text-primary',
  'activate-ok': 'bg-success-50 text-success-700',
  'activate-failed': 'bg-danger-50 text-danger-700',
  'service-lost': 'bg-warning-50 text-warning-700',
  'service-back': 'bg-success-50 text-success-700',
}

function describe(ev: LicenseEvent): string {
  switch (ev.kind) {
    case 'state':
      return `授权状态变为「${STATE_TEXT[ev.state as LicenseStateName]}」${ev.message ? `（${ev.message}）` : ''}`
    case 'activate-ok':
      return '注册码激活成功'
    case 'activate-failed':
      return `激活失败：${ev.message ?? '未知错误'}`
    case 'service-lost':
      return '与授权服务失去联系'
    case 'service-back':
      return '与授权服务恢复联系'
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function LicenseEventsCard({ events }: { events: LicenseEvent[] }) {
  return (
    <section className="ui-panel p-5 sm:p-6" aria-labelledby="license-events-title">
      <h2 id="license-events-title" className="flex items-center gap-2 text-base font-semibold">
        <History size={17} className="text-primary" aria-hidden />
        授权事件
      </h2>
      <p className="mt-2 text-xs text-ink-faint">仅保存在本机浏览器，最多保留最近 50 条，用于现场排查。</p>

      {events.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 rounded-panel border border-dashed border-line p-4 text-sm text-ink-faint">
          <CheckCircle2 size={15} aria-hidden />
          暂无授权事件。
        </div>
      ) : (
        <ol className="mt-4 space-y-1">
          {events.map((ev, i) => {
            const Icon = KIND_ICON[ev.kind]
            return (
              <li key={`${ev.at}-${i}`} className="flex items-start gap-3 rounded-base px-2 py-2 text-sm hover:bg-surface-page">
                <span className={`mt-0.5 rounded-full p-1.5 ${KIND_CLASS[ev.kind]}`}>
                  <Icon size={13} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 text-ink-subtle">{describe(ev)}</span>
                <time className="shrink-0 text-xs tabular-nums text-ink-faint" dateTime={new Date(ev.at).toISOString()}>
                  {formatTime(ev.at)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
