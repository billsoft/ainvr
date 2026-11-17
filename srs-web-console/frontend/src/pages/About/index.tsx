import { useEffect } from 'react'
import { Building2, Film, Package, Phone, Radio, UserRound, Video } from 'lucide-react'
import { copyrightYears, displayVersion, useBranding } from '@/store/branding'
import { useSystemStatus } from '@/hooks/useSystemStatus'
import { useSettingsStore } from '@/store/settings'
import { describeLocalSupport, describeSrs } from '@/utils/capabilityText'
import { getCodecSupport } from '@/utils/codec'

/** 关于：产品名片（名称、版本、版权）+ 运行信息 + 技术支持。品牌文字全部来自部署目录的 branding.yaml，留空的项不显示。 */
export default function AboutPage() {
  const { settings, fetchSettings } = useSettingsStore()
  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])
  const { data, error } = useSystemStatus(settings?.pollIntervalMs ?? 5000)
  const b = useBranding()
  const copyright = b?.copyrightHolder ? `© ${copyrightYears(b)} ${b.copyrightHolder}` : ''
  const srsState = error ? '状态更新失败' : !data ? '检测中' : data.srsOnline ? '运行中' : '连接不可用'
  const srsTone = !data || error ? 'bg-surface-page text-ink-subtle' : data.srsOnline ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'
  const hasSupport = !!b && !!(b.copyrightHolder || b.contactName || b.contactPhone)

  return (
    <section aria-labelledby="about-title" className="mx-auto max-w-5xl space-y-5">
      {/* 产品名片 */}
      <div className="ui-panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-5 bg-gradient-to-r from-primary-50 to-surface p-6 sm:p-8">
          <div className="rounded-panel bg-primary p-4 text-white shadow-sm"><Video size={34} aria-hidden /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium tracking-wide text-ink-faint">关于</p>
            <h1 id="about-title" className="mt-1 text-2xl font-semibold leading-8 text-ink">{b?.productName}</h1>
            {b?.subtitle && <p className="text-sm text-ink-subtle">{b.subtitle}</p>}
            {b?.tagline && <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-subtle">{b.tagline}</p>}
          </div>
          <div className="rounded-panel border border-line bg-surface px-5 py-3 text-center">
            <p className="flex items-center justify-center gap-1.5 text-xs text-ink-subtle"><Package size={14} aria-hidden />产品版本</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{b && displayVersion(b)}</p>
          </div>
        </div>
      </div>

      {/* 运行信息 */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="ui-panel p-5 sm:p-6" aria-labelledby="runtime-title">
          <h2 id="runtime-title" className="flex items-center gap-2 text-base font-semibold"><Radio size={18} aria-hidden />流媒体服务</h2>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums text-ink">{data?.srsVersion ? `v${data.srsVersion}` : '—'}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs ${srsTone}`}>{srsState}</span>
          </div>
          <p className="mt-3 text-xs text-ink-faint">版本与状态按设置里的刷新间隔更新。</p>
        </section>

        <section className="ui-panel p-5 sm:p-6" aria-labelledby="codec-title" data-testid="about-codec">
          <h2 id="codec-title" className="flex items-center gap-2 text-base font-semibold"><Film size={18} aria-hidden />H.265 播放能力</h2>
          <p className="mt-3 text-sm text-ink-subtle">{data ? describeSrs(data) : '服务端：检测中…'}</p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {describeLocalSupport(getCodecSupport()).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-ink-faint">本机 · {k}</dt><dd className="mt-1">{v}</dd></div>
            ))}
          </dl>
        </section>
      </div>

      {/* 版权与技术支持 */}
      {hasSupport && (
        <section className="ui-panel p-5 sm:p-6" aria-labelledby="support-title">
          <h2 id="support-title" className="text-base font-semibold">版权与技术支持</h2>
          <dl className="mt-4 grid gap-5 text-sm sm:grid-cols-3">
            {b.copyrightHolder && (
              <div><dt className="flex items-center gap-2 text-ink-subtle"><Building2 size={16} aria-hidden />版权所有</dt><dd className="mt-1.5 font-medium">{b.copyrightHolder}</dd></div>
            )}
            {b.contactName && (
              <div><dt className="flex items-center gap-2 text-ink-subtle"><UserRound size={16} aria-hidden />联系人</dt><dd className="mt-1.5 font-medium">{b.contactName}</dd></div>
            )}
            {b.contactPhone && (
              <div><dt className="flex items-center gap-2 text-ink-subtle"><Phone size={16} aria-hidden />联系电话</dt><dd className="mt-1.5"><a className="font-medium text-primary-600 hover:underline" href={`tel:${b.contactPhone}`}>{b.contactPhone}</a></dd></div>
            )}
          </dl>
        </section>
      )}

      {copyright && <p className="text-center text-xs text-ink-subtle">{copyright} · 版权所有 · All Rights Reserved</p>}
    </section>
  )
}
